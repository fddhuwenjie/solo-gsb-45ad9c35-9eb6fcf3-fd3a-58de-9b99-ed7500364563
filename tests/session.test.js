'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleGraph } = require('./helpers.js');
const { Driver } = require('./driver.js');

// ---------- 历史切换：未提交修改与选中项不得污染历史视图 ----------

test('历史切换：带未提交 changeset 进入历史快照，历史投影不含任何未提交修改', () => {
  const d = new Driver(sampleGraph());
  d.select('n-loss');
  d.updateNode('n-loss', { title: '本地改的标题' });
  d.addNode({ id: 'ev-local', type: 'event', title: '本地新建', pos_x: 1, pos_y: 2,
              earliest_time: null, latest_time: null, reliability: null,
              source_group: null, trigger_mode: 'ANY' });
  assert.equal(d.changeCount, 2);

  const v0Graph = sampleGraph();  // v0 内容（与当前版相同结构即可，模拟 /api/versions/1 响应）
  v0Graph.version_id = 1;
  d.enterHistory(v0Graph, 1);

  assert.equal(d.isReadOnly, true);
  assert.equal(d.projection.source, 'server');
  assert.equal(d.projection.readonly, true);
  assert.equal(d.projection.version_id, 1);
  assert.equal(d.projection.nodes.has('ev-local'), false);
  assert.equal(d.projection.nodes.get('n-loss').title, '订单损失'); // 历史原值，无本地改名
  assert.equal(d.viewingVersion, 1);
  assert.equal(d.selected, null);
  // 编辑会话被原子保存
  assert.ok(d.roSession);
  assert.equal(d.roSession.changes.node_updates.length, 1);
});

test('历史视图上的时间窗 / 证据 / 沙盘只基于历史投影，且不可写回工作图', () => {
  const d = new Driver(sampleGraph());
  d.updateNode('n-loss', { title: '脏改名' });

  // 构造一个「历史版本」：多一个已在后来删除的节点 n-old
  const old = sampleGraph();
  old.nodes.push({ id: 'n-old', type: 'event', title: '已删除的旧事件',
                   earliest_time: '2026-09-20T01:00:00Z', latest_time: null });
  old.edges.push({ id: 'e-old', source_id: 'n-old', target_id: 'n-code', kind: 'causes' });
  old.version_id = 7;
  d.enterHistory(old, 7);

  assert.ok(d.projection.nodes.has('n-old'));
  // n-code 自身下界 02:00 比祖先 n-old 的 01:00 更紧，保持 02:00；新增旧节点不改变其他传播
  const { windows } = d.windows();
  assert.equal(windows.get('n-null').lower, '2026-09-20T02:01:00Z');
  assert.equal(windows.get('n-code').lower, '2026-09-20T02:00:00Z');
  // 反事实也在历史投影上推演，带来源版本
  const r = d.counterfactual('n-old', []);
  assert.equal(r.version_id, 7);
  assert.throws(() => d.updateNode('n-old', { title: '试图改历史' }), /只读/);
  // 工作图草稿仍是历史进入前的样子（含未提交改名）
  assert.equal(d.work.nodes.get('n-loss').title, '脏改名');
});

test('返回当前版：原子恢复工作图、未提交 changeset、选中项与沙盘状态', () => {
  const d = new Driver(sampleGraph());
  d.select('n-code');
  d.updateNode('n-code', { pos_x: 999 });
  d.sandbox.active = true;
  d.sandbox.targetId = 'n-loss';
  d.sandbox.prevented = new Set(['n-config']);
  const before = d.snapshotState();

  d.enterHistory(sampleGraph(), 1);
  // 历史视图里乱点一通：选中、推演（这些只作用于只读投影 / 临时沙盘）
  d.select('n-outage');
  assert.equal(d.selected.id, 'n-outage');

  assert.equal(d.exitReadOnly(), true);
  const after = d.snapshotState();

  assert.equal(d.isReadOnly, false);
  assert.equal(d.projection.source, 'work');
  assert.equal(d.viewingVersion, null);
  assert.equal(d.roSession, null);
  assert.equal(after.nodeIds.length, before.nodeIds.length);
  assert.equal(after.changeCount, 1);
  assert.deepEqual(after.selected, { kind: 'node', id: 'n-code' });
  assert.equal(after.sandbox.targetId, 'n-loss');
  assert.deepEqual(after.sandbox.prevented, ['n-config']);
  // 工作投影反映未提交编辑
  assert.equal(d.projection.nodes.get('n-code').pos_x, 999);
});

test('重复返回是幂等空操作；未进入只读视图时退出返回 false', () => {
  const d = new Driver(sampleGraph());
  assert.equal(d.exitReadOnly(), false);
  d.enterHistory(sampleGraph(), 1);
  assert.equal(d.exitReadOnly(), true);
  assert.equal(d.exitReadOnly(), false);
});

// ---------- 三类预览：提案 / 合并 / 归并 ----------

function proposalPreviewGraph() {
  // 「基线 + 提案」预览图：改了 n-loss 标题、新增一个证据
  const g = sampleGraph();
  g.nodes = g.nodes.map((n) => n.id === 'n-loss' ? { ...n, title: '订单损失(提案改)' } : n);
  g.nodes.push({ id: 'ev-pp', type: 'evidence', title: '提案新证据', reliability: 0.8 });
  g.edges.push({ id: 'e-pp', source_id: 'ev-pp', target_id: 'n-loss', kind: 'supports' });
  return g;
}

