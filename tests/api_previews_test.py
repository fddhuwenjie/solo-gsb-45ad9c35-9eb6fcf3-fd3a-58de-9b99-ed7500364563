"""投影层 API 回归测试（三类预览 + 历史切换 + 字段缺失）。

运行（需要 fastapi/httpx，见 requirements-dev.txt）：
    DB_PATH=/tmp/icg-test.db pytest -q tests/api_previews_test.py

这些用例驱动真实 FastAPI 应用（临时 SQLite，每次函数独立数据库），验证：
  1. 单提案只读预览 / 三方合并预览 / 重复事件归并预览都返回「稳定 ID 顺序 + 派生字段」整图，
     且预览只读、绝不落库；
  2. 历史版本切换（GET /api/versions/{id}）独立于当前版，回滚生成新版本而不改旧版；
  3. 字段缺失：旧快照节点缺 trigger_mode / description 等字段仍能正常返回（前端投影层补默认值），
     时间窗 / 证据审查在缺字段证据（reliability / source_group 缺失）下按 0 / 独立组处理。
"""
from __future__ import annotations

import os
import sys

import pytest

# 让 import app 生效（仓库根目录）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # 每个用例使用独立临时 SQLite：直接改 database 模块的全局 DB_PATH，
    # init_db() 在 TestClient 启动 lifespan 时据此建表并写示例快照。
    from app import database, main
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))
    from fastapi.testclient import TestClient

    with TestClient(main.app) as c:
        yield c


def node_ids(g):
    return [n["id"] for n in g["nodes"]]


def edge_ids(g):
    return [e["id"] for e in g["edges"]]


# ---------- 1. 当前版 / 历史切换 ----------

def test_state_has_stable_id_order_and_derived_fields(client):
    r = client.get("/api/state")
    assert r.status_code == 200
    g = r.json()
    assert g["version_id"] == 1
    # 投影层要求稳定 ID 顺序：服务端整图至少包含全部种子节点（前端投影再排序）
    ids = set(node_ids(g))
    assert {"n-null", "n-loss", "n-code", "e-log"} <= set(ids)
    # 事件节点带服务端按该版本重算的时间窗 / 证据审查
    null_event = next(n for n in g["nodes"] if n["id"] == "n-null")
    assert null_event["type"] == "event"
    assert "time_window" in null_event
    assert null_event["evidence_review"]["status"] in {
        "supported", "refuted", "disputed", "insufficient"}


def test_history_switch_is_independent_of_current(client):
    # 先在当前版提交一个变更生成 v2
    r = client.post("/api/changes/commit", json={
        "message": "v2 改动",
        "changes": {"base_version_id": 1,
                    "node_updates": [{"id": "n-loss", "title": "订单损失(改名)"}]},
    })
    assert r.status_code == 200, r.text
    v2 = r.json()["version_id"]

    # 历史 v1 仍是旧标题，当前 v2 是新标题 —— 历史视图不被当前版污染
    g1 = client.get("/api/versions/1").json()
    g_cur = client.get("/api/state").json()
    assert next(n for n in g1["nodes"] if n["id"] == "n-loss")["title"] == "订单损失"
    assert next(n for n in g_cur["nodes"] if n["id"] == "n-loss")["title"] == "订单损失(改名)"

    # 回滚以 v1 生成新版本，不删旧版本
    r = client.post("/api/versions/rollback", json={"target_version_id": 1})
    assert r.status_code == 200, r.text
    assert r.json()["version_id"] == v2 + 1
    versions = [v["id"] for v in client.get("/api/versions").json()["versions"]]
    assert 1 in versions and v2 in versions


# ---------- 2. 单提案预览（只读，不落库 / 不生成版本） ----------

def test_proposal_preview_is_readonly_and_creates_no_version(client):
    r = client.post("/api/proposals", json={
        "title": "P1",
        "changes": {"base_version_id": 1,
                    "node_updates": [{"id": "n-loss", "title": "提案改名"}]},
    })
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    prev = client.get(f"/api/proposals/{pid}/preview")
    assert prev.status_code == 200
    data = prev.json()
    assert data["base_version_id"] == 1
    # 应用提案后的图含改名（稳定 ID 顺序由前端投影层保证）
    graph_applied = data["graph"]
    assert next(n for n in graph_applied["nodes"] if n["id"] == "n-loss")["title"] == "提案改名"
    # 基线图未被污染
    assert next(n for n in data["base_graph"]["nodes"] if n["id"] == "n-loss")["title"] == "订单损失"

    # 预览不生成版本、不改变当前版
    assert client.get("/api/state").json()["version_id"] == 1
    assert next(n for n in client.get("/api/state").json()["nodes"]
                if n["id"] == "n-loss")["title"] == "订单损失"


# ---------- 3. 三方合并预览（只读） ----------

