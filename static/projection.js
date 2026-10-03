/* 不可变图投影层（Immutable Graph Projection Layer）
 *
 * 任何「进入画布的图」——服务端快照（当前版 / 历史快照）、本地未提交 changeset、
 * 提案预览、三方合并预览、重复事件归并预览——都必须先经过本模块生成一个**只读投影**：
 *
 *   Projection.make({nodes, edges, version_id, source, readonly}) → GraphProjection
 *
 * 投影的保证：
 *   - source：来源标记（server/work/proposal/merge/node_merge）+ version_id 来源版本；
 *   - readonly：只读标记（历史快照 / 三类预览恒为 true；未提交工作图为 false）；
 *   - 节点 / 连线为冻结副本，并按**稳定 ID 顺序**（id 升序）暴露；
 *   - 投影本身与 nodes/edges 视图均被冻结，任何下游计算都拿不到可变 Map；
 *   - 字段缺失（旧快照 / 畸形响应）在入投影时按统一规则补齐，绝不把 undefined 带进计算。
 *
 * 时间窗、证据审查、反事实推演、下游高亮等派生计算只接受投影（或其只读 nodes/edges 视图），
 * 计算结果缓存在投影上（WeakMap 派生缓存），同投影不重算。
 *
 * 本文件同时承载前端与后端同构的纯计算函数（时间窗 / 证据审查 / 反事实 / 下游 BFS），
 * 以及编辑会话（工作图 + changeset + 选中项 + 沙盘 + 各种高亮）的原子快照 / 恢复工具。
 * Node 回归测试（node --test）与浏览器共用本文件，不依赖任何 DOM。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Projection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 稳定 ID 顺序 ----------
  const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** 数字字段缺失 / 非有限值时回退（位置与可靠度使用）。 */
  function numOr(v, fallback) {
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 时间字段规范化：仅接受后端存储口径（UTC ISO 8601，YYYY-MM-DDTHH:MM:SSZ /
   *  带毫秒），空串 / 非字符串 / 畸形值一律按「不限(null)」处理，绝不把垃圾带进传播。 */
  function timeOrNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) ? s : null;
  }

  /** 节点入投影前规范化：旧快照或畸形响应可能缺字段 / 缺 trigger_mode。 */
  function normalizeNode(n) {
    const type = n && n.type === 'evidence' ? 'evidence' : 'event';
    const out = {
      id: String(n && n.id != null ? n.id : ''),
      type,
      title: typeof n?.title === 'string' ? n.title : '',
      description: typeof n?.description === 'string' ? n.description : '',
      pos_x: numOr(n?.pos_x, 0),
      pos_y: numOr(n?.pos_y, 0),
      created_at: typeof n?.created_at === 'string' ? n.created_at : '',
      earliest_time: timeOrNull(n?.earliest_time),
      latest_time: timeOrNull(n?.latest_time),
      reliability: n?.reliability == null ? null : numOr(n.reliability, null),
      source_group: typeof n?.source_group === 'string' && n.source_group ? n.source_group : null,
      trigger_mode: type === 'event'
        ? (n.trigger_mode === 'ALL' ? 'ALL' : 'ANY')
        : null,
    };
    if (!out.id) throw new Error('投影节点缺少 id');
    // 透传服务端已计算的派生字段（可缺；缺失时由投影统一本地重算）
    if (n && n.time_window !== undefined) out.time_window = n.time_window;
    if (n && n.evidence_review !== undefined) out.evidence_review = n.evidence_review;
    return out;
  }

  /** 连线入投影前规范化：缺 id 时用端点 / 类型 / 序号合成确定性 id（仍保证稳定顺序）。 */
  function normalizeEdge(e, index, known) {
    const kind = (e && (e.kind === 'causes' || e.kind === 'supports' || e.kind === 'refutes'))
      ? e.kind : 'causes';
    let id = e && e.id != null ? String(e.id) : '';
    if (!id || known.has(id)) {
      const base = `edge:${e?.source_id ?? '?'}->${e?.target_id ?? '?'}:${kind}`;
      id = `${base}#${index}`;
      let k = 1;
      while (known.has(id)) id = `${base}#${index}-${k++}`;
    }
    return {
      id,
      source_id: String(e?.source_id ?? ''),
      target_id: String(e?.target_id ?? ''),
      kind,
      label: typeof e?.label === 'string' ? e.label : '',
      created_at: typeof e?.created_at === 'string' ? e.created_at : '',
    };
  }

  /** 冻结只读 Map 视图：顺序由构造时传入的数组决定（稳定 ID 升序），禁止写。 */
  function frozenView(entries) {
    const map = new Map(entries);
    const view = {
      __frozenView: true,
      get size() { return map.size; },
      has: (k) => map.has(k),
      get: (k) => map.get(k),
      keys: () => map.keys(),
      values: () => map.values(),
      entries: () => map.entries(),
      [Symbol.iterator]: () => map[Symbol.iterator](),
      forEach: (fn, thisArg) => map.forEach(fn, thisArg),
    };
    return Object.freeze(view);
  }

  /**
   * 生成不可变图投影。
   * @param {Object} input
   * @param {Array} input.nodes  节点（原始对象会被克隆规范化，调用方后续修改不影响投影）
   * @param {Array} input.edges  连线
   * @param {number|string} [input.version_id] 来源版本 id
   * @param {string} [input.source='server'] server|work|proposal|merge|node_merge
   * @param {boolean} [input.readonly] 只读标记；默认按来源判定
   */
  function makeProjection(input) {
    input = input || {};
    const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
    const rawEdges = Array.isArray(input.edges) ? input.edges : [];
    const nodes = rawNodes.map(normalizeNode).sort(byIdAsc);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const knownEdgeIds = new Set();
    const edges = rawEdges
      .map((e, i) => normalizeEdge(e, i, knownEdgeIds))
      .map((e) => { knownEdgeIds.add(e.id); return e; })
      .sort(byIdAsc);
    nodes.forEach(Object.freeze);
    edges.forEach(Object.freeze);

    const source = input.source || 'server';
    const readonly = input.readonly != null
      ? !!input.readonly
      : source !== 'work'; // work（未提交工作图）可编辑，其余来源只读
    const versionId = input.version_id != null ? input.version_id : null;

    const projection = {
      __projection: true,
      version_id: versionId,
      source,
      readonly,
      hasNode: (id) => nodeIds.has(id),
      nodes: frozenView(nodes.map((n) => [n.id, n])),
      edges: frozenView(edges.map((e) => [e.id, e])),
      /** 返回可 JSON 序列化的 {version_id,nodes,edges}（稳定 ID 顺序）。 */
      toJSON() {
        return {
          version_id: versionId,
          nodes: [...this.nodes.values()],
          edges: [...this.edges.values()],
        };
      },
    };
    return Object.freeze(projection);
  }

  /** 是否为合法投影（下游计算入口的类型守卫）。 */
  const isProjection = (p) => !!(p && p.__projection === true);

  /** 断言只接受投影：时间窗 / 证据审查 / 反事实 / 下游高亮统一入口。 */
  function asProjection(p) {
    if (!isProjection(p)) {
      throw new Error('派生计算只接受不可变图投影（Projection.make），拒绝直接转换 nodes/edges');
    }
    return p;
  }

  /** 内部计算入口：nodes/edges 必须来自投影的冻结只读视图（带 __frozenView 标记）。 */
  function assertFrozenView(nodes, edges) {
    if (!nodes || !edges || !nodes.__frozenView || !edges.__frozenView) {
      throw new Error('派生计算只接受不可变图投影（Projection.make），拒绝直接转换 nodes/edges');
    }
  }

  // 派生缓存：投影 → {windows, reviews, downstream:Map(nodeId→…), cf:Map(key→…)}
  const derivedCache = new WeakMap();
  function cacheOf(p) {
    let c = derivedCache.get(p);
    if (!c) { c = { windows: null, reviews: null, downstream: new Map(), cf: new Map() }; derivedCache.set(p, c); }
    return c;
  }

  // ---------- 时间窗传播（与后端 graph.compute_time_windows 同构） ----------
  // 每条 causes 边表示源事件不晚于目标事件：
  //   有效下界 = max(自身与全部祖先的 earliest)，有效上界 = min(自身与全部后代的 latest)。
  function computeTimeWindows(nodes, edges) {
    if (isProjection(nodes)) {
      const p = asProjection(nodes);
      const c = cacheOf(p);
      if (c.windows) return c.windows;
      const r = computeTimeWindows(p.nodes, p.edges);
      c.windows = r;
      return r;
    }
    assertFrozenView(nodes, edges);
    const events = new Set([...nodes.values()].filter((n) => n.type === 'event').map((n) => n.id));
    const adj = new Map([...events].sort().map((id) => [id, []]));   // u -> [后继 v]
    const radj = new Map([...events].sort().map((id) => [id, []]));  // v -> [前因 u]
    const pairEdge = new Map();
    const indeg = new Map([...events].map((id) => [id, 0]));
    for (const e of edges.values()) {
      if (e.kind !== 'causes' || !events.has(e.source_id) || !events.has(e.target_id)) continue;
      adj.get(e.source_id).push(e.target_id);
      radj.get(e.target_id).push(e.source_id);
      indeg.set(e.target_id, indeg.get(e.target_id) + 1);
      pairEdge.set(`${e.source_id}->${e.target_id}`, e.id);
    }
    for (const arr of adj.values()) arr.sort();
    for (const arr of radj.values()) arr.sort();
    // Kahn 拓扑：初始与入队均按 id 升序，保证稳定顺序（与后端一致）
    const q = [...events].filter((id) => indeg.get(id) === 0).sort();
    const topo = [];
    while (q.length) {
      const u = q.shift(); topo.push(u);
      for (const v of adj.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) { q.push(v); q.sort(); }
      }
    }
    const hasCycle = topo.length !== events.size;

    const lb = new Map(), lbSrc = new Map(), lbPath = new Map();
    for (const id of topo) {
      const t = nodes.get(id).earliest_time || null;
      lb.set(id, t); lbSrc.set(id, t ? id : null); lbPath.set(id, t ? [id] : []);
    }
    for (const u of topo) {
      if (lb.get(u) == null) continue;  // u 尚未携带有效下界，不向下传播
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
    // 后向传播：v 的上界上溯给前因 u 并取最小值。v 按拓扑逆序处理，因此 v 已先从
    // 其全部后继收到「后代最小 latest」；v 自身无上界时仍继续传播（与后端一致）。
    for (let i = topo.length - 1; i >= 0; i--) {
      const v = topo[i];
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
  const DISPUTE_MIN = 0.6, STRENGTH_MIN = 0.7, REV_EPS = 1e-12;

  function computeEvidenceReview(nodes, edges) {
    if (isProjection(nodes)) {
      const p = asProjection(nodes);
      const c = cacheOf(p);
      if (c.reviews) return c.reviews;
      c.reviews = computeEvidenceReview(p.nodes, p.edges);
      return c.reviews;
    }
    assertFrozenView(nodes, edges);
    // eventId -> { supports: Map<bucketKey, entries>, refutes: Map<bucketKey, entries> }
    const buckets = new Map();
    for (const e of edges.values()) {
      if (e.kind !== 'supports' && e.kind !== 'refutes') continue;
      const ev = nodes.get(e.source_id), event = nodes.get(e.target_id);
      if (!ev || !event || ev.type !== 'evidence' || event.type !== 'event') continue;
      if (!buckets.has(event.id)) buckets.set(event.id, { supports: new Map(), refutes: new Map() });
      const gm = buckets.get(event.id)[e.kind];
      // 命名组桶键为字符串；未分组证据各自独立，用对象哨兵作桶键（与字符串不会碰撞）
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
          // 命名组按组名排序，独立证据桶按节点 id 排序并统一排最后，与后端输出顺序一致
          const namedKeys = [...gm.keys()].filter((k) => typeof k === 'string').sort();
          const indepKeys = [...gm.keys()].filter((k) => typeof k === 'object')
            .sort((a, b) => (a.independent < b.independent ? -1 : a.independent > b.independent ? 1 : 0));
          for (const key of [...namedKeys, ...indepKeys]) {
            const entries = gm.get(key);
            // 组内取 reliability 最高者；并列取较小节点 id，保证与后端一致
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

  // ---------- 反事实干预沙盘（与后端 graph.simulate_counterfactual 同构；只读） ----------
  function computeCounterfactual(nodes, edges, targetId, preventedIds, versionId) {
    if (isProjection(nodes)) {
      const p = asProjection(nodes);
      const key = `${targetId}|${[...(preventedIds || [])].sort().join(',')}`;
      const c = cacheOf(p);
      if (c.cf.has(key)) return c.cf.get(key);
      const r = computeCounterfactual(p.nodes, p.edges, targetId, preventedIds, p.version_id);
      c.cf.set(key, r);
      return r;
    }
    assertFrozenView(nodes, edges);
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

    // Kahn 拓扑排序，初始队列按 id 排序，结果与底层遍历顺序无关
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
      const active = ps.filter((p2) => status.get(p2) === 'still_active');
      const blocked = ps.filter((p2) => status.get(p2) === 'prevented');
      if (mode === 'ANY') {
        if (active.length) { status.set(id, 'still_active'); reason.set(id, 'any_active'); }
        else { status.set(id, 'prevented'); reason.set(id, 'all_prevented'); }
      } else if (!blocked.length) { status.set(id, 'still_active'); reason.set(id, 'all_active'); }
      else { status.set(id, 'prevented'); reason.set(id, 'some_prevented'); }
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
      const active = ps.filter((p2) => status.get(p2) === 'still_active');
      const blocked = ps.filter((p2) => status.get(p2) === 'prevented');
      let childIds;
      if (reason.get(id) === 'any_active') childIds = [active[0]];
      else if (reason.get(id) === 'all_active') childIds = ps;
      else if (reason.get(id) === 'all_prevented') childIds = ps;
      else childIds = [blocked[0]];  // some_prevented
      for (const p2 of childIds) {
        const eid = parentEdge.get(`${p2}->${id}`);
        if (eid) treeEdgeIds.add(eid);
        out.children.push(buildTree(p2));
      }
      return out;
    };

    const evSorted = [...events].sort();
    return {
      target_id: targetId,
      target_title: target.title,
      target_status: status.get(targetId),
      version_id: versionId == null ? null : versionId,
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

  // ---------- 下游影响 BFS（只读高亮：编辑图 / 历史 / 三类预览统一走投影） ----------
  function downstreamOf(nodes, edges, nodeId) {
    if (isProjection(nodes)) {
      const p = asProjection(nodes);
      const c = cacheOf(p);
      if (!c.downstream.has(nodeId)) c.downstream.set(nodeId, downstreamOf(p.nodes, p.edges, nodeId));
      return c.downstream.get(nodeId);
    }
    assertFrozenView(nodes, edges);
    const root = nodes.get(nodeId);
    if (!root) throw new Error(`节点不存在：${nodeId}`);
    const out = new Map();
    for (const e of edges.values()) {
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
    const layers = [];
    for (const [nid, d] of depth) {
      if (d === 0) continue;
      while (layers.length < d) layers.push([]);
      layers[d - 1].push(nodes.get(nid));
    }
    const affected = [...depth.keys()].filter((id) => id !== nodeId).sort();
    return {
      node_id: nodeId,
      node_title: root.title,
      affected_node_ids: affected,
      total_affected: affected.length,
      affected_events: affected.filter((id) => nodes.get(id)?.type === 'event').length,
      affected_evidence: affected.filter((id) => nodes.get(id)?.type === 'evidence').length,
      affected_edges: edgeIds.size,
      max_depth: Math.max(0, ...depth.values()),
      layers: layers.map((l) => l.filter(Boolean).map((n) => ({ id: n.id, type: n.type, title: n.title }))),
      edges: [...edgeIds].sort().map((id) => ({ id })),
    };
  }

  // ---------- 编辑会话原子快照 / 恢复 ----------
  //
  // 进入只读视图（历史快照 / 提案 / 合并 / 归并预览）前，把当前工作图、未提交 changeset、
  // 选中项、沙盘状态与全部高亮打包为一个不可变会话快照；退出 / 返回 / 请求失败时一次性还原，
  // 保证预览数据永不写回工作图、历史视图不携带未提交修改。
  function cloneChangeSet(ch) {
    return {
      node_creates: (ch?.node_creates || []).map((x) => ({ ...x })),
      node_updates: (ch?.node_updates || []).map((x) => ({ ...x })),
      node_deletes: [...(ch?.node_deletes || [])],
      edge_creates: (ch?.edge_creates || []).map((x) => ({ ...x })),
      edge_updates: (ch?.edge_updates || []).map((x) => ({ ...x })),
      edge_deletes: [...(ch?.edge_deletes || [])],
    };
  }

  function emptyChangeSet() {
    return { node_creates: [], node_updates: [], node_deletes: [],
             edge_creates: [], edge_updates: [], edge_deletes: [] };
  }

  /** 捕获整个可编辑会话（深拷贝；调用方之后的任何修改都不会影响快照）。 */
  function captureSession(s) {
    const sb = s.sandbox || {};
    return Object.freeze({
      work: s.work,                         // 工作图草稿（可变，恢复时整体替换引用）
      changes: cloneChangeSet(s.changes),
      selected: s.selected ? { kind: s.selected.kind, id: s.selected.id } : null,
      view: { ...s.view },
      sandbox: {
        active: !!sb.active,
        targetId: sb.targetId || null,
        prevented: new Set(sb.prevented || []),
        result: sb.result ? structuredClone(sb.result) : null,
        local: !!sb.local,
        loading: false,
        sig: sb.sig || '',
        seq: 0,
      },
      mergeHits: { nodes: new Set(s.mergeHits?.nodes || []), edges: new Set(s.mergeHits?.edges || []) },
      nodeMergeHits: s.nodeMerge
        ? { nodes: new Set(s.nodeMerge.nodes || []), edges: new Set(s.nodeMerge.edges || []) } : null,
      affected: { nodes: new Set(s.affected?.nodes || []), edges: new Set(s.affected?.edges || []) },
      conflictHits: {
        nodes: new Set(s.conflictHits?.nodes || []),
        edges: new Set(s.conflictHits?.edges || []),
        data: s.conflictHits?.data ? structuredClone(s.conflictHits.data) : null,
      },
      cycleHits: new Set(s._cycleHits || []),
    });
  }

  /** 从不可变会话快照原子恢复（退出 / 返回 / 请求失败都调用；无快照时为空操作）。 */
  function restoreSession(s, snap) {
    if (!snap) return false;
    s.work = snap.work;
    s.changes = cloneChangeSet(snap.changes);
    s.selected = snap.selected ? { ...snap.selected } : null;
    s.view = { ...snap.view };
    s.sandbox = {
      active: snap.sandbox.active,
      targetId: snap.sandbox.targetId,
      prevented: new Set(snap.sandbox.prevented),
      result: snap.sandbox.result ? structuredClone(snap.sandbox.result) : null,
      local: snap.sandbox.local,
      loading: false,
      sig: snap.sandbox.sig,
      seq: 0,
    };
    s.mergeHits = { nodes: new Set(snap.mergeHits.nodes), edges: new Set(snap.mergeHits.edges) };
    s.nodeMerge = snap.nodeMergeHits
      ? { nodes: new Set(snap.nodeMergeHits.nodes), edges: new Set(snap.nodeMergeHits.edges) } : null;
    s.affected = { nodes: new Set(snap.affected.nodes), edges: new Set(snap.affected.edges) };
    s.conflictHits = {
      nodes: new Set(snap.conflictHits.nodes),
      edges: new Set(snap.conflictHits.edges),
      data: snap.conflictHits.data ? structuredClone(snap.conflictHits.data) : null,
    };
    s._cycleHits = new Set(snap.cycleHits);
    return true;
  }

  return {
    byIdAsc,
    normalizeNode,
    normalizeEdge,
    make: makeProjection,
    isProjection,
    computeTimeWindows,
    computeEvidenceReview,
    computeCounterfactual,
    downstreamOf,
    cloneChangeSet,
    emptyChangeSet,
    captureSession,
    restoreSession,
    DISPUTE_MIN,
    STRENGTH_MIN,
  };
});
