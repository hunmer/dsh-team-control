// tests/plugin-client.mjs — 客户端插件入口自测（不启动 DSH）：
// ① 装了 dsh-better-sidebar：额外注册一个页签；DSH 原生右侧栏入口仍始终注册
// ② 没装：右侧栏 Tab + 左下角入口照旧；better-sidebar 晚到时只补注册，不撤原生入口
// ③ 连 sidebarRight 服务都没有：中央停靠面板兜底
// 用法：node tests/plugin-client.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
  },
  // 页面组件（iframe 版编排页）用到基础 hooks：桩成「每次渲染重算」的即时求值
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useEffect: (fn) => {
    const cleanup = fn();
    return typeof cleanup === 'function' ? cleanup : undefined;
  },
};

let plugin;
globalThis.window = {
  // iframe 页会监听 postMessage / resize：测试里不需要真的收消息
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ factory }) {
      plugin = factory((id) => {
        if (id === 'react') return React;
        throw new Error('unexpected require: ' + id);
      });
    },
  },
};

await import(pathToFileURL(path.resolve('dsh-plugin-ui/client.js')).href);
assert.ok(plugin && typeof plugin.apply === 'function', 'client.js 导出了 plugin.apply');

const t = (key) => key;

function makeSlots() {
  const entries = [];
  return {
    entries,
    slots: {
      inject(_name, register) {
        const start = entries.length;
        register();
        // 只撤销本次 inject 注册产生的条目，别误伤之后注册的其它槽（如右上角团队卡片）
        const mine = entries.slice(start);
        return () => {
          for (const entry of mine) {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
          }
        };
      },
      register(spec, component) {
        const entry = { spec, component };
        entries.push(entry);
        return () => {
          const i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
        };
      },
    },
  };
}

function makeCtx(services) {
  const { slots, entries } = makeSlots();
  const injectCbs = [];
  const effects = [];
  const ctx = {
    locale: { register() {}, bind: () => t },
    get: (name) => services[name],
    slots,
    inject(deps, cb) {
      injectCbs.push({ deps, cb });
      return { dispose() { /* fake fiber */ } };
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, entries, injectCbs, effects };
}

function makeBetter() {
  const tabs = [];
  return {
    tabs,
    registerTab(desc) {
      tabs.push(desc);
      return () => {
        const i = tabs.indexOf(desc);
        if (i >= 0) tabs.splice(i, 1);
      };
    },
  };
}

function render(node) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return render(node.type(node.props));
  return node;
}

function findFrame(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'iframe') return node;
  const kids = node.props?.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = findFrame(kid);
    if (hit) return hit;
  }
  return null;
}

