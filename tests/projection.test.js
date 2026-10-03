/* 不可变图投影层回归测试
 *
 * 运行：node --test tests/projection.test.js
 *
 * 覆盖：
 *   1. 三类只读预览（单提案 / 三方合并 / 重复事件归并）→ 只读投影、稳定 ID 顺序
 *   2. 服务端历史快照 → 只读投影，含缺字段补默认与悬空 / 坏结构剔除（字段缺失）
 *   3. 本地 changeset → 可编辑工作投影（重放纯函数，不改动入参）
 *   4. 时间窗 / 证据审查 / 反事实只接受投影
 *   5. 只读视图栈：历史切换、预览请求失败原子恢复（工作图 / changeset / 选中项 / 沙盘）
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../static/projection.js');

// ---------- 测试夹具 ----------

function event(id, patch = {}) {
  return {
    id, type: 'event', title: `事件 ${id}`, description: '',
    pos_x: 10, pos_y: 20, created_at: '',
    earliest_time: null, latest_time: null,
    reliability: null, source_group: null, trigger_mode: 'ANY', ...patch,
  };
}
function evidence(id, patch = {}) {
  return {
    id, type: 'evidence', title: `证据 ${id}`, description: '',
    pos_x: 30, pos_y: 40, created_at: '',
    earliest_time: null, latest_time: null,
    reliability: 0.5, source_group: null, trigger_mode: null, ...patch,
  };
}
function edge(id, source_id, target_id, kind = 'causes', patch = {}) {
  return { id, source_id, target_id, kind, label: '', created_at: '', ...patch };
}

function serverGraph(nodes, edges, versionId = 1) {
  return { version_id: versionId, nodes, edges };
}

// 示例因果图： a → b → c ；e1 支持 b（r=0.9）
function sampleGraph(versionId = 1) {
  return serverGraph([
    event('a', { title: '根因', earliest_time: '2026-09-20T02:00:00Z' }),
    event('b', { title: '中间', earliest_time: '2026-09-20T02:00:30Z', latest_time: '2026-09-20T03:00:00Z' }),
    event('c', { title: '损失', latest_time: '2026-09-20T04:00:00Z' }),
    evidence('e1', { reliability: 0.9, source_group: '监控平台' }),
  ], [
    edge('ea', 'a', 'b'),
    edge('eb', 'b', 'c'),
    edge('es1', 'e1', 'b', 'supports', { label: '确认' }),
  ], versionId);
}

// ---------- 1. 投影构造：只读标记、稳定 ID 顺序、不可变 ----------

test('服务端快照生成只读投影，带来源版本与稳定 ID 顺序', () => {
  const g = sampleGraph(3);
  // 故意乱序输入
  g.nodes = [g.nodes[2], g.nodes[0], g.nodes[3], g.nodes[1]];
  g.edges = [g.edges[1], g.edges[2], g.edges[0]];
  const p = GP.buildProjection(g, { kind: 'history' });

  assert.equal(p.meta.readOnly, true);
  assert.equal(p.meta.sourceVersion, 3);
  assert.equal(p.meta.kind, 'history');
  assert.deepEqual(p.nodeOrder, ['a', 'b', 'c', 'e1']);
  assert.deepEqual(p.edgeOrder, ['ea', 'eb', 'es1']);
  assert.equal(p.version_id, 3);
});

test('投影与其节点 / 连线 / Map 均不可变（预览不能落库 / 不能被就地改写）', () => {
  const p = GP.buildProjection(sampleGraph());
  assert.throws(() => { p.nodes.set('x', {}); }, TypeError);
  assert.throws(() => { p.nodes.get('a').title = '被篡改'; }, TypeError);
  assert.throws(() => { p.edges.get('ea').label = '改'; }, TypeError);
  assert.throws(() => { p.version_id = 99; }, TypeError);
  assert.throws(() => { p.nodeOrder.push('x'); }, TypeError);
});

test('构造投影不改动也不共享服务端输入引用', () => {
  const g = sampleGraph();
  const p = GP.buildProjection(g);
  assert.notEqual(p.nodes.get('a'), g.nodes[0]);
  // 改输入对象不影响已生成投影
  g.nodes[0].title = '外部改写';
  assert.equal(p.nodes.get('a').title, '根因');
});

// ---------- 2. 三类预览 ----------

test('单提案预览图生成只读 proposal 投影', () => {
  // 服务端形态：{graph: 应用提案后的整图}
  const applied = sampleGraph(1);
  applied.nodes.push(event('new1', { title: '提案新增' }));
  applied.edges.push(edge('en1', 'new1', 'c'));
  const p = GP.buildProjection(applied, { kind: 'proposal', readOnly: true });
  assert.equal(p.meta.kind, 'proposal');
  assert.equal(p.meta.readOnly, true);
  assert.deepEqual(p.nodeOrder, ['a', 'b', 'c', 'e1', 'new1']);
  assert.ok(p.nodes.has('new1'));
});

test('三方合并预览（含裁决后的本地映射图）生成只读 merge 投影', () => {
  const merged = sampleGraph(1);
  const n = merged.nodes.find((x) => x.id === 'b');
  n.pos_x = 999;                       // 裁决后字段取值
  merged.nodes.push(event('new1'));
  const p = GP.buildProjection(merged, { kind: 'merge' });
  assert.equal(p.meta.kind, 'merge');
  assert.equal(p.nodes.get('b').pos_x, 999);
  assert.equal(p.meta.readOnly, true);
});

test('重复事件归并预览生成只读 node_merge 投影（重复节点已从投影消失）', () => {
  const g = sampleGraph(2);
  g.nodes.push(event('b2', { title: '中间(重复)' }));
  g.edges.push(edge('eb2', 'a', 'b2'), edge('ebc2', 'b2', 'c'));
  // 服务端归并预览图：b2 被删除、其边重接 / 合并
  const mergedGraph = {
    version_id: 2,
    nodes: g.nodes.filter((x) => x.id !== 'b2'),
    edges: [...g.edges.filter((x) => !['eb2', 'ebc2'].includes(x.id))],
  };
  const p = GP.buildProjection(mergedGraph, { kind: 'node_merge' });
  assert.equal(p.meta.kind, 'node_merge');
  assert.equal(p.nodes.has('b2'), false);
  assert.equal(p.edges.has('eb2'), false);
  assert.equal(p.meta.sourceVersion, 2);
});

// ---------- 3. 字段缺失 ----------

test('字段缺失：节点缺 trigger_mode 按类型补默认；证据节点恒 null', () => {
  const g = serverGraph(
    [{ id: 'a', type: 'event', title: 'A' },            // 缺大量字段
     { id: 'e', type: 'evidence', title: 'E' }],
    [{ id: 'x', source_id: 'e', target_id: 'a', kind: 'supports' }],
  );
  const p = GP.buildProjection(g);
  assert.equal(p.nodes.get('a').trigger_mode, 'ANY');
  assert.equal(p.nodes.get('a').earliest_time, null);
  assert.equal(p.nodes.get('a').pos_x, 0);
  assert.equal(p.nodes.get('e').trigger_mode, null);
  assert.equal(p.edges.get('x').label, '');
  assert.equal(p.meta.dropped.nodes, 0);
});

test('字段缺失：坏节点 / 坏类型 / 悬空边 / 坏 kind 被剔除并计数', () => {
  const g = serverGraph([
    event('a'),
    { id: 'bad1', title: '无类型' },                     // 无 type
    { id: 'bad2', type: 'ghost', title: '坏类型' },       // 坏类型
    null,
    event('dup'), event('dup'),                          // 重复 id 只留一条
  ], [
    edge('ok', 'a', 'dup'),
    { id: 'dangling', source_id: 'a', target_id: 'ghost', kind: 'causes' },
    { id: 'badkind', source_id: 'a', target_id: 'dup', kind: 'weird' },
    null,
    edge('ok2', 'dup', 'a'),
  ]);
  const p = GP.buildProjection(g);
  assert.deepEqual(p.nodeOrder, ['a', 'dup']);
  assert.deepEqual(p.edgeOrder, ['ok', 'ok2']);
  assert.equal(p.meta.dropped.nodes, 4);
  assert.equal(p.meta.dropped.edges, 3);
});

test('字段缺失：整图缺 nodes / edges 抛错且不产生投影', () => {
  assert.throws(() => GP.buildProjection({ nodes: [] }), /nodes \/ edges/);
  assert.throws(() => GP.buildProjection(null), /nodes \/ edges/);
});

// ---------- 4. changeset 重放（编辑工作投影） ----------

test('changeset 重放生成可编辑投影，且不改动基线与 changeset', () => {
  const base = sampleGraph();
  const baseJson = JSON.stringify(base);
  const changes = {
    base_version_id: 1,
    node_creates: [
      { id: 'd1', type: 'event', title: '新事件', pos_x: 5, pos_y: 6,
        earliest_time: null, latest_time: null, trigger_mode: 'ALL' },
    ],
    node_updates: [{ id: 'a', title: '根因改名' }],
    node_deletes: ['c'],
    edge_creates: [{ id: 'ed1', source_id: 'd1', target_id: 'b', kind: 'causes' }],
    edge_updates: [{ id: 'es1', kind: 'refutes' }],
    edge_deletes: ['eb'],
  };
  const changesJson = JSON.stringify(changes);
  const p = GP.projectionFromChangeset(base, changes);

  assert.equal(p.meta.readOnly, false);
  assert.equal(p.meta.source, 'changeset');
  assert.equal(p.nodes.get('a').title, '根因改名');
  assert.equal(p.nodes.has('c'), false);
  assert.equal(p.edges.has('eb'), false);          // 删除
  assert.equal(p.nodes.get('d1').trigger_mode, 'ALL');
  assert.equal(p.edges.get('es1').kind, 'refutes');
  assert.equal(p.edges.has('ed1'), true);
  // 入参未被触碰
  assert.equal(JSON.stringify(base), baseJson);
  assert.equal(JSON.stringify(changes), changesJson);
});

test('删除节点级联删除关联边；显式 null 清除字段', () => {
  const base = sampleGraph();
  const changes = {
    ...GP.emptyChangeset(),
    node_deletes: ['b'],
  };
  const p = GP.projectionFromChangeset(base, changes);
  assert.equal(p.edges.has('ea'), false);   // → b
  assert.equal(p.edges.has('eb'), false);   // b →
  assert.equal(p.edges.has('es1'), false);  // → b
  assert.equal(p.nodes.has('a'), true);

  const p2 = GP.projectionFromChangeset(base, {
    ...GP.emptyChangeset(),
    node_updates: [{ id: 'a', earliest_time: null }],
  });
  assert.equal(p2.nodes.get('a').earliest_time, null);
});

test('changeset 引用缺失节点 / 端点不存在时抛错（原子，不产生半应用图）', () => {
  assert.throws(() => GP.projectionFromChangeset(sampleGraph(), {
    ...GP.emptyChangeset(), node_updates: [{ id: 'ghost', title: 'x' }],
  }), /不存在的节点/);
  assert.throws(() => GP.projectionFromChangeset(sampleGraph(), {
    ...GP.emptyChangeset(), edge_creates: [{ id: 'z', source_id: 'a', target_id: 'ghost', kind: 'causes' }],
  }), /端点不存在/);
  assert.throws(() => GP.projectionFromChangeset(sampleGraph(), {
    ...GP.emptyChangeset(), edge_deletes: ['ghost'],
  }), /不存在的连线/);
});

// ---------- 5. 派生计算只接受投影 ----------

test('时间窗 / 证据审查 / 反事实拒绝散装 nodes/edges', () => {
  assert.throws(() => GP.computeCounterfactual({}, 'a', []), /不可变图投影/);
  assert.throws(() => GP.timeWindows({ nodes: new Map() }), /不可变图投影/);
  assert.throws(() => GP.evidenceReviews(null), /不可变图投影/);
});

test('时间窗在投影上传播，冲突链确定', () => {
  const g = sampleGraph();
  // b 的自报窗倒置：a(02:00) → b，b latest=01:00 → 冲突
  g.nodes.find((n) => n.id === 'b').latest_time = '2026-09-20T01:00:00Z';
  const p = GP.buildProjection(g);
  const { windows, conflict } = GP.timeWindows(p);
  assert.equal(windows.get('c').upper, '2026-09-20T04:00:00Z');
  assert.equal(windows.get('b').lower, '2026-09-20T02:00:30Z');
  assert.ok(conflict);
  assert.equal(conflict.node_id, 'a');
  assert.deepEqual(conflict.chain_node_ids, ['a', 'b']);
  // 同一投影实例缓存同一结果
  assert.equal(GP.timeWindows(p), GP.timeWindows(p));
});

test('证据审查在投影上聚合：同源取最高、S=0.9 supported', () => {
  const p = GP.buildProjection(sampleGraph());
  const reviews = GP.evidenceReviews(p);
  const rb = reviews.get('b');
  assert.equal(rb.support_score, 0.9);
  assert.equal(rb.status, 'supported');
});

test('反事实：干预根因沿 causes 传播；只接受事件目标', () => {
  const p = GP.buildProjection(sampleGraph());
  assert.throws(() => GP.computeCounterfactual(p, 'e1', []), /必须是事件/);
  const r = GP.computeCounterfactual(p, 'c', ['a']);
  assert.equal(r.target_status, 'prevented');
  assert.deepEqual(r.prevented_ids.sort(), ['a', 'b', 'c']);
  assert.equal(r.tree.node_id, 'c');
  assert.equal(r.version_id, 1);
});

test('ALL 门 + 干预单前因：只阻止该分支', () => {
  const g = serverGraph([
    event('a'), event('b'),
    event('all', { trigger_mode: 'ALL' }),
    event('c'),
  ], [
    edge('1', 'a', 'all'), edge('2', 'b', 'all'), edge('3', 'all', 'c'),
  ]);
  const p = GP.buildProjection(g);
  const r = GP.computeCounterfactual(p, 'c', ['a']);
  assert.equal(r.events.find((e) => e.node_id === 'all').status, 'prevented');
  assert.deepEqual(r.still_active_ids, ['b']);
});

// ---------- 6. 只读视图栈：历史切换与失败原子恢复 ----------

function editingFixture() {
  const work = GP.toMapGraph(GP.applyChangeset(sampleGraph(), {
    ...GP.emptyChangeset(),
    node_updates: [{ id: 'a', title: '未提交改名' }],
  }));
  return {
    work,
    changes: { ...GP.emptyChangeset(), node_updates: [{ id: 'a', title: '未提交改名' }] },
    selected: { kind: 'node', id: 'a' },
    sandbox: { ...GP.freshSandbox(), active: true, targetId: 'b',
               prevented: new Set(['a']), result: { target_id: 'b' } },
  };
}

test('进入历史帧前捕获编辑会话；切到另一历史版本不覆盖检查点', () => {
  const fix = editingFixture();
  const vs = GP.createViewStack();
  const snap = GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox);

  const p1 = GP.buildProjection(sampleGraph(5), { kind: 'history' });
  GP.enterFrame(vs, { kind: 'history', versionId: 5, projection: p1 }, snap);
  assert.equal(GP.isReadOnly(vs), true);
  assert.equal(GP.topFrame(vs).versionId, 5);

  // 切到 v4：替换只读帧，编辑检查点保持不变
  const p2 = GP.buildProjection(sampleGraph(4), { kind: 'history' });
  GP.replaceFrame(vs, { kind: 'history', versionId: 4, projection: p2 });
  assert.equal(GP.topFrame(vs).versionId, 4);
  assert.deepEqual(vs.checkpoint.changes.node_updates, [{ id: 'a', title: '未提交改名' }]);
});

test('退出历史帧原子恢复工作图 / changeset / 选中项 / 沙盘', () => {
  const fix = editingFixture();
  const vs = GP.createViewStack();
  const snap = GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox);
  GP.enterFrame(vs, { kind: 'history', versionId: 3,
                      projection: GP.buildProjection(sampleGraph(3), { kind: 'history' }) }, snap);

  // 只读帧里“假装”发生了任何渲染侧变更（不应污染检查点）
  GP.enterFrame; // no-op 引用，保持读感
  const restored = GP.exitFrame(vs);
  assert.equal(restored.kind, 'editing');
  const s = GP.restoreSession(restored.snapshot);
  assert.equal(s.work.nodes.get('a').title, '未提交改名');
  assert.deepEqual(s.changes.node_updates, [{ id: 'a', title: '未提交改名' }]);
  assert.deepEqual(s.selected, { kind: 'node', id: 'a' });
  assert.equal(s.sandbox.active, true);
  assert.equal(s.sandbox.targetId, 'b');
  assert.ok(s.sandbox.prevented.has('a'));
  assert.deepEqual(s.sandbox.result, { target_id: 'b' });
  assert.equal(GP.isReadOnly(vs), false);
});

test('预览请求失败：未构造帧、未触碰编辑会话（原子）', async () => {
  const fix = editingFixture();
  const vs = GP.createViewStack();

  // 模拟“先取数再入栈”的入口流程：取数 / 投影构造抛错
  async function openPreview() {
    const data = await Promise.reject(new Error('网络失败'));
    GP.enterFrame(vs, { kind: 'proposal', projection: GP.buildProjection(data.graph) },
      GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox));
  }
  await assert.rejects(openPreview, /网络失败/);

  // 栈保持编辑态：工作图、changeset、选中、沙盘原样
  assert.equal(GP.isReadOnly(vs), false);
  assert.equal(vs.checkpoint, null);
  assert.equal(fix.work.nodes.get('a').title, '未提交改名');
  assert.equal(fix.changes.node_updates.length, 1);
  assert.deepEqual(fix.selected, { kind: 'node', id: 'a' });
  assert.equal(fix.sandbox.targetId, 'b');
});

test('预览投影构造失败（字段缺失致整图非法）同样不入栈', () => {
  const fix = editingFixture();
  const vs = GP.createViewStack();
  assert.throws(() => {
    // 先构造投影；抛错则不得 enterFrame
    const p = GP.buildProjection({ nodes: null, edges: null }, { kind: 'merge' });
    GP.enterFrame(vs, { kind: 'merge', projection: p },
      GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox));
  }, /nodes \/ edges/);
  assert.equal(GP.isReadOnly(vs), false);
});

test('历史帧 → 预览帧的嵌套切换：退出先回历史，再退出恢复编辑', () => {
  const fix = editingFixture();
  const vs = GP.createViewStack();
  const snap = GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox);
  GP.enterFrame(vs, { kind: 'history', versionId: 3,
                      projection: GP.buildProjection(sampleGraph(3), { kind: 'history' }) }, snap);
  GP.enterFrame(vs, { kind: 'proposal', id: 7,
                      projection: GP.buildProjection(sampleGraph(3), { kind: 'proposal' }) }, snap);

  let r = GP.exitFrame(vs);
  assert.equal(r.kind, 'readonly');
  assert.equal(r.frame.kind, 'history');
  r = GP.exitFrame(vs);
  assert.equal(r.kind, 'editing');
  assert.equal(GP.isReadOnly(vs), false);
});

test('恢复出的会话与检查点互不共享引用（快照可重复使用）', () => {
  const fix = editingFixture();
  const snap = GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox);
  const s1 = GP.restoreSession(snap);
  s1.work.nodes.get('a').title = '改恢复副本';
  s1.sandbox.prevented.add('c');
  const s2 = GP.restoreSession(snap);
  assert.equal(s2.work.nodes.get('a').title, '未提交改名');
  assert.equal(s2.sandbox.prevented.has('c'), false);
});

test('resetViewStack 后栈为空且检查点清除', () => {
  const vs = GP.createViewStack();
  const fix = editingFixture();
  GP.enterFrame(vs, { kind: 'history', versionId: 1,
                      projection: GP.buildProjection(sampleGraph(1), { kind: 'history' }) },
    GP.captureSession(fix.work, fix.changes, fix.selected, fix.sandbox));
  GP.resetViewStack(vs);
  assert.equal(GP.isReadOnly(vs), false);
  assert.equal(vs.checkpoint, null);
});
