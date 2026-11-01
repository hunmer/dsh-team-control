# 文件地图

```text
dsh-agent-team-plugin/
├── CLAUDE.md                 本索引
├── AGENTS.md                 仓库级 Agent 约定（中文输出、最小改动等）
├── README.md                 对外说明（安装、CLI、五条硬约束、限制）
├── package.json              dsh-team-control v0.1.6，bin.dsh-team，engines >=22.15
├── bin/
│   └── dsh-team.mjs          207 行 CLI：up/down/status/dag/logs/approve/report
├── src/                      编排内核
│   ├── core.mjs              1632 行 组合根 + recoverAll
│   ├── db.mjs                310 行 schema v7 + q/tx/openDb/closeDb
│   ├── eventstore.mjs        202 行 append/rebuild/tail
│   ├── policy.mjs            184 行 纯求值（normalizeTarget/matchTarget/evaluate/…）
│   ├── broker.mjs            531 行 四域唯一 IO 出口 + audit + grant
│   ├── scheduler.mjs         474 行 DAG/派发/关键路径（settleMs 200, tickMs 150）
│   ├── runner.mjs            384 行 worker 进程/租约/中断/恢复
│   ├── bus.mjs               174 行 持久信箱 + 三态回执
│   ├── sse.mjs               111 行 SSE hub（lastEventId）
│   ├── server.mjs            285 行 HTTP 路由 + 静态托管
│   ├── llm.mjs               209 行 模型目录（只存不调）
│   ├── util.mjs              152 行 时间/ID/glob/哈希/脱敏/PrioQueue
│   ├── worker/worker.mjs     318 行 受限 Worker（仅 import node:module）
│   ├── web/                  面板构建产物（只提交 panel.html + 2 个 assets；legacy/ 为旧版备份）
│   └── web-ui/               面板源码（见 src/web-ui/CLAUDE.md）
├── dsh-plugin/               Host 插件
│   ├── index.js              2126 行 12 个 team_* 工具 + 生命周期 + 上报泵
│   ├── changes.js            168 行 文件改动 diff（FILE_TOOLS 白名单）
│   ├── pricing.js            165 行 峰值时段计价
│   ├── cordis.patch.yml      插件插入配置
│   ├── locale/{zh,en}.json   插件标题/描述
│   └── package.json          dsh-team-control（依赖 dsh-team-control-cli ^0.1.1）
├── dsh-plugin-ui/            GUI 面板插件
│   ├── index.js              177 行 Host half：同源代理 /dsh-team-api
│   ├── client.js             1532 行 Client half：页签/侧栏挂载 + iframe
│   ├── cordis.patch.yml
│   └── package.json          dsh-team-control-ui v0.1.7（dsh.bundle.patch / dsh.client）
├── tests/
│   ├── run-all.mjs           跑全部 *.mjs，支持 --only
│   ├── lib/harness.mjs       startSidecar/apiClient/waitFor/sseOpen/readDb/runAc
│   └── ac-01…ac-16 + 插件/路由/CLI/迁移/面板/计价脚本
├── docs/
│   ├── CONTRACT.md           405 行 实现契约（唯一口径，v1 冻结）
│   ├── adr/                  ADR-001 … ADR-011
│   ├── handoffs/             3 份交接记录（含时间戳）
│   ├── web-ui-affectui-home-prd.md
│   └── novel-preview*.md
├── prd/
│   ├── agent-team-plugin-prd.md   v1.0：FR-1~FR-8、AC、里程碑、D 决策
│   └── implementation-brief.md    M1/M2/M3 顺序、五条硬约束、踩坑
├── skills/dsh-agent-team/SKILL.md  5 步调用配方（插件注册为 skills provider）
├── demo/
│   ├── run-demo.mjs          3 成员 + DAG + 审批 + 中断恢复
│   └── seed.mjs              灌演示数据
├── work/essay-team/          演示产物（gitignore）
└── screenshots/ + screenshots.json  面板视觉基线
```

## 常用定位

| 要找什么 | 去哪 |
|---|---|
| 某个 REST 路由怎么实现 | `src/server.mjs`（`createRoutes`） |
| 某张表/迁移 | `src/db.mjs` |
| 权限为什么拒了 | `src/policy.mjs` 求值 → `src/broker.mjs` 审计 |
| 任务为什么没派发 | `src/scheduler.mjs` 的 `readiness`/`pickIdleMember`/`evaluate` |
| 成员为什么卡 running | `src/runner.mjs` 租约 + `core.recoverAll()` |
| 工具参数含义 | `dsh-plugin/index.js` 的 `buildTools` |
| 面板某个视图 | `src/web-ui/src/views/<Name>.tsx` |
| 契约规定 | `docs/CONTRACT.md` |
