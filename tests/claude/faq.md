# tests/ 常见问题

**「偶发失败，重跑就好」**
AC 全是真进程 + 真端口。先看失败时打印的临时目录（脚本**故意保留**），进去 `ls logs/` 和 `sqlite3 team.db .tables`。多半是 `waitFor` 超时偏短，而不是逻辑错。

**`startSidecar` 卡住或返回端口 0**
ready 横幅必须是 stdout **第一行单行 JSON**。若 sidecar 启动时先打了别的（比如 Node 实验性 API 警告进了 stdout），解析就挂。把警告改到 stderr 或过滤。

**端口冲突**
不该出现——全部用 `--port 0`。若脚本里写死了 4317，改成 0。

**残留进程/残留目录**
脚本收尾必须 `SIGKILL` + 删目录。手工清理：`ls /tmp | grep dsh-team-ac`。

**`readDb` 报找不到 sqlite**
harness 优先用 `node:sqlite`；若该 Node 版本没有，会退到 `sqlite3` CLI。都没有时相关断言应跳过而不是失败。

**插件脚本为什么不需要 sidecar**
`plugin-*` 用假 ctx 捕获 `buildTools` 返回的工具表，直接调 `execute` 断言。只有真正要跨进程的（如 `plugin-agent`）才起 sidecar。

**`panel-contract` 挂了**
`src/web/assets/` 里被 `panel.html` 引用的文件名带 hash。改了构建配置或没重新 build，就会不一致。`cd src/web-ui && npm run build`。

**`--only` 没匹配到**
`--only ac-05` 是**子串匹配**脚本名；写成 `--only 05` 也能中，但 `--only ac-5` 不中。

**跑全量太慢**
AC 优先执行；单条调试用 `--only`。别为了快而去掉 `waitFor` 改成 `sleep`——那是抖动来源。
