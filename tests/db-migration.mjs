// tests/db-migration.mjs — 老库（schema v1：team 无 permission_preset、member 无 agent_session_id）必须能被 openDb 就地补列，
// 而不是启动即 "no such column" 崩掉；旧数据保留，permission_preset 取默认 workspace-write，旧权限表被清掉。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkTmp } from './lib/harness.mjs';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';
import path from 'node:path';

const V1_DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE team (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 64, max_concurrency INTEGER NOT NULL DEFAULT 8,
  failure_policy TEXT NOT NULL DEFAULT 'continue', max_attempts INTEGER NOT NULL DEFAULT 3,
  auto_approve_json TEXT, auto_takeover INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE member (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT, model TEXT, context_mode TEXT,
  default_plan_json TEXT, quota_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(team_id, name)
);
CREATE INDEX idx_member_team ON member(team_id);
`;

const main = () => {
  const tmp = mkTmp('dsh-team-migrate');
  try {
    const file = path.join(tmp.dataDir, 'team.db');
    const old = new DatabaseSync(file);
    old.exec(V1_DDL);
    old.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('schema_version', '1');
    old.prepare('INSERT INTO team (id,name,workspace,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('team_old', 'legacy', tmp.ws, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    old.prepare('INSERT INTO member (id,team_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('m_old', 'team_old', 'legacy-bob', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    old.close();

    // 关键：这条 openDb 在修复前会抛 "no such column: agent_session_id"
    const db = openDb(file);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert(cols('team').includes('permission_preset'), 'team.permission_preset 已补列');
    assert(cols('team').includes('agent_preset'), 'team.agent_preset 已补列');
    assert(cols('member').includes('agent_preset'), 'member.agent_preset 已补列');
    assert(cols('approval').length > 0, 'approval 表已建');
    assert(cols('member').includes('agent_session_id'), 'member.agent_session_id 已补列');
    const version = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version').value;
    assert.equal(Number(version), SCHEMA_VERSION, 'schema_version 升到当前版本');
    const team = db.prepare('SELECT * FROM team WHERE id=?').get('team_old');
    assert.equal(team.name, 'legacy', '旧团队数据保留');
    assert.equal(team.permission_preset, 'workspace-write', '旧团队默认 workspace-write 预设');
    assert.equal(team.agent_preset, null, '旧团队没有 agent preset（沿用宿主默认）');
    const member = db.prepare('SELECT * FROM member WHERE id=?').get('m_old');
    assert.equal(member.name, 'legacy-bob', '旧成员数据保留');
    assert.equal(member.agent_session_id, null, '旧成员没有 agent session');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='member'").all().map((r) => r.name);
    assert(idx.includes('idx_member_session'), '迁移后补建 idx_member_session');
    const legacyTables = ['member_runtime', 'policy', 'scope_request', 'scope_grant', 'decision'];
    for (const t of legacyTables) {
      const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c;
      assert.equal(n, 0, `旧权限表 ${t} 已删除`);
    }
    // 迁移后新写入的团队能正常用
    db.prepare('INSERT INTO team (id,name,workspace,permission_preset,agent_preset,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('team_new', 'fresh', tmp.ws, 'danger-full-access', 'reviewer', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    assert.equal(db.prepare('SELECT permission_preset FROM team WHERE id=?').get('team_new').permission_preset, 'danger-full-access', '新团队可写预设');
    assert.equal(db.prepare('SELECT agent_preset FROM team WHERE id=?').get('team_new').agent_preset, 'reviewer', '新团队可写 agent preset');
    db.close();

    // 再开一次：幂等（不重复 ALTER、不重复建索引报错）
    const again = openDb(file);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM team').get().c, 2, '二次打开数据不变');
    again.close();

    console.log('PASS db-migration — v1 库补 permission_preset/agent_preset、删旧权限表、升到 v9，旧数据保留，二次打开幂等');
    process.exitCode = 0;
  } finally {
    tmp.cleanup();
  }
};

main();
