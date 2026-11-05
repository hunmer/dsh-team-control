// AC-19：显式记忆空间（文件存储，不落库）
// 覆盖：一条一文件 / 原子写 / upsert+CAS / 列表只回元数据且字段叫 slot /
// private 仅 owner 与本队 Lead 可读 / shared 凭 id 跨队读 / 团队删除不级联删文件 / reindex。
import fs from 'node:fs';
import path from 'node:path';
import { runAc, mkTmp, startSidecar, assert, assertEqual, sseOpen } from './lib/harness.mjs';

await runAc('AC-19', async () => {
  const tmp = mkTmp('dsh-team-ac19');
  let s = null;
  let sse = null;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;

    const teamA = await api.post('/api/teams', { name: 'mem-a', workspace: tmp.ws, leadSessionId: 'sess-lead-a' });
    const alice = await api.post(`/api/teams/${teamA.id}/members`, { name: 'alice' });
    const bob = await api.post(`/api/teams/${teamA.id}/members`, { name: 'bob' });
    await api.post('/api/agents/register', { teamId: teamA.id, name: 'alice', sessionId: 'sess-alice' });
    await api.post('/api/agents/register', { teamId: teamA.id, name: 'bob', sessionId: 'sess-bob' });

    const teamB = await api.post('/api/teams', { name: 'mem-b', workspace: tmp.ws, leadSessionId: 'sess-lead-b' });
    await api.post('/api/agents/register', { teamId: teamB.id, name: 'carol', sessionId: 'sess-carol' });

    sse = sseOpen(s.url, s.token, { team: teamA.id });

    // 1) 团队空间写入（面板身份，无 session）→ 文件落盘
    const w1 = await api.post('/api/memory', {
      teamId: teamA.id, scope: 'team', key: 'handoff/api', value: '内部接口统一 snake_case',
      kind: 'decision', title: '接口风格', tags: ['api', 'convention'],
    });
    assertEqual(w1.created, true, '首次写入为 create');
    assertEqual(w1.memory.slot, 'handoff/api', '对外字段叫 slot，不被脱敏成 <redacted>');
    assertEqual(w1.memory.key, undefined, '对外视图不暴露 key 字段');
    assertEqual(w1.memory.version, 1, '首次写入 version=1');
    assertEqual(w1.memory.ownerMemberId, null, 'team 空间没有 owner');

    const file = path.join(tmp.dataDir, 'memory', 'objects', w1.memory.id + '.json');
    assert(fs.existsSync(file), '记忆落到 memory/objects/<id>.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertEqual(onDisk.key, 'handoff/api', '文件里仍叫 key（只有出口改名）');
    assertEqual(onDisk.value, '内部接口统一 snake_case', '文件里原文保存 value');
    assertEqual(onDisk.teamId, undefined, '文件里不写 teamId');
    assertEqual(onDisk.memberId, undefined, '文件里不写 memberId');
    assertEqual(onDisk.ownerMemberId, undefined, '文件里不写 ownerMemberId');
    assertEqual(onDisk.scope, undefined, '文件里不写 scope');
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
    assertEqual(leftovers.length, 0, '原子写不残留 .tmp');

    // 2) SSE 收到合成帧，且不带正文
    const frame = await sse.waitFor((f) => f.event === 'memory.updated', { label: 'memory.updated' });
    assertEqual(frame.payload.memoryId, w1.memory.id, 'SSE 带 memoryId');
    assertEqual(frame.payload.scope, 'team', 'SSE 带 scope');
    assert(frame.payload.value === undefined, 'SSE 不带记忆正文');

    // 3) 列表只回元数据
    const list = await api.get(`/api/memory?team=${teamA.id}&scope=team`);
    assertEqual(list.total, 1, '列表命中 1 条');
    assertEqual(list.items[0].slot, 'handoff/api', '列表字段为 slot');
    assertEqual(list.items[0].value, undefined, '列表不回正文');
    assert(typeof list.items[0].summary === 'string' && list.items[0].summary.length > 0, '列表带摘要');

    // 4) 同 key upsert + CAS
    const w2 = await api.post('/api/memory', {
      teamId: teamA.id, scope: 'team', key: 'handoff/api', value: '内部接口统一 snake_case（02 版）', expectedVersion: 1,
    });
    assertEqual(w2.created, false, '同空间同 key 为 upsert');
    assertEqual(w2.memory.id, w1.memory.id, 'upsert 复用同一 id');
    assertEqual(w2.memory.version, 2, 'upsert 后 version=2');
    let casErr = null;
    try {
      await api.patch(`/api/memory/${w1.memory.id}`, { value: 'stale', expectedVersion: 1 });
    } catch (err) { casErr = err; }
    assertEqual(casErr?.status, 409, 'expectedVersion 落后返回 409');
    let createErr = null;
    try {
      await api.post('/api/memory', { teamId: teamA.id, scope: 'team', key: 'handoff/api', value: 'x', expectedVersion: 0 });
    } catch (err) { createErr = err; }
    assertEqual(createErr?.status, 409, 'expectedVersion=0 但已存在返回 409');

    // 5) 成员私有空间：owner 可读写，其他成员 403，Lead 可读
    const pm = await api.post('/api/memory', {
      teamId: teamA.id, scope: 'member', key: 'notes/impl', value: '用 tmp+rename', sessionId: 'sess-alice',
    });
    assertEqual(pm.memory.ownerMemberId, alice.id, '成员空间 owner 是写入者');
    assertEqual(pm.memory.visibility, 'private', '成员空间默认 private');
    const own = await api.get(`/api/memory/${pm.memory.id}?team=${teamA.id}&session=sess-alice`);
    assertEqual(own.memory.value, '用 tmp+rename', 'owner 可读正文');
    let bobRead = null;
    try { await api.get(`/api/memory/${pm.memory.id}?team=${teamA.id}&session=sess-bob`); } catch (err) { bobRead = err; }
    assertEqual(bobRead?.status, 403, '其他成员读 private 被拒');
    const leadRead = await api.get(`/api/memory/${pm.memory.id}?team=${teamA.id}&session=sess-lead-a`);
    assertEqual(leadRead.memory.id, pm.memory.id, '本队 Lead 可读 private');
    let bobWrite = null;
    try {
      await api.post('/api/memory', {
        teamId: teamA.id, scope: 'member', memberId: alice.id, key: 'notes/hijack', value: 'x', sessionId: 'sess-bob',
      });
    } catch (err) { bobWrite = err; }
    assertEqual(bobWrite?.status, 403, '成员不能写别人的空间');

    // 6) shared 凭 id 跨队读
    const shared = await api.post(`/api/memory/${pm.memory.id}/share`, { visibility: 'shared', sessionId: 'sess-alice' });
    assertEqual(shared.memory.visibility, 'shared', '可见性改为 shared');
    const cross = await api.get(`/api/memory/${pm.memory.id}?team=${teamB.id}&session=sess-carol`);
    assertEqual(cross.memory.value, '用 tmp+rename', '其他团队成员凭 id 可读 shared');
    let crossPrivate = null;
    try { await api.get(`/api/memory/${w1.memory.id}?team=${teamB.id}&session=sess-carol`); } catch (err) { crossPrivate = err; }
    assertEqual(crossPrivate?.status, 403, 'team 可见性不能跨队读');

    // 7) 团队删除不级联删记忆文件
    await api.del(`/api/teams/${teamA.id}?confirm=1`);
    assert(fs.existsSync(file), '删除团队后记忆文件仍在');
    const afterDelete = await api.get(`/api/memory/${w1.memory.id}?team=${teamB.id}&session=sess-lead-b`);
    assert(afterDelete.memory, 'team 空间记忆仍可被 Lead 读取（teamId 仅来源）');

    // 7.1) 无归属（orphan）清理：reindex 报出来，prune 必须 confirm
    const re0 = await api.post('/api/memory/reindex');
    assert(re0.orphans.includes(w1.memory.id), 'reindex 报出无归属记忆');
    let noConfirm = null;
    try { await api.post('/api/memory/prune', { ids: [w1.memory.id] }); } catch (err) { noConfirm = err; }
    assertEqual(noConfirm?.status, 400, 'prune 必须 confirm=true');
    const pruned = await api.post('/api/memory/prune', { ids: [w1.memory.id], confirm: true });
    assertEqual(pruned.count, 1, '按 id 清理 1 条 orphan');
    assert(!fs.existsSync(file), '清理后记忆文件删除');

    // 8) 手改文件后 reindex
    const manual = {
      id: 'mem_manual_ac19', schema: 1,
      key: 'manual/entry', kind: 'fact', title: '手写记忆', value: 'hello', tags: [],
      visibility: 'team', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
    };
    fs.writeFileSync(path.join(tmp.dataDir, 'memory', 'objects', manual.id + '.json'), JSON.stringify(manual));
    const re = await api.post('/api/memory/reindex');
    assert(re.items >= 2, `reindex 重扫目录（当前 ${re.items} 条）`);
    const manualRead = await api.get(`/api/memory/${manual.id}?team=${teamB.id}&session=sess-lead-b`);
    assertEqual(manualRead.memory.slot, 'manual/entry', 'reindex 后可读到手写文件');
  } finally {
    try { sse?.close(); } catch { /* ignore */ }
    try { await s?.close(); } catch { /* ignore */ }
    try { tmp.cleanup(); } catch { /* ignore */ }
  }
});
