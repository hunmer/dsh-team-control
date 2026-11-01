# 挂载与代理

## Host half（`index.js`，177 行）

```js
export const name = 'dsh-team-ui'
export const inject = ['webServer']

resolveConfig(config)   // baseUrl / home / autoStart / ...
isUp(baseUrl)           // GET /api/health
spawnSidecar()          // 同 dsh-plugin 的拉起逻辑
ensureSidecar()         // 已起则跳过
proxyHandler(req,res)   // /dsh-team-api/* → {baseUrl}/*，补 Authorization
apply(ctx, config)      // ctx.webServer 上注册代理
```

代理行为：
- 前缀 `/dsh-team-api` 剥掉后拼到 `baseUrl` 上。
- 从 `home/token` 读 token 补 `Authorization`（**浏览器侧不可见**）。
- 不缓存、不改写 body、不重试。
- SSE（`/dsh-team-api/events`）要**流式直通**，不能缓冲。

`cordis.patch.yml`：
```yaml
insert:
  id: dsh-team-ui
  name: dsh-team-control-ui
  config: { baseUrl: 'http://127.0.0.1:4317', autoStart: true }
```

## Client half（`client.js`，1532 行）

```js
window.__ModuleLoader__.load({
  id: 'dsh-team-control-ui',
  factory(require) { /* 只允许 require('react') */ }
})
```

注册链（逐级回退）：

```text
1) better-sidebar 页签：id = 'dsh-team:panel'，order 30，mode single
2) 回退：sidebarRightTabs + sidebar.footer.action（右下角按钮）
3) 回退：main panel（占满主区）
```

三种入口渲染的都是同一个 iframe：

```html
<iframe src="{proxyBase}/panel?api=/dsh-team-api&embed=1" />
```

`embed=1` 让面板隐藏部分外壳；`api` 告诉面板前端所有请求打到代理前缀而不是同源 `/api`（见 `src/web-ui/src/lib/api.ts`）。

## package.json 关键字段

```json
{
  "name": "dsh-team-control-ui",
  "version": "0.1.7",
  "dsh": {
    "bundle": { "patch": "cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"]
    }
  }
}
```

`dsh.client.immediately:true` 表示不等宿主页面就绪就注入 client 模块；`inject` 声明它依赖设置页插件包的存在。

## 排查路径

| 现象 | 先看 |
|---|---|
| 页签/按钮都不出现 | `client.js` 的 loader 是否执行（浏览器 console）；`package.json` 的 `dsh.client` 是否被宿主读到 |
| 出现了但白屏 | iframe URL 的 `api` 与 Host 代理前缀是否一致；`/panel` 是否 404（面板没构建） |
| 请求 401/403 | 代理是否补上 Authorization；`home/token` 是否存在 |
| SSE 不推 | 代理是否把 `/dsh-team-api/events` 流式直通（被缓冲会看起来「不实时」） |
| 面板功能正常但样式错乱 | `src/web/` 产物是否是当前版本（`cd src/web-ui && npm run build`） |
