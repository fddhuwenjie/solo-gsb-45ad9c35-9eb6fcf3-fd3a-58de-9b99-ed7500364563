'use strict';

// 用投影层 API 模拟 static/app.js 的视图状态机：
//   - 编辑态：work 草稿（Map）+ changeset；每次草稿变更后 rebuild() 生成 source='work' 投影；
//   - 历史 / 三类预览：先 captureSession() 保存现场，再切换到只读投影（来源版本 + readonly）；
//   - 退出 / 返回 / 请求失败：restoreSession() 原子恢复工作图 / changeset / 选中项 / 沙盘。
//
// 该驱动不依赖 DOM，只验证「不可变投影层」本身的保证（与 app.js 中同名函数同一实现）。
const P = require('../static/projection.js');

function cloneNodesEdges(g) {
  return {
    version_id: g.version_id,
    nodes: g.nodes.map((n) => ({ ...n })),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

function draftFromGraph(g) {
  const p = P.make({ ...g, source: 'server' });
  return {
    version_id: p.version_id,
    nodes: new Map([...p.nodes.values()].map((n) => [n.id, { ...n }])),
    edges: new Map([...p.edges.values()].map((e) => [e.id, { ...e }])),
  };
}

class Driver {
  constructor(serverGraph) {
    this.committed = cloneNodesEdges(serverGraph);
    this.work = draftFromGraph(this.committed);
    this.changes = P.emptyChangeSet();
    this.projection = null;
    this.viewingVersion = null;
    this.preview = null;
    this.roSession = null;
    this.selected = null;
    this.sandbox = { active: false, targetId: null, prevented: new Set(), result: null, local: false };
    this.rebuild();
  }

  rebuild() {
    this.projection = P.make({
      nodes: [...this.work.nodes.values()],
      edges: [...this.work.edges.values()],
      version_id: this.work.version_id,
      source: 'work',
      readonly: false,
    });
  }

  get isReadOnly() { return this.viewingVersion != null || this.preview != null; }
  get changeCount() {
    const c = this.changes;
    return c.node_creates.length + c.node_updates.length + c.node_deletes.length
      + c.edge_creates.length + c.edge_updates.length + c.edge_deletes.length;
  }

  // —— 编辑操作（只允许在非只读态）——
  select(id, kind = 'node') { this.selected = { kind, id }; }

  updateNode(id, patch) {
    if (this.isReadOnly) throw new Error('只读视图不可编辑');
    const n = this.work.nodes.get(id);
    Object.assign(n, patch);
    let upd = this.changes.node_updates.find((u) => u.id === id);
    if (!upd) { upd = { id }; this.changes.node_updates.push(upd); }
    Object.assign(upd, patch);
    this.rebuild();
  }

  addNode(node) {
    if (this.isReadOnly) throw new Error('只读视图不可编辑');
    this.work.nodes.set(node.id, node);
    this.changes.node_creates.push({ ...node });
    this.rebuild();
  }

  // —— 只读视图进入 / 退出（与 app.js enterReadOnly / exitReadOnly 同构）——
  enterReadOnly(graphData, state, source) {
    const projection = P.make({
      nodes: graphData.nodes, edges: graphData.edges,
      version_id: graphData.version_id, source, readonly: true,
    });
    if (!this.roSession) this.roSession = P.captureSession(this);
    this.projection = projection;
    this.viewingVersion = source === 'server' && state?.versionId != null ? state.versionId : null;
    this.preview = source === 'server' ? null : state;
    this.selected = null;
    this.sandbox = { active: false, targetId: null, prevented: new Set(), result: null, local: false };
  }

  enterHistory(graph, versionId) {
    this.enterReadOnly(cloneNodesEdges(graph), { versionId }, 'server');
  }

  enterPreview(graph, kind, extra = {}) {
    this.enterReadOnly(cloneNodesEdges(graph), { kind, ...extra }, kind);
  }

  /** 模拟「预览请求失败」：现场必须完全不变。 */
  simulatePreviewRequestFailure(graph, kind, error) {
    const before = this.snapshotState();
    // 与 app.js 一致：数据拿到后才 enterReadOnly；这里先验证投影能构造，
    // 但模拟网络层在切换前抛错 —— 任何状态都不应改变。
    if (error === 'network') throw new Error('网络错误：预览加载失败');
    this.enterPreview(graph, kind);
    return before;
  }

  exitReadOnly() {
    const snap = this.roSession;
    if (!snap) return false;
    P.restoreSession(this, snap);
    this.roSession = null;
    this.viewingVersion = null;
    this.preview = null;
    this.rebuild();
    return true;
  }

  // —— 派生计算（只接受活动投影）——
  windows() { return P.computeTimeWindows(this.projection); }
  review(id) { return P.computeEvidenceReview(this.projection).get(id); }
  counterfactual(target, prevented) {
    return P.computeCounterfactual(this.projection, null, target, [...prevented]);
  }
  downstream(id) { return P.downstreamOf(this.projection, null, id); }

  /** 便于断言的完整现场快照 */
  snapshotState() {
    return {
      workVersion: this.work.version_id,
      nodeIds: [...this.work.nodes.keys()],
      edgeIds: [...this.work.edges.keys()],
      changeCount: this.changeCount,
      changes: P.cloneChangeSet(this.changes),
      selected: this.selected ? { ...this.selected } : null,
      viewingVersion: this.viewingVersion,
      preview: this.preview ? { ...this.preview } : null,
      projSource: this.projection.source,
      projReadonly: this.projection.readonly,
      projVersion: this.projection.version_id,
      sandbox: {
        active: this.sandbox.active, targetId: this.sandbox.targetId,
        prevented: [...this.sandbox.prevented],
      },
    };
  }
}

module.exports = { Driver, draftFromGraph, cloneNodesEdges };