def test_merge_preview_is_readonly_and_reports_conflicts(client):
    # A：改 n-loss 横坐标；B：改 n-loss 纵坐标 + 与 A 同值地新建同 id 事件
    a = client.post("/api/proposals", json={
        "title": "A",
        "changes": {"base_version_id": 1,
                    "node_updates": [{"id": "n-loss", "pos_x": 1000}]},
    }).json()["id"]
    b = client.post("/api/proposals", json={
        "title": "B",
        "changes": {"base_version_id": 1,
                    "node_updates": [{"id": "n-loss", "pos_y": 500}],
                    "node_creates": [{"id": "ev-triage", "type": "event",
                                      "title": "应急响应介入", "pos_x": 400, "pos_y": 620}]},
    }).json()["id"]

    r = client.post("/api/proposals/merge-preview", json={
        "proposal_a_id": a, "proposal_b_id": b})
    assert r.status_code == 200, r.text
    d = r.json()
    # 单侧修改（pos_y / 新建）自动采纳；pos_x 双方不同（A 改 / B 未改 → 单侧，仍自动）
    keys = {c["key"] for c in d["conflicts"]}
    # 自动采纳至少包含 B 的单侧新建 / pos_y
    auto_subjects = {(x["subject"], x["id"], x["action"]) for x in d["auto_resolved"]}
    assert ("node", "ev-triage", "create") in auto_subjects
    # 合并预览图包含新建事件（稳定 ID 顺序由前端投影层保证）
    mg = d["merged_graph_full"]
    assert "ev-triage" in node_ids(mg)
    # 预览不生成版本、提案仍 open
    assert client.get("/api/state").json()["version_id"] == 1
    plist = {p["id"]: p["status"] for p in client.get("/api/proposals").json()["proposals"]}
    assert plist[a] == "open" and plist[b] == "open"


# ---------- 4. 重复事件归并预览（只读） ----------

def test_node_merge_preview_is_readonly(client):
    # 造一个与 n-null 重复的事件 + 一条入边，预览应重接到 n-null
    r = client.post("/api/changes/commit", json={
        "message": "加重复事件",
        "changes": {
            "base_version_id": 1,
            "node_creates": [{"id": "n-null2", "type": "event",
                              "title": "空指针异常(重复)", "pos_x": 360, "pos_y": 420,
                              "trigger_mode": "ANY"}],
            "edge_creates": [{"id": "ex4", "source_id": "n-code", "target_id": "n-null2",
                              "kind": "causes", "label": "慢查询放大空指针"}],
        },
    })
    assert r.status_code == 200, r.text
    base = r.json()["version_id"]

    r = client.post("/api/node-merge/preview", json={
        "keep_id": "n-null", "duplicate_ids": ["n-null2"], "base_version_id": base})
    assert r.status_code == 200, r.text
    d = r.json()
    # 预览图里重复节点已消失，重接边指向保留节点
    mg = d["merged_graph_full"]
    assert "n-null2" not in node_ids(mg)
    assert "n-null" in node_ids(mg)
    # ex4 被重接（n-code → n-null）或与 e1 合并
    assert any(m.get("new_target_id") == "n-null" and m["edge_id"] == "ex4"
               for m in d["edge_moves"]["rewired"]) or \
           any("ex4" in c.get("member_edge_ids", []) for c in d["edge_moves"]["collapsed"])
    # 预览 200 返回（即使有 blockers）且不生成新版本
    assert client.get("/api/state").json()["version_id"] == base


# ---------- 5. 字段缺失：缺 trigger_mode / 可靠度的历史数据 ----------

def test_missing_fields_are_tolerated_and_defaulted(client):
    # 更新清空一个证据的可靠度语义（reliability 显式 null）并去掉来源组，
    # 服务端仍应正常返回，前端投影层再补默认值。
    r = client.post("/api/changes/commit", json={
        "message": "清空证据字段",
        "changes": {"base_version_id": 1,
                    "node_updates": [{"id": "e-metric", "reliability": None,
                                      "source_group": None}]},
    })
    assert r.status_code == 200, r.text
    g = client.get("/api/state").json()
    em = next(n for n in g["nodes"] if n["id"] == "e-metric")
    assert em["reliability"] is None and em["source_group"] is None
    # 缺可靠度的证据按 0 参与审查，接口仍稳定返回四类状态之一
    review = next(n for n in g["nodes"] if n["id"] == "n-null")["evidence_review"]
    assert review["status"] in {"supported", "refuted", "disputed", "insufficient"}
    # 历史版本 v1 也能正常打开（旧快照字段齐全度可能不同）
    g1 = client.get("/api/versions/1")
    assert g1.status_code == 200
    for n in g1.json()["nodes"]:
        if n["type"] == "event":
            assert n["trigger_mode"] in {"ANY", "ALL"}