test('提案预览：只读投影（source=proposal），退出后工作图 / changeset 原样', () => {
  const d = new Driver(sampleGraph());
  d.updateNode('n-outage', { title: '我的未提交改动' });
  const before = d.snapshotState();

  d.enterPreview(proposalPreviewGraph(), 'proposal');
  assert.equal(d.projection.source, 'proposal');
  assert.equal(d.projection.readonly, true);
  assert.equal(d.projection.nodes.get('n-loss').title, '订单损失(提案改)');
  assert.ok(d.projection.nodes.has('ev-pp'));
  // 未提交改动不在预览图里
  assert.equal(d.projection.nodes.get('n-outage').title, '服务中断');
  // 预览图上的派生计算正常
  const rv = d.review('n-loss');
  assert.equal(rv.support_score, 0.8);

  d.exitReadOnly();
  assert.deepEqual(d.snapshotState(), before);
  assert.equal(d.work.nodes.get('n-outage').title, '我的未提交改动');
  assert.equal(d.changeCount, 1);
});

test('合并预览：source=merge，反复刷新预览不覆盖保存的编辑会话', () => {
  const d = new Driver(sampleGraph());
  d.updateNode('n-loss', { pos_x: 1 });
  const g1 = proposalPreviewGraph();
  d.enterPreview(g1, 'merge');
  const firstSession = d.roSession;

  // 模拟「按裁决刷新预览」：再次 enterPreview（roSession 已存在，不应被覆盖）
  const g2 = proposalPreviewGraph();
  g2.nodes = g2.nodes.map((n) => n.id === 'n-loss' ? { ...n, title: '订单损失(裁决后)' } : n);
  d.enterPreview(g2, 'merge');
  assert.equal(d.roSession, firstSession);
  assert.equal(d.projection.nodes.get('n-loss').title, '订单损失(裁决后)');

  d.exitReadOnly();
  assert.equal(d.changeCount, 1);
  assert.equal(d.projection.nodes.get('n-loss').pos_x, 1);
});

test('归并预览：source=node_merge，预览图节点更少但工作图不丢节点', () => {
  const d = new Driver(sampleGraph());
  const merged = sampleGraph();
  // 归并预览：n-config 并入 n-code（预览图删除 n-config 与边 e2）
  merged.nodes = merged.nodes.filter((n) => n.id !== 'n-config');
  merged.edges = merged.edges.filter((e) => e.id !== 'e2');

  d.enterPreview(merged, 'node_merge');
  assert.equal(d.projection.source, 'node_merge');
  assert.equal(d.projection.readonly, true);
  assert.equal(d.projection.nodes.has('n-config'), false);
  assert.equal(d.projection.edges.has('e2'), false);
  // 工作图草稿不受影响
  assert.ok(d.work.nodes.has('n-config'));
  assert.ok(d.work.edges.has('e2'));

  d.exitReadOnly();
  assert.ok(d.projection.nodes.has('n-config'));
  assert.ok(d.projection.edges.has('e2'));
});

test('预览内的反事实 / 下游高亮只基于预览投影', () => {
  const d = new Driver(sampleGraph());
  const merged = sampleGraph();
  merged.nodes = merged.nodes.filter((n) => n.id !== 'n-config');
  merged.edges = merged.edges.filter((e) => e.id !== 'e2');
  d.enterPreview(merged, 'node_merge');
  // 预览中 n-null 失去 ALL 的一个前因
  const r = d.counterfactual('n-loss', ['n-code']);
  assert.equal(r.target_status, 'prevented');
  assert.ok(!r.intervened_ids.includes('n-config'));
  const impact = d.downstream('n-null');
  assert.deepEqual(impact.affected_node_ids, ['n-loss', 'n-outage']);
});

// ---------- 请求失败：任何状态都不得改变 ----------

test('历史快照请求失败：工作图、changeset、选中项与沙盘全部保持原状', () => {
  const d = new Driver(sampleGraph());
  d.select('n-loss');
  d.updateNode('n-loss', { title: '失败前的改动' });
  const before = d.snapshotState();

  assert.throws(() => d.simulatePreviewRequestFailure(null, 'server', 'network'), /网络错误/);
  assert.deepEqual(d.snapshotState(), before);
  assert.equal(d.isReadOnly, false);
  assert.equal(d.roSession, null);
  assert.equal(d.projection.source, 'work');
});

test('预览请求失败：不会进入只读态，未提交 changeset 与沙盘不变', () => {
  const d = new Driver(sampleGraph());
  d.sandbox.active = true;
  d.sandbox.targetId = 'n-outage';
  d.addNode({ id: 'ev-x', type: 'evidence', title: '草稿证据', pos_x: 0, pos_y: 0 });
  const before = d.snapshotState();

  assert.throws(() => d.simulatePreviewRequestFailure(null, 'proposal', 'network'), /网络错误/);
  assert.deepEqual(d.snapshotState(), before);
  assert.equal(d.preview, null);
  assert.ok(d.projection.nodes.has('ev-x'));
});

test('预览失败后可直接重试并成功，退出仍恢复到进入前现场', () => {
  const d = new Driver(sampleGraph());
  d.updateNode('n-code', { pos_x: 42 });
  assert.throws(() => d.simulatePreviewRequestFailure(null, 'merge', 'network'));
  d.enterPreview(proposalPreviewGraph(), 'merge');
  d.exitReadOnly();
  assert.equal(d.changeCount, 1);
  assert.equal(d.projection.nodes.get('n-code').pos_x, 42);
});
