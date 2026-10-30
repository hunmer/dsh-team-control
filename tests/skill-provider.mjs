// tests/skill-provider.mjs — 插件自带 skill：发现/解析/加载 + skills provider 注册
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply, discoverTeamSkills, parseSkillFrontmatter } from '../dsh-plugin/index.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// 1) 发现：仓库 skills/ 里的 dsh-agent-team 能被列出来
const candidates = discoverTeamSkills();
const team = candidates.find((c) => c.name === 'dsh-agent-team');
assert.ok(team, '应发现 dsh-agent-team');
assert.equal(team.rank, 600, '打包来源用 BUNDLED_SKILL_RANK=600');
assert.equal(team.invocation.modelInvocable, true);
assert.equal(team.invocation.userInvocable, true, 'SKILL.md 里 user-invocable: true');
assert.equal(team.provider, 'dsh-team');
assert.equal(team.resourceBase.kind, 'directory');
assert.ok(fs.existsSync(path.join(team.resourceBase.path, 'SKILL.md')));
assert.ok(team.description.includes('team_create'), 'description 用作路由摘要');

// 2) frontmatter 解析：引号、布尔、冒号后长文本
assert.deepEqual(parseSkillFrontmatter('---\nname: a-b\nuser-invocable: false\nx: "q: v"\n---\nbody'), {
  name: 'a-b',
  'user-invocable': false,
  x: 'q: v',
});
assert.deepEqual(parseSkillFrontmatter('没有 frontmatter'), {});

// 3) 加载：frontmatter 被剥掉，正文完整
const fake = {
  name: 'tmp-skill',
  description: 'd',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled',
  provider: 'dsh-team',
  path: path.join(repoRoot, 'skills', 'dsh-agent-team', 'SKILL.md'),
  locator: { file: path.join(repoRoot, 'skills', 'dsh-agent-team', 'SKILL.md') },
};
let loaded;
const ctx = {
  tools: { register: (t) => { void t; return () => {}; } },
  effect: (fn) => { fn(); },
  on: () => () => {},
  inject: (deps, cb) => {
    assert.deepEqual(deps, ['skills']);
    cb({ skills: { registerProvider: (create) => { loaded = create({ signal: new AbortController().signal, invalidate() {} }); return () => {}; } } });
  },
};
apply(ctx, { autoStart: false, reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false, reportWorkspaces: false, reportLlmCatalog: false });
assert.ok(loaded, 'apply 应注册 skills provider');
assert.equal(loaded.name, 'dsh-team');
const listed = await loaded.list({ cwd: repoRoot });
assert.ok(listed.some((c) => c.name === 'dsh-agent-team'));
const definition = await loaded.get(fake, { cwd: repoRoot });
assert.ok(definition);
assert.ok(!definition.content.startsWith('---'), '正文不含 frontmatter');
assert.ok(definition.content.includes('team_create'), '正文是技能内容');

console.log('skill-provider ok');
process.exit(0);
