'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../static/projection.js');
const { sampleGraph } = require('./helpers.js');

// ---------- 字段缺失 / 畸形响应：入投影时统一补齐，计算不得抛错或产生 undefined ----------

test('节点缺 id 被拒绝；缺其他字段按默认值补齐（稳定可计算）', () => {
  assert.throws(() => P.make({ nodes: [{ type: 'event', title: '无 id' }], edges: [] }), /缺少 id/);

  const p = P.make({
    nodes: [{ id: 'a' }, { id: 'b' }], // 连 type / title / 位置都没有
    edges: [],
  });
  const a = p.nodes.get('a');
  assert.equal(a.type, 'event');          // 缺省按事件
  assert.equal(a.title, '');
  assert.equal(a.description, '');
  assert.deepEqual([a.pos_x, a.pos_y], [0, 0]);
  assert.equal(a.earliest_time, null);
  assert.equal(a.latest_time, null);
  assert.equal(a.trigger_mode, 'ANY');    // 旧事件快照回填 ANY
  assert.equal(a.reliability, null);
  assert.equal(a.source_group, null);
  // 缺字段图也能完整做时间窗 / 证据 / 反事实 / 下游计算
  assert.doesNotThrow(() => P.computeTimeWindows(p));
  assert.doesNotThrow(() => P.computeEvidenceReview(p));
  assert.doesNotThrow(() => P.computeCounterfactual(p, null, 'a', ['b']));
  assert.doesNotThrow(() => P.downstreamOf(p, null, 'a'));
});

test('非法 type 归一：只有 evidence 被识别，其余按 event', () => {
  const p = P.make({ nodes: [{ id: 'x', type: 'weird' }, { id: 'y', type: 'evidence' }], edges: [] });
  assert.equal(p.nodes.get('x').type, 'event');
  assert.equal(p.nodes.get('x').trigger_mode, 'ANY');
  assert.equal(p.nodes.get('y').type, 'evidence');
  assert.equal(p.nodes.get('y').trigger_mode, null); // 证据节点恒为 null
});

test('trigger_mode 缺失 / 非法：事件回填 ANY，显式 ALL 保留', () => {
  const p = P.make({
    nodes: [
      { id: 'a', type: 'event' },
      { id: 'b', type: 'event', trigger_mode: 'SOMETIMES' },
      { id: 'c', type: 'event', trigger_mode: 'ALL' },
    ],
    edges: [],
  });
  assert.equal(p.nodes.get('a').trigger_mode, 'ANY');
  assert.equal(p.nodes.get('b').trigger_mode, 'ANY');
  assert.equal(p.nodes.get('c').trigger_mode, 'ALL');
});

test('连线缺 id：合成确定性 id；非法 kind 归一为 causes；缺端点安全降级为空串', () => {
  const p = P.make({
    nodes: [{ id: 'a', type: 'event' }, { id: 'b', type: 'event' }, { id: 'c', type: 'evidence' }],
    edges: [
      { source_id: 'a', target_id: 'b' },                       // 缺 id / kind
      { id: 'e1', source_id: 'c', target_id: 'b', kind: 'weird' }, // 非法 kind
      { id: 'e2', source_id: 'a', target_id: 'b', kind: 'causes' }, // 与第一条合成 id 不冲突
    ],
  });
  const ids = [...p.edges.keys()];
  assert.equal(ids.length, 3);
  assert.ok(new Set(ids).size === 3, '合成 id 与显式 id / 彼此不冲突');
  const byPair = [...p.edges.values()];
  assert.equal(byPair[0].kind, 'causes');
  assert.equal(byPair[0].label, '');
  // 稳定顺序：合成 id 的字典序也确定可复现
  const p2 = P.make({
    nodes: [{ id: 'a', type: 'event' }, { id: 'b', type: 'event' }],
    edges: [{ source_id: 'a', target_id: 'b' }],
  });
  assert.deepEqual([...p2.edges.keys()], [...P.make({
    nodes: [{ id: 'a', type: 'event' }, { id: 'b', type: 'event' }],
    edges: [{ source_id: 'a', target_id: 'b' }],
  }).edges.keys()]);
});

test('悬空连线（端点缺失 / 已删除节点）不影响投影构建与时间窗计算', () => {
  const g = sampleGraph();
  g.edges.push({ id: 'e-dangling', source_id: 'ghost', target_id: 'n-loss', kind: 'causes' });
  g.edges.push({ id: 'e-bad-ev', source_id: 'n-code', target_id: 'n-loss', kind: 'supports' });
  const p = P.make({ ...g, source: 'merge' });
  assert.ok(p.edges.has('e-dangling'));
  assert.doesNotThrow(() => P.computeTimeWindows(p));
  // 事件→事件的 supports 非法组合不计入证据聚合
  const rv = P.computeEvidenceReview(p).get('n-loss');
  assert.equal(rv.selected_evidence.length, 0);
});

test('时间字段为空串 / 非字符串时按不限(null)处理，缺数字位置按 0', () => {
  const p = P.make({
    nodes: [{ id: 'a', type: 'event', earliest_time: '', latest_time: 'garbage', pos_x: 'x' }],
    edges: [],
  });
  const a = p.nodes.get('a');
  assert.equal(a.earliest_time, null);
  assert.equal(a.latest_time, null);
  assert.equal(a.pos_x, 0);
});

test('reliability 非数字：证据节点保留 null；数字值原样进入投影（范围由 API 校验）', () => {
  const p = P.make({
    nodes: [
      { id: 'ev1', type: 'evidence', reliability: 0.5 },
      { id: 'ev2', type: 'evidence', reliability: 'oops' },
      { id: 'ev3', type: 'evidence' },
    ],
    edges: [],
  });
  assert.equal(p.nodes.get('ev1').reliability, 0.5);
  assert.equal(p.nodes.get('ev2').reliability, null);
  assert.equal(p.nodes.get('ev3').reliability, null);
});

test('nodes/edges 整体缺失（空响应）返回空投影而非抛错', () => {
  const p = P.make({ version_id: 9 });
  assert.equal(p.nodes.size, 0);
  assert.equal(p.edges.size, 0);
  assert.equal(p.version_id, 9);
  assert.doesNotThrow(() => P.computeTimeWindows(p));
  assert.doesNotThrow(() => P.computeEvidenceReview(p));
});

test('历史版本数据里的旧节点缺 trigger_mode 时沙盘推演仍可运行（默认 ANY）', () => {
  const g = sampleGraph();
  delete g.nodes.find((n) => n.id === 'n-code').trigger_mode;
  const p = P.make({ ...g, source: 'server', version_id: 0 });
  const r = P.computeCounterfactual(p, null, 'n-loss', ['n-code', 'n-config']);
  assert.equal(r.target_status, 'prevented');
});
