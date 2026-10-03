/* 不可变图投影层（Graph Projection）
 *
 * 所有「画布上正在看的图」都必须先变成一个投影：
 *   - 服务端快照（当前版 / 历史版本 / 提案预览 / 三方合并预览 / 重复事件归并预览）
 *   - 或「已提交当前版 + 本地未提交 changeset」的重放结果
 *
 * 投影带来源版本（meta.sourceVersion）、只读标记（meta.readOnly）与稳定 ID 顺序；
 * 节点 / 连线对象、承载它们的 Map 以及投影本身全部 Object.freeze，任何下游
 * （时间窗、证据审查、反事实沙盘、下游高亮）只能通过 requireProjection 拿到的
 * 投影计算，禁止直接拿散装 nodes/edges 重算，也不可能把预览写回工作图。
 *
 * 本文件不依赖 DOM，可同时被浏览器（window.GraphProjection）与 Node 回归测试引用。
 */
'use strict';

(function (root, factory) {
  const api = factory();
  root.GraphProjection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const PROJECTION = Symbol('graphProjection');
  const DISPUTE_MIN = 0.6, STRENGTH_MIN = 0.7, REV_EPS = 1e-12;

  function emptyChangeset() {
    return { node_creates: [], node_updates: [], node_deletes: [],
             edge_creates: [], edge_updates: [], edge_deletes: [] };
  }

  // ---------- 规范化与稳定排序 ----------

  /** 规范化节点：旧快照可能缺字段或没有 trigger_mode，按类型补默认值。 */
  function normalizeNode(n) {
    if (n.type === 'event'
        && n.trigger_mode !== 'ANY' && n.trigger_mode !== 'ALL') n.trigger_mode = 'ANY';
    if (n.type === 'evidence' && n.trigger_mode === undefined) n.trigger_mode = null;
    if (n.description === undefined || n.description === null) n.description = '';
    if (n.pos_x === undefined || n.pos_x === null) n.pos_x = 0;
    if (n.pos_y === undefined || n.pos_y === null) n.pos_y = 0;
    if (n.earliest_time === undefined) n.earliest_time = null;
    if (n.latest_time === undefined) n.latest_time = null;
    if (n.reliability === undefined) n.reliability = null;
    if (n.source_group === undefined) n.source_group = null;
    if (n.created_at === undefined) n.created_at = '';
    return n;
  }

  function normalizeEdge(e) {
    if (e.label === undefined || e.label === null) e.label = '';
    if (e.created_at === undefined) e.created_at = '';
    return e;
  }

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** 结构不完整（字段缺失）的节点 / 连线不进入投影，由 meta.dropped 计数。 */
  function validNode(n, nodeIds) {
    return n && typeof n === 'object'
      && typeof n.id === 'string' && n.id
      && (n.type === 'event' || n.type === 'evidence')
      && !nodeIds.has(n.id);
  }
  function validEdge(e, nodeIds, edgeIds) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || edgeIds.has(e.id)) return false;
    if (e.kind !== 'causes' && e.kind !== 'supports' && e.kind !== 'refutes') return false;
    if (typeof e.source_id !== 'string' || typeof e.target_id !== 'string') return false;
    // 悬空端点的连线一并丢弃，保证下游计算永远不遇到 undefined 端点
    return nodeIds.has(e.source_id) && nodeIds.has(e.target_id);
  }

  /** 把任意来源的整图 JSON 变成只读、稳定 ID 顺序的不可变投影。 */
  function buildProjection(graph, meta = {}) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('投影数据不完整：缺少 nodes / edges 列表');
    }
    const dropped = { nodes: 0, edges: 0 };
    const nodeIds = new Set();
    const nodes = [];
    for (const raw of graph.nodes) {
      if (!validNode(raw, nodeIds)) { dropped.nodes++; continue; }
      const n = normalizeNode(structuredClone(raw));
      nodeIds.add(n.id);
      nodes.push(n);
    }
    nodes.sort(byId);

    const edgeIds = new Set();
    const edges = [];
    for (const raw of graph.edges) {
      if (!validEdge(raw, nodeIds, edgeIds)) { dropped.edges++; continue; }
      edges.push(normalizeEdge(structuredClone(raw)));
      edgeIds.add(raw.id);
    }
    edges.sort(byId);

    // Object.freeze 管不住 Map 内部槽：用自有只读方法遮蔽原型上的变更方法，
    // 再 freeze，使 set/delete/clear 在严格模式下抛 TypeError。
    const readOnly = (m) => {
      m.set = m.delete = m.clear = function () {
        throw new TypeError('不可变图投影：节点 / 连线集合为只读');
      };
      return m;
    };
    const nodeMap = readOnly(new Map(nodes.map((n) => [n.id, n])));
    const edgeMap = readOnly(new Map(edges.map((e) => [e.id, e])));
    const projection = {
      [PROJECTION]: true,
      version_id: graph.version_id ?? meta.sourceVersion ?? null,
      nodes: nodeMap,
      edges: edgeMap,
      nodeOrder: Object.freeze(nodes.map((n) => n.id)),
      edgeOrder: Object.freeze(edges.map((e) => e.id)),
      meta: Object.freeze({
        source: meta.source || 'server',       // server | changeset
        sourceVersion: graph.version_id ?? meta.sourceVersion ?? null,
        readOnly: meta.readOnly !== false,     // 默认只读；编辑工作投影显式传 false
        kind: meta.kind || null,               // history | proposal | merge | node_merge | editing
        dropped: Object.freeze(dropped),
        ...(meta.label !== undefined ? { label: meta.label } : {}),
      }),
    };
    for (const n of nodes) Object.freeze(n);
    for (const e of edges) Object.freeze(e);
    // 冻结 Map / Set 后 set()/delete()/add() 在严格模式下直接抛 TypeError
    Object.freeze(projection.nodes);
    Object.freeze(projection.edges);
    Object.freeze(projection);
    return projection;
  }

  /** 只接受投影：时间窗 / 证据审查 / 反事实 / 下游高亮的唯一入口校验。 */
  function requireProjection(p) {
    if (!p || p[PROJECTION] !== true) {
      throw new Error('该计算只接受不可变图投影（GraphProjection）');
    }
    return p;
  }

  // ---------- changeset 重放（纯函数，不触碰入参） ----------

  function newNodeFromCreate(c) {
    return normalizeNode({
      id: c.id,
      type: c.type,
      title: c.title ?? '',
      description: c.description ?? '',
      pos_x: c.pos_x ?? 0,
      pos_y: c.pos_y ?? 0,
      created_at: '',
      earliest_time: c.earliest_time ?? null,
      latest_time: c.latest_time ?? null,
      reliability: c.type === 'evidence' ? (c.reliability ?? null) : null,
      source_group: c.type === 'evidence' ? (c.source_group ?? null) : null,
      trigger_mode: c.type === 'event'
        ? (c.trigger_mode === 'ALL' ? 'ALL' : 'ANY') : null,
    });
  }

  function newEdgeFromCreate(c) {
    return normalizeEdge({
      id: c.id, source_id: c.source_id, target_id: c.target_id,
      kind: c.kind, label: c.label ?? '', created_at: '',
    });
  }

  /**
   * 把 changeset 应用到一张基线整图（{version_id, nodes:[], edges:[]}）。
   * 顺序与后端 graph.apply_changes 一致：
   *   删节点（级联删边）→ 删边 → 更新节点 → 建节点 → 更新边 → 建边。
   * 任何引用缺失都抛错（调用方据此中止，绝不半应用）。
   */
  function applyChangeset(baseGraph, changes) {
    if (!baseGraph || !Array.isArray(baseGraph.nodes) || !Array.isArray(baseGraph.edges)) {
      throw new Error('基线图数据不完整');
    }
    const ch = changes || emptyChangeset();
    const nodes = new Map(baseGraph.nodes.map((n) => [n.id, normalizeNode(structuredClone(n))]));
    const edges = new Map(baseGraph.edges.map((e) => [e.id, normalizeEdge(structuredClone(e))]));

    const nodeDeletes = new Set(ch.node_deletes || []);
    const edgeDeletes = new Set(ch.edge_deletes || []);

    // 1. 删节点（含级联边）
    const cascadedEdges = new Set();
    for (const id of nodeDeletes) {
      if (!nodes.has(id)) throw new Error(`变更引用了不存在的节点：${id}`);
      nodes.delete(id);
      for (const [eid, e] of Array.from(edges)) {
        if (e.source_id === id || e.target_id === id) { edges.delete(eid); cascadedEdges.add(eid); }
      }
    }
    // 2. 删边（节点级联删除可能已带走其中一部分：忽略级联带走的 id）
    for (const id of edgeDeletes) {
      if (!edges.has(id)) {
        if (!cascadedEdges.has(id)) throw new Error(`变更引用了不存在的连线：${id}`);
        continue;
      }
      edges.delete(id);
    }
    // 3. 更新节点（显式 null 也原样写入，与后端 fields_set 语义一致）
    for (const u of ch.node_updates || []) {
      const n = nodes.get(u.id);
      if (!n) throw new Error(`变更引用了不存在的节点：${u.id}`);
      const cur = normalizeNode(n);
      for (const [k, v] of Object.entries(u)) {
        if (k === 'id' || k === '_fields_set') continue;
        cur[k] = v;
      }
      nodes.set(u.id, normalizeNode(cur));
    }
    // 4. 建节点
    for (const c of ch.node_creates || []) {
      if (nodes.has(c.id)) throw new Error(`新建节点 id 与既有节点重复：${c.id}`);
      nodes.set(c.id, newNodeFromCreate(c));
    }
    // 5. 更新边（仅写字段）
    for (const u of ch.edge_updates || []) {
      const e = edges.get(u.id);
      if (!e) throw new Error(`变更引用了不存在的连线：${u.id}`);
      const cur = normalizeEdge(structuredClone(e));
      for (const [k, v] of Object.entries(u)) {
        if (k === 'id' || k === '_fields_set') continue;
        cur[k] = v;
      }
      edges.set(u.id, normalizeEdge(cur));
    }
    // 6. 建边
    for (const c of ch.edge_creates || []) {
      if (edges.has(c.id)) throw new Error(`新建连线 id 与既有连线重复：${c.id}`);
      if (!nodes.has(c.source_id) || !nodes.has(c.target_id)) {
        throw new Error(`新建连线端点不存在：${c.id}`);
      }
      edges.set(c.id, newEdgeFromCreate(c));
    }

    const out = {
      version_id: baseGraph.version_id ?? null,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    };
    out.nodes.sort(byId);
    out.edges.sort(byId);
    return out;
  }

  /** 已提交服务端快照 + 本地 changeset → 可编辑（非只读）工作投影。 */
  function projectionFromChangeset(serverGraph, changes) {
    const graph = applyChangeset(serverGraph, changes);
    return buildProjection(graph, {
      source: 'changeset',
      sourceVersion: serverGraph?.version_id ?? null,
      readOnly: false,
      kind: 'editing',
    });
  }

  // ---------- 时间窗传播（与后端 graph.compute_time_windows 同构） ----------

  function computeTimeWindows(nodes, edges) {
    const events = [...nodes.values()].filter((n) => n.type === 'event').map((n) => n.id);
    const evSet = new Set(events);
    const adj = new Map(events.map((id) => [id, []]));
    const radj = new Map(events.map((id) => [id, []]));
    const pairEdge = new Map();
    const indeg = new Map(events.map((id) => [id, 0]));
    for (const e of edges.values()) {
      if (e.kind !== 'causes' || !evSet.has(e.source_id) || !evSet.has(e.target_id)) continue;
      adj.get(e.source_id).push(e.target_id);
      radj.get(e.target_id).push(e.source_id);
      indeg.set(e.target_id, indeg.get(e.target_id) + 1);
      pairEdge.set(`${e.source_id}->${e.target_id}`, e.id);
    }
    const q0 = events.filter((id) => indeg.get(id) === 0);
    const topo = [];
    while (q0.length) {
      const u = q0.shift(); topo.push(u);
      for (const v of adj.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) q0.push(v);
      }
    }
    const hasCycle = topo.length !== events.length;

    const lb = new Map(), lbSrc = new Map(), lbPath = new Map();
    for (const id of topo) {
      const t = nodes.get(id).earliest_time || null;
      lb.set(id, t); lbSrc.set(id, t ? id : null); lbPath.set(id, t ? [id] : []);
    }
    for (const u of topo) {
      if (!lb.get(u)) continue;
      for (const v of adj.get(u)) {
        if (lb.get(v) == null || lb.get(u) > lb.get(v)) {
          lb.set(v, lb.get(u)); lbSrc.set(v, lbSrc.get(u));
          lbPath.set(v, [...lbPath.get(u), v]);
        }
      }
    }
    const ub = new Map(), ubSrc = new Map(), ubPath = new Map();
    for (const id of topo) {
      const t = nodes.get(id).latest_time || null;
      ub.set(id, t); ubSrc.set(id, t ? id : null); ubPath.set(id, t ? [id] : []);
    }
    for (let i = topo.length - 1; i >= 0; i--) {
      const v = topo[i];
      if (!ub.get(v)) continue;
      for (const u of radj.get(v)) {
        if (ub.get(u) == null || ub.get(v) < ub.get(u)) {
          ub.set(u, ub.get(v)); ubSrc.set(u, ubSrc.get(v));
          ubPath.set(u, [u, ...ubPath.get(v)]);
        }
      }
    }

    const windows = new Map();
    let conflict = null;
    for (const id of topo) {
      windows.set(id, {
        lower: lb.get(id), upper: ub.get(id),
        lowerSrc: lbSrc.get(id), upperSrc: ubSrc.get(id),
        lowerChain: lbPath.get(id), upperChain: ubPath.get(id),
      });
      if (!conflict && lb.get(id) != null && ub.get(id) != null && lb.get(id) > ub.get(id)) {
        const chain = [];
        for (const x of [...lbPath.get(id), ...ubPath.get(id)]) if (!chain.includes(x)) chain.push(x);
        const chainEdges = [];
        for (let k = 0; k < chain.length - 1; k++) {
          const eid = pairEdge.get(`${chain[k]}->${chain[k + 1]}`);
          if (eid) chainEdges.push(eid);
        }
        conflict = {
          node_id: id, lower_bound: lb.get(id), upper_bound: ub.get(id),
          lower_node_id: lbSrc.get(id), upper_node_id: ubSrc.get(id),
          chain_node_ids: chain, chain_edge_ids: chainEdges,
        };
      }
    }
    return { windows, conflict, hasCycle };
  }

  // ---------- 证据强度审查（与后端 graph.compute_evidence_review 同构） ----------

  function computeEvidenceReview(nodes, edges) {
    const buckets = new Map();
    for (const e of edges.values()) {
      if (e.kind !== 'supports' && e.kind !== 'refutes') continue;
      const ev = nodes.get(e.source_id), event = nodes.get(e.target_id);
      if (!ev || !event || ev.type !== 'evidence' || event.type !== 'event') continue;
      if (!buckets.has(event.id)) buckets.set(event.id, { supports: new Map(), refutes: new Map() });
      const gm = buckets.get(event.id)[e.kind];
      const key = ev.source_group || { independent: ev.id };
      if (!gm.has(key)) gm.set(key, []);
      gm.get(key).push({
        node_id: ev.id, edge_id: e.id, title: ev.title,
        reliability: ev.reliability ?? 0,
        reliability_set: ev.reliability != null,
        source_group: ev.source_group || null,
      });
    }
    const agg = (ws) => Math.round((1 - ws.reduce((v, r) => v * (1 - r), 1)) * 10000) / 10000;
    const reviews = new Map();
    for (const n of nodes.values()) {
      if (n.type !== 'event') continue;
      const dirMap = buckets.get(n.id);
      const groups = [], sWs = [], rWs = [];
      if (dirMap) {
        for (const direction of ['supports', 'refutes']) {
          const gm = dirMap[direction];
          const namedKeys = [...gm.keys()].filter((k) => typeof k === 'string').sort();
          const indepKeys = [...gm.keys()].filter((k) => typeof k === 'object')
            .sort((a, b) => (a.independent < b.independent ? -1 : a.independent > b.independent ? 1 : 0));
          for (const key of [...namedKeys, ...indepKeys]) {
            const entries = gm.get(key);
            const winner = entries.reduce((a, b) =>
              (b.reliability > a.reliability
                || (b.reliability === a.reliability && b.node_id < a.node_id)) ? b : a);
            const dropped = entries.filter((x) => x.edge_id !== winner.edge_id);
            (direction === 'supports' ? sWs : rWs).push(winner.reliability);
            groups.push({ group: winner.source_group, direction, selected: winner, unweighted: dropped });
          }
        }
      }
      const s = agg(sWs), r = agg(rWs);
      const status = (s >= DISPUTE_MIN - REV_EPS && r >= DISPUTE_MIN - REV_EPS) ? 'disputed'
        : s >= STRENGTH_MIN - REV_EPS ? 'supported'
        : r >= STRENGTH_MIN - REV_EPS ? 'refuted' : 'insufficient';
      reviews.set(n.id, {
        support_score: s, refute_score: r, status, groups,
        selected_evidence: groups.map((g) => g.selected),
        unweighted_evidence: groups.flatMap((g) =>
          g.unweighted.map((x) => ({ ...x, reason: 'same_source', group: g.group, direction: g.direction }))),
      });
    }
    return reviews;
  }

  // ---------- 反事实拓扑推演（与后端 graph.simulate_counterfactual 同构） ----------

  function computeCounterfactual(projection, targetId, preventedIds) {
    const nodes = requireProjection(projection).nodes;
    const edges = projection.edges;
    const events = new Set([...nodes.values()].filter((n) => n.type === 'event').map((n) => n.id));
    const target = nodes.get(targetId);
    if (!target) throw new Error(`观察目标不存在：${targetId}`);
    if (target.type !== 'event') throw new Error('观察目标必须是事件节点');
    const preventedSet = new Set(preventedIds);
    for (const pid of preventedSet) {
      const n = nodes.get(pid);
      if (!n) throw new Error(`被阻止事件不存在：${pid}`);
      if (n.type !== 'event') throw new Error(`被阻止节点必须是事件：${pid}`);
    }

    const parents = new Map([...events].map((id) => [id, []]));
    const parentEdge = new Map();
    for (const e of edges.values()) {
      if (e.kind !== 'causes' || !events.has(e.source_id) || !events.has(e.target_id)) continue;
      parents.get(e.target_id).push(e.source_id);
      parentEdge.set(`${e.source_id}->${e.target_id}`, e.id);
    }
    for (const arr of parents.values()) arr.sort();

    const children = new Map([...events].map((id) => [id, []]));
    const indeg = new Map();
    for (const [v, ps] of parents) {
      indeg.set(v, ps.length);
      for (const u of ps) children.get(u).push(v);
    }
    for (const arr of children.values()) arr.sort();
    const q = [...events].filter((id) => indeg.get(id) === 0).sort();
    const topo = [];
    while (q.length) {
      const u = q.shift(); topo.push(u);
      for (const v of children.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) q.push(v);
      }
    }
    if (topo.length !== events.size) throw new Error('因果图存在环，无法按拓扑顺序推演');

    const intervened = new Set(preventedSet);
    const status = new Map(), reason = new Map();
    for (const id of topo) {
      if (intervened.has(id)) { status.set(id, 'prevented'); reason.set(id, 'intervention'); continue; }
      const ps = parents.get(id);
      if (!ps.length) { status.set(id, 'still_active'); reason.set(id, 'no_causes'); continue; }
      const mode = nodes.get(id).trigger_mode === 'ALL' ? 'ALL' : 'ANY';
      const active = ps.filter((p) => status.get(p) === 'still_active');
      const blocked = ps.filter((p) => status.get(p) === 'prevented');
      if (mode === 'ANY') {
        if (active.length) { status.set(id, 'still_active'); reason.set(id, 'any_active'); }
        else { status.set(id, 'prevented'); reason.set(id, 'all_prevented'); }
      } else {
        if (!blocked.length) { status.set(id, 'still_active'); reason.set(id, 'all_active'); }
        else { status.set(id, 'prevented'); reason.set(id, 'some_prevented'); }
      }
    }

    const treeEdgeIds = new Set();
    const buildTree = (id) => {
      const out = {
        node_id: id, title: nodes.get(id).title,
        trigger_mode: nodes.get(id).trigger_mode === 'ALL' ? 'ALL' : 'ANY',
        status: status.get(id), reason: reason.get(id), children: [],
      };
      const ps = parents.get(id);
      if (reason.get(id) === 'intervention' || !ps.length) return out;
      const active = ps.filter((p) => status.get(p) === 'still_active');
      const blocked = ps.filter((p) => status.get(p) === 'prevented');
      let childIds;
      if (reason.get(id) === 'any_active') childIds = [active[0]];
      else if (reason.get(id) === 'all_active') childIds = ps;
      else if (reason.get(id) === 'all_prevented') childIds = ps;
      else childIds = [blocked[0]];
      for (const p of childIds) {
        const eid = parentEdge.get(`${p}->${id}`);
        if (eid) treeEdgeIds.add(eid);
        out.children.push(buildTree(p));
      }
      return out;
    };

    const evSorted = [...events].sort();
    return {
      target_id: targetId,
      target_title: target.title,
      target_status: status.get(targetId),
      version_id: projection.meta.sourceVersion,
      intervened_ids: [...intervened].sort(),
      prevented_ids: evSorted.filter((id) => status.get(id) === 'prevented'),
      still_active_ids: evSorted.filter((id) => status.get(id) === 'still_active'),
      events: evSorted.map((id) => ({
        node_id: id, title: nodes.get(id).title,
        trigger_mode: nodes.get(id).trigger_mode === 'ALL' ? 'ALL' : 'ANY',
        status: status.get(id), reason: reason.get(id),
        intervened: intervened.has(id),
      })),
      tree: buildTree(targetId),
      tree_edge_ids: [...treeEdgeIds].sort(),
    };
  }

  /** 沿所有出边 BFS（供只读图 / 脏工作图本地高亮，与服务端下游接口同构）。 */
  function downstream(projection, nodeId) {
    const p = requireProjection(projection);
    if (!p.nodes.has(nodeId)) throw new Error(`节点不存在：${nodeId}`);
    const out = new Map();
    for (const e of p.edges.values()) {
      if (!out.has(e.source_id)) out.set(e.source_id, []);
      out.get(e.source_id).push(e);
    }
    const depth = new Map([[nodeId, 0]]);
    const q = [nodeId];
    const edgeIds = new Set();
    while (q.length) {
      const u = q.shift();
      for (const e of out.get(u) || []) {
        edgeIds.add(e.id);
        if (!depth.has(e.target_id)) { depth.set(e.target_id, depth.get(u) + 1); q.push(e.target_id); }
      }
    }
    return { depth, edgeIds };
  }

  // ---------- 派生结果缓存（同一投影实例只算一次；新投影自然失效） ----------

  const derivedCache = new WeakMap();

  function derived(projection) {
    const p = requireProjection(projection);
    let d = derivedCache.get(p);
    if (!d) {
      d = {
        time: computeTimeWindows(p.nodes, p.edges),
        reviews: computeEvidenceReview(p.nodes, p.edges),
      };
      derivedCache.set(p, d);
    }
    return d;
  }

  const timeWindows = (p) => derived(p).time;
  const evidenceReviews = (p) => derived(p).reviews;

  // ---------- 工作图 / 会话快照（Map 形态，供编辑态与只读帧切换使用） ----------

  function toMapGraph(graph) {
    return {
      version_id: graph.version_id ?? null,
      nodes: new Map((graph.nodes || []).map((n) => [n.id, normalizeNode(structuredClone(n))])),
      edges: new Map((graph.edges || []).map((e) => [e.id, normalizeEdge(structuredClone(e))])),
    };
  }

  function toPlainGraph(mapGraph) {
    return {
      version_id: mapGraph.version_id ?? null,
      nodes: [...mapGraph.nodes.values()].map((n) => structuredClone(n)).sort(byId),
      edges: [...mapGraph.edges.values()].map((e) => structuredClone(e)).sort(byId),
    };
  }

  /** 捕获一份可原样恢复的编辑会话（工作图 / changeset / 选中项 / 沙盘）。 */
  function captureSession(work, changes, selected, sandbox) {
    return {
      work: toPlainGraph(work),
      changes: structuredClone(changes || emptyChangeset()),
      selected: selected ? structuredClone(selected) : null,
      sandbox: structuredClone(sandbox || freshSandbox()),
    };
  }

  /** 从快照恢复编辑会话（再克隆一次，保证快照可重复使用且互不共享引用）。 */
  function restoreSession(snapshot) {
    return {
      work: toMapGraph(structuredClone(snapshot.work)),
      changes: structuredClone(snapshot.changes),
      selected: snapshot.selected ? structuredClone(snapshot.selected) : null,
      sandbox: structuredClone(snapshot.sandbox),
    };
  }

  function freshSandbox() {
    return {
      active: false, targetId: null, prevented: new Set(),
      result: null, local: false, loading: false, sig: '', seq: 0,
    };
  }

  // ---------- 只读视图栈（历史 / 提案 / 合并 / 归并预览的原子切换） ----------
  //
  // 进入任一只读视图前先异步取数并构造投影：构造失败则绝不 push、绝不触碰
  // 当前帧；第一层只读帧入栈时捕获编辑会话，退出最后一层只读帧时原样恢复。

  function createViewStack() {
    return { checkpoint: null, frames: [] };
  }

  function isReadOnly(vs) { return vs.frames.length > 0; }
  function topFrame(vs) { return vs.frames[vs.frames.length - 1] || null; }

  function enterFrame(vs, frame, editingSnapshot) {
    if (!vs.frames.length) {
      if (!editingSnapshot) throw new Error('进入首个只读帧前必须捕获编辑会话');
      vs.checkpoint = editingSnapshot;
    }
    vs.frames.push(frame);
    return frame;
  }

  function replaceFrame(vs, frame) {
    if (!vs.frames.length) throw new Error('当前没有只读帧');
    vs.frames[vs.frames.length - 1] = frame;
    return frame;
  }

  /** 弹出只读帧：还有只读帧则返回上层只读帧；否则返回编辑会话快照。 */
  function exitFrame(vs) {
    if (!vs.frames.length) return { kind: 'editing', snapshot: vs.checkpoint };
    vs.frames.pop();
    if (vs.frames.length) return { kind: 'readonly', frame: topFrame(vs) };
    const snapshot = vs.checkpoint;
    vs.checkpoint = null;
    return { kind: 'editing', snapshot };
  }

  function resetViewStack(vs) {
    vs.checkpoint = null;
    vs.frames.length = 0;
  }

  return {
    emptyChangeset,
    normalizeNode,
    normalizeEdge,
    buildProjection,
    requireProjection,
    applyChangeset,
    projectionFromChangeset,
    computeTimeWindows,
    computeEvidenceReview,
    computeCounterfactual,
    downstream,
    timeWindows,
    evidenceReviews,
    toMapGraph,
    toPlainGraph,
    captureSession,
    restoreSession,
    freshSandbox,
    createViewStack,
    isReadOnly,
    topFrame,
    enterFrame,
    replaceFrame,
    exitFrame,
    resetViewStack,
  };
});
