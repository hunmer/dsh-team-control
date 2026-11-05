# 文件地图

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

```text
dsh-team-control/
├── CLAUDE.md                 本索引
├── AGENTS.md                 仓库级 Agent 约定（中文输出、最小改动等）
├── README.md                 对外说明（安装、CLI、五条硬约束、限制）
├── package.json              dsh-team-control v0.2.0，bin.dsh-team，engines >=22.15
├── bin/
│   └── dsh-team.mjs          205 行 CLI：up/down/status/dag/logs/approvals/report
├── src/                      编排内核
│   ├── core.mjs              1772 行 组合根 + recoverAll + stopTeam
│   ├── db.mjs                379 行 schema v14（25 张表）+ q/tx/openDb
│   ├── eventstore.mjs        202 行 append/rebuild/tail
│   ├── scheduler.mjs         413 行 DAG/派发/关键路径（settleMs 200, tickMs 150）
│   ├── bus.mjs               179 行 持久信箱 + 三态回执
│   ├── board.mjs             486 行 工作区看板状态机（ADR-012）
│   ├── sse.mjs               111 行 SSE hub（lastEventId）
│   ├── server.mjs            323 行 HTTP 路由（含 /api/board/**）+ 静态托管
│   ├── llm.mjs               209 行 模型目录（只存不调）
│   ├── util.mjs              152 行 时间/ID/glob/哈希/脱敏/PrioQueue
│   ├── web/                  面板构建产物（只提交 panel.html + 2 个 assets）
│   └── web-ui/               面板源码（见 src/web-ui/CLAUDE.md）
├── dsh-plugin/               Host 插件
│   ├── index.js              3484 行 14 个 team_* + 2 个 board_* 工具 + 生命周期 + 上报泵
│   ├── changes.js            168 行 文件改动 diff（FILE_TOOLS 白名单）
│   ├── pricing.js            165 行 峰值时段计价
│   ├── cordis.patch.yml      插件插入配置
│   ├── locale/{zh,en}.json   插件标题/描述
│   └── package.json          dsh-team-control（依赖 dsh-team-control-cli）
├── dsh-plugin-ui/            GUI 面板插件
│   ├── index.js              177 行 Host half：同源代理 /dsh-team-api
│   ├── client.js             1683 行 Client half：「编排」+「任务看板」入口 + iframe
│   ├── cordis.patch.yml
│   └── package.json          dsh-team-control-ui（dsh.bundle.patch / dsh.client）
├── tests/                    31 个脚本
│   ├── run-all.mjs           跑全部 *.mjs，支持 --only
│   ├── lib/harness.mjs       startSidecar/apiClient/waitFor/sseOpen/readDb/runAc
│   └── ac-01/02/06/07/08/10/13/15/16/17/18 + plugin-*/routes/cli/db-migration/panel/pricing/todo-plan 等
├── docs/
│   ├── CONTRACT.md           430 行 实现契约（唯一口径，v2 冻结；§3.13 看板）
│   ├── adr/                  ADR-001 … ADR-012
│   ├── handoffs/             3 份交接记录（含时间戳）
│   └── web-ui-affectui-home-prd.md 等
├── prd/
│   ├── agent-team-plugin-prd.md   v1.0：FR-1~FR-8、AC、里程碑、D 决策
│   └── implementation-brief.md    M1/M2/M3 顺序、五条硬约束、踩坑
├── skills/dsh-agent-team/SKILL.md  调用配方（插件注册为 skills provider）
├── demo/
│   ├── run-demo.mjs          3 成员 + DAG + 审批 + 中断恢复
│   └── seed.mjs              灌演示数据
├── work/                     演示产物（gitignore）
└── screenshots/ + screenshots.json  面板视觉基线
```

## 常用定位

| 要找什么 | 去哪 |
|---|---|
| 某个 REST 路由怎么实现 | `src/server.mjs`（`createRoutes`） |
| 某张表/迁移 | `src/db.mjs` |
| 成员权限/审批为什么这样 | DSH 权限预设 + `approval` 表镜像（sidecar 不判定） |
| 任务为什么没派发 | `src/scheduler.mjs` 的 `readiness`/`pickIdleMember`/`evaluate` |
| 成员为什么卡 running | `core.recoverAll()` 与 Host 侧 `agent/status` 回写 |
| 看板任务状态流转 | `src/board.mjs`（`BOARD_STATUSES` + `claim/startTask/stopTask`） |
| 工具参数含义 | `dsh-plugin/index.js` 的 `buildTools` |
| 面板某个视图 | `src/web-ui/src/views/<Name>.tsx`（含 `Board.tsx`/`BoardPage.tsx`） |
| 契约规定 | `docs/CONTRACT.md` |
