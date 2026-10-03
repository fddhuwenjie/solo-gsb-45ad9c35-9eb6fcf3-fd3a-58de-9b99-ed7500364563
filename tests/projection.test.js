'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../static/projection.js');
const { sampleGraph } = require('./helpers.js');

// ---------- 不可变投影基础保证 ----------

test('投影带来源版本、只读标记，节点/连线冻结并按稳定 ID 顺序排列', () => {
  const g = sampleGraph();
  // 故意打乱入参顺序
  g.nodes = [...g.nodes].reverse();
  g.edges = [...g.edges].reverse();
  const p = P.make({ ...g, source: 'server' });

  assert.equal(p.version_id, 1);
  assert.equal(p.source, 'server');
  assert.equal(p.readonly, true);
  assert.deepEqual([...p.nodes.keys()],
    ['e-sre', 'n-code', 'n-config', 'n-loss', 'n-null', 'n-outage']);
  assert.deepEqual([...p.edges.keys()], ['e1', 'e2', 'e3', 'e4', 'e5']);

  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.nodes.get('n-code')));
  assert.throws(() => { p.nodes.get('n-code').title = 'x'; }, TypeError);
  // 只读视图不暴露任何写接口
  assert.equal(typeof p.nodes.set, 'undefined');
  assert.equal(typeof p.nodes.delete, 'undefined');
});

test('work 来源的投影可写标记为 false，其余来源默认只读', () => {
  const g = sampleGraph();
  assert.equal(P.make({ ...g, source: 'work' }).readonly, false);
  for (const source of ['proposal', 'merge', 'node_merge']) {
    assert.equal(P.make({ ...g, source }).readonly, true, source);
  }
});

test('投影是输入的快照副本：调用方之后修改原始数组不影响投影', () => {
  const g = sampleGraph();
  const p = P.make({ ...g, source: 'server' });
  g.nodes[0].title = '被外部改掉';
  g.nodes.push({ id: 'x-late', type: 'event', title: '晚到的节点' });
  assert.equal(p.nodes.has('x-late'), false);
  assert.notEqual(p.nodes.get('n-code').title, '被外部改掉');
});

test('派生计算只接受投影：直接传裸 nodes/edges 会被拒绝', () => {
  const g = sampleGraph();
  const p = P.make({ ...g, source: 'server' });
  const rawNodes = new Map(g.nodes.map((n) => [n.id, n]));
  const rawEdges = new Map(g.edges.map((e) => [e.id, e]));
  assert.throws(() => P.computeTimeWindows(rawNodes, rawEdges), /不可变图投影/);
  assert.throws(() => P.computeEvidenceReview(rawNodes, rawEdges), /不可变图投影/);
  assert.throws(() => P.downstreamOf(rawNodes, rawEdges, 'n-code'), /不可变图投影/);
  assert.throws(() => P.computeCounterfactual(rawNodes, rawEdges, 'n-loss', []), /不可变图投影/);
  // 投影入口正常
  assert.ok(P.computeTimeWindows(p).windows.has('n-null'));
});

test('同投影派生结果被缓存且引用稳定', () => {
  const p = P.make({ ...sampleGraph(), source: 'work' });
  assert.equal(P.computeTimeWindows(p), P.computeTimeWindows(p));
  assert.equal(P.computeEvidenceReview(p), P.computeEvidenceReview(p));
});

// ---------- 派生计算正确性（抽样） ----------

test('时间窗在投影上沿祖先 / 后代传播', () => {
  const p = P.make({ ...sampleGraph(), source: 'server' });
  const { windows } = P.computeTimeWindows(p);
  // n-null 的下界由祖先 n-code(02:00) / n-config(02:01) 中最大者收紧为 02:01
  assert.equal(windows.get('n-null').lower, '2026-09-20T02:01:00Z');
  assert.equal(windows.get('n-null').lowerSrc, 'n-config');
  // n-code 自身 latest 02:05 比后代 02:10 更紧，保持 02:05
  assert.equal(windows.get('n-code').upper, '2026-09-20T02:05:00Z');
  // n-config 无自身上界，由后代 n-null 的 02:10 收紧
  assert.equal(windows.get('n-config').upper, '2026-09-20T02:10:00Z');
});

test('证据审查在投影上聚合，证据节点字段缺失按默认值', () => {
  const g = sampleGraph();
  g.nodes.push({ id: 'e-anon', type: 'evidence', title: '匿名证据' }); // 缺 reliability/source_group
  g.edges.push({ id: 'e6', source_id: 'e-anon', target_id: 'n-loss', kind: 'supports' });
  const p = P.make({ ...g, source: 'server' });
  const rv = P.computeEvidenceReview(p).get('n-loss');
  assert.equal(rv.status, 'insufficient'); // reliability 缺省按 0 计权
  const outage = P.computeEvidenceReview(p).get('n-outage');
  assert.equal(outage.support_score, 0.9);
  assert.equal(outage.status, 'supported');
});

test('反事实推演只接受投影并返回稳定 ID 顺序', () => {
  const p = P.make({ ...sampleGraph(), source: 'server' });
  // 阻止 n-config：n-null 是 ALL 门（需要 n-code 与 n-config 同时发生），应被阻止
  let r = P.computeCounterfactual(p, null, 'n-loss', ['n-config']);
  assert.equal(r.target_status, 'prevented');
  // 同时阻止两个前因 → ALL 门阻止（依据树取 ID 最小的已阻止前因 n-code）→ 沿链全部阻止
  r = P.computeCounterfactual(p, null, 'n-loss', ['n-config', 'n-code']);
  assert.equal(r.target_status, 'prevented');
  assert.deepEqual(r.intervened_ids, ['n-code', 'n-config']);
  assert.deepEqual(r.tree_edge_ids, ['e1', 'e3', 'e4']);
});

test('下游高亮在投影上 BFS 并稳定排序', () => {
  const p = P.make({ ...sampleGraph(), source: 'server' });
  const d = P.downstreamOf(p, null, 'n-null');
  assert.deepEqual(d.affected_node_ids, ['n-loss', 'n-outage']);
  assert.deepEqual(d.edges.map((x) => x.id), ['e3', 'e4']);
  // 证据边入向不计入事件下游；从证据节点出发则沿 supports 到达事件
  const d2 = P.downstreamOf(p, null, 'e-sre');
  assert.deepEqual(d2.affected_node_ids, ['n-loss', 'n-outage']);
});
