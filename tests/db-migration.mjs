// tests/db-migration.mjs — 老库（schema v1：team 无 runtime、member 无 agent_session_id）必须能被 openDb 就地补列，
// 而不是启动即 "no such column" 崩掉；旧数据保留且默认 runtime='worker'。（真实事故：.dsh/team 的 v1 库）
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
    assert(cols('team').includes('runtime'), 'team.runtime 已补列');
    assert(cols('member').includes('agent_session_id'), 'member.agent_session_id 已补列');
    const version = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version').value;
    assert.equal(Number(version), SCHEMA_VERSION, 'schema_version 升到当前版本');
    const team = db.prepare('SELECT * FROM team WHERE id=?').get('team_old');
    assert.equal(team.name, 'legacy', '旧团队数据保留');
    assert.equal(team.runtime, 'worker', '旧团队默认按 worker 运行');
    const member = db.prepare('SELECT * FROM member WHERE id=?').get('m_old');
    assert.equal(member.name, 'legacy-bob', '旧成员数据保留');
    assert.equal(member.agent_session_id, null, '旧成员没有 agent session');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='member'").all().map((r) => r.name);
    assert(idx.includes('idx_member_session'), '迁移后补建 idx_member_session');
    // 迁移后新写入的 agent 团队能正常用
    db.prepare('INSERT INTO team (id,name,workspace,runtime,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('team_new', 'fresh', tmp.ws, 'agent', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    assert.equal(db.prepare('SELECT runtime FROM team WHERE id=?').get('team_new').runtime, 'agent', '新团队可写 runtime');
    db.close();

    // 再开一次：幂等（不重复 ALTER、不重复建索引报错）
    const again = openDb(file);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM team').get().c, 2, '二次打开数据不变');
    again.close();

    console.log('PASS db-migration — v1 库补列/补索引/升版本，旧数据保留且默认 worker，二次打开幂等');
    process.exitCode = 0;
  } finally {
    tmp.cleanup();
  }
};

main();
