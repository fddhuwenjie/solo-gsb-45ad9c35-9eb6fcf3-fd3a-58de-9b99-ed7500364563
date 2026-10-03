'use strict';

// 最小 DOM / fetch 桩：把 static/app.js 跑起来，验证投影层改造后的集成正确性。
// 不做渲染断言（jsdom 不在依赖中），只保证：初始化、编辑 → 投影、历史切换 / 预览
// 进入与原子恢复、沙盘推演等主流程不抛错且状态机正确。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleGraph } = require('./helpers.js');

function stubElement(tag = 'div') {
  const el = {
    tagName: tag, tag, hidden: false, disabled: false, innerHTML: '', textContent: '',
    value: '', className: '', dataset: {}, style: {}, options: [],
    classList: { _s: new Set(), add(...x) { x.forEach((v) => this._s.add(v)); },
      remove(...x) { x.forEach((v) => this._s.delete(v)); },
      toggle(v, on) { on ? this._s.add(v) : this._s.delete(v); },
      contains(v) { return this._s.has(v); } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { (el.children ||= []).push(c); (el.options ||= []).push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, focus() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; },
  };
  return el;
}

function loadApp(currentGraph, versionList) {
  const elements = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(),
    createElementNS: (_ns, tag) => stubElement(tag),
    createTextNode: (t) => stubElement('#text' + t),
    documentElement: stubElement(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const queue = [];
  const noop = () => {};
  const sandbox = {
    console,
    Math, JSON, Date, Set, Map, Object, Array, String, Number, Boolean, structuredClone,
    setTimeout: (fn) => { queue.push(fn); return 0; }, clearTimeout() {},
    addEventListener: noop, removeEventListener: noop,
    fetch: async (url) => {
      const u = String(url);
      let body;
      if (u === '/api/versions') body = { current_version_id: 1, versions: [] };
      else if (u === '/api/reviews') body = { sessions: [] };
      else if (u === '/api/proposals') body = { proposals: [] };
      else if (currentGraph.__fail) return { ok: false, status: 500, json: async () => ({ detail: 'boom' }) };
      else body = currentGraph.__next || currentGraph;
      return { ok: true, json: async () => body, headers: { get: () => null } };
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox;
  sandbox.__EXPOSE_APP_STATE__ = true;
  sandbox.globalThis = sandbox;
  sandbox.CSS = { escape: (s) => s };
  vm.createContext(sandbox);
  const Pjs = fs.readFileSync(path.join(__dirname, '..', 'static', 'projection.js'), 'utf8');
  const Ajs = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  vm.runInContext(Pjs, sandbox);
  vm.runInContext(Ajs, sandbox);
  return { sandbox, graph: currentGraph, flush: () => queue.splice(0).forEach((fn) => fn()) };
}

test('app.js 初始化：work 投影可写，派生计算可用', async () => {
  const ctx = loadApp({ __next: sampleGraph() });
  // loadState() 在脚本末尾被调用，等待微任务完成
  await new Promise((r) => setTimeout(r, 0));
  const S = ctx.sandbox.__app.S;
  assert.ok(S.projection, '初始化后存在活动投影');
  assert.equal(S.projection.source, 'work');
  assert.equal(S.projection.readonly, false);
  assert.equal(S.projection.nodes.size, sampleGraph().nodes.length);
  // 本地编辑 → work 投影更新
  S.work.nodes.get('n-loss').title = '改名';
  S.changes.node_updates.push({ id: 'n-loss', title: '改名' });
  ctx.sandbox.__app.rebuildWorkProjection();
  assert.equal(S.projection.nodes.get('n-loss').title, '改名');
});

test('app.js 历史切换后退出：工作图 / changeset 原子恢复（端到端状态机）', async () => {
  const ctx = loadApp({ __next: sampleGraph() });
  await new Promise((r) => setTimeout(r, 0));
  const S = ctx.sandbox.__app.S;
  // 制造未提交修改
  S.work.nodes.get('n-loss').title = '未提交改名';
  S.changes.node_updates.push({ id: 'n-loss', title: '未提交改名' });
  ctx.sandbox.__app.rebuildWorkProjection();
  S.selected = { kind: 'node', id: 'n-loss' };

  // 进入历史（enterReadOnly 不经网络，直接用样例图）
  const old = sampleGraph();
  old.version_id = 1;
  ctx.sandbox.__app.enterReadOnly(old, { versionId: 1 }, 'server');
  assert.equal(S.projection.readonly, true);
  assert.equal(S.projection.nodes.get('n-loss').title, '订单损失');
  assert.ok(S.roSession);
  assert.equal(S.selected, null);

  // 退出：未提交改名与选中项回来
  ctx.sandbox.__app.exitReadOnly();
  assert.equal(S.projection.source, 'work');
  assert.equal(S.projection.nodes.get('n-loss').title, '未提交改名');
  assert.equal(S.changes.node_updates.length, 1);
  assert.equal(S.selected.kind, 'node');
  assert.equal(S.selected.id, 'n-loss');
  assert.equal(S.roSession, null);
});

test('app.js 预览中沙盘在只读投影上推演，退出后恢复沙盘现场', async () => {
  const ctx = loadApp({ __next: sampleGraph() });
  await new Promise((r) => setTimeout(r, 0));
  const S = ctx.sandbox.__app.S;
  S.sandbox.active = true;
  S.sandbox.targetId = 'n-loss';
  S.sandbox.prevented = new Set(['n-code']);

  const prev = sampleGraph();
  ctx.sandbox.__app.enterReadOnly(prev, { kind: 'proposal' }, 'proposal');
  // 预览投影上直接推演
  const r = ctx.sandbox.__app.computeCounterfactual(S.projection, null, 'n-loss', []);
  assert.equal(r.version_id, 1);
  assert.equal(r.target_status, 'still_active');

  ctx.sandbox.__app.exitReadOnly();
  assert.equal(S.sandbox.targetId, 'n-loss');
  assert.deepEqual([...S.sandbox.prevented], ['n-code']);
});

test('app.js 预览请求失败：视图状态机保持在编辑态', async () => {
  const ctx = loadApp({ __next: sampleGraph() });
  await new Promise((r) => setTimeout(r, 0));
  const S = ctx.sandbox.__app.S;
  S.changes.node_updates.push({ id: 'n-loss', title: 'x' });
  // viewVersion 走 fetch 桩；标记所有响应失败
  ctx.graph.__fail = true;
  await ctx.sandbox.__app.viewVersion(999);
  assert.equal(S.viewingVersion, null);
  assert.equal(S.projection.source, 'work');
  assert.equal(S.changes.node_updates.length, 1);
});