let failed = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name} — ${e.message}`);
  }
};

// ---------- ① 装了 better-sidebar ----------
check('better-sidebar 已装：额外注册页签，原生右侧栏入口仍在', () => {
  const better = makeBetter();
  const app = makeCtx({ betterSidebar: better });
  plugin.apply(app.ctx);
  assert.equal(better.tabs.length, 1, `registerTab 次数=${better.tabs.length}`);
  assert.deepEqual(
    app.entries.map((e) => e.spec.name).sort(),
    ['conversation.session.header.utilities', 'shell.overlay', 'sidebar.right.pane.tab'],
    `原生入口 + 团队卡片都要在：${app.entries.map((e) => e.spec.name).join(',')}`,
  );
  assert.equal(app.injectCbs.length, 1, '只等 sidebarRightTabs（本用例没给这个服务）');
  assert.deepEqual(app.injectCbs[0].deps, ['sidebarRightTabs']);
  assert.equal(app.effects.length, 2, '入口 + 右上角团队卡片各挂一个 ctx.effect');
  assert.ok(app.effects.every((dispose) => typeof dispose === 'function'), '每个 effect 都要返回可调用的清理函数');
  app.effects.forEach((dispose) => dispose());
  assert.equal(better.tabs.length, 0, '效应清理后页签已撤销');
  assert.equal(app.entries.length, 0, '效应清理后槽注册已撤销');
  return 'id=dsh-team:panel';
});

check('页签描述：id/title/description/order/single 与 iframe 内容', () => {
  const better = makeBetter();
  const app = makeCtx({ betterSidebar: better });
  plugin.apply(app.ctx);
  const desc = better.tabs[0];
  assert.equal(desc.id, 'dsh-team:panel');
  assert.equal(desc.single, true);
  assert.equal(desc.order, 30);
  assert.equal(desc.title(), 'side_nav');
  assert.equal(desc.description(), 'subtitle');
  assert.equal(typeof desc.component, 'function', 'component 必填');
  const frame = findFrame(render(desc.component({})));
  assert.ok(frame, '页签里渲染了 iframe');
  assert.equal(frame.props.src, '/dsh-team-api/panel?api=/dsh-team-api&embed=1');
  const icon = desc.icon(16);
  assert.equal(render(icon).type, 'svg', 'icon(size) 渲染成 svg');
  return 'iframe src ok';
});

// ---------- ② 没装 better-sidebar（有 sidebarRight） ----------
check('未装 better-sidebar：右侧栏 Tab + 「开始」页 guide 入口', () => {
  const opened = [];
  const registered = [];
  const app = makeCtx({
    sidebarRight: { openTab: (id) => opened.push(id) },
    sidebarRightTabs: { register: (d) => { registered.push(d); return () => {}; } },
  });
  plugin.apply(app.ctx);
  assert.equal(registered.length, 1, 'sidebarRightTabs.register 一次');
  assert.equal(registered[0].id, 'dsh-team');
  const names = app.entries.map((e) => e.spec.name).sort();
  assert.deepEqual(
    names,
    ['conversation.session.header.utilities', 'shell.overlay', 'sidebar.right.pane.tab'],
    names.join(','),
  );
  assert.equal(registered[0].guide.length, 1, 'guide 入口一个（右侧栏「开始」页）');
  assert.equal(registered[0].guide[0].id, 'dsh-team');
  assert.equal(registered[0].guide[0].title(), 'side_nav');
  assert.equal(registered[0].guide[0].description(), 'guide_desc');
  assert.equal(render(registered[0].guide[0].icon(22)).type, 'svg', 'guide 图标渲染成 svg');
  assert.equal(opened.length, 0, '注册本身不打开页签');
  assert.equal(app.injectCbs.length, 1, '等待 better-sidebar 晚到');
  app.effects.forEach((dispose) => dispose());
  assert.equal(app.entries.length, 0, '清理后槽注册已撤');
  return 'fallback ok';
});

check('better-sidebar 晚到：补注册页签，原生右侧栏入口保留', () => {
  const opened = [];
  const app = makeCtx({
    sidebarRight: { openTab: (id) => opened.push(id) },
    sidebarRightTabs: { register: () => () => {} },
  });
  plugin.apply(app.ctx);
  assert.ok(app.entries.some((e) => e.spec.name === 'sidebar.right.pane.tab'), '先有原生右侧栏页签');
  const better = makeBetter();
  app.injectCbs[0].cb({ betterSidebar: better });
  assert.equal(better.tabs.length, 1, '晚到后注册 better-sidebar 页签');
  assert.ok(!app.entries.some((e) => e.spec.name === 'sidebar.footer.action'), '不再往左侧栏底部加入口');
  assert.ok(app.entries.some((e) => e.spec.name === 'sidebar.right.pane.tab'), '原生右侧栏 Tab 保留');
  const better2 = makeBetter();
  app.injectCbs[0].cb({ betterSidebar: better2 });
  assert.equal(better2.tabs.length, 1, '服务实例变化后在新实例上重新注册');
  return 'switch ok';
});

// ---------- ③ 两个服务都没就绪（冷启动） ----------
check('服务晚到：sidebarRightTabs 由 ctx.inject 等待，就绪后补注册 guide 入口', () => {
  const app = makeCtx({});
  plugin.apply(app.ctx);
  const names = app.entries.map((e) => e.spec.name).sort();
  assert.deepEqual(
    names,
    ['conversation.session.header.utilities', 'shell.overlay', 'sidebar.right.pane.tab'],
    names.join(','),
  );
  assert.ok(app.injectCbs.some((c) => c.deps.includes('sidebarRightTabs')), '等待 sidebarRightTabs');
  // 服务晚到 → 注册 tab 类型与 guide 入口
  const registered = [];
  const wait = app.injectCbs.find((c) => c.deps.includes('sidebarRightTabs'));
  wait.cb({ sidebarRightTabs: { register: (d) => { registered.push(d); return () => {}; } } });
  assert.equal(registered.length, 1, '晚到后注册一次');
  assert.equal(registered[0].guide.length, 1, 'guide 入口随服务就绪一起注册');
  const better = makeBetter();
  const waitBetter = app.injectCbs.find((c) => c.deps.includes('betterSidebar'));
  waitBetter.cb({ betterSidebar: better });
  assert.equal(better.tabs.length, 1, 'better-sidebar 晚到时仍可接管');
  return 'late services ok';
});

check('cleanup 幂等（重复调用不抛错）', () => {
  const better = makeBetter();
  const app = makeCtx({ betterSidebar: better });
  plugin.apply(app.ctx);
  const dispose = app.effects[0];
  dispose();
  dispose();
  return 'ok';
});

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed ? 1 : 0);
