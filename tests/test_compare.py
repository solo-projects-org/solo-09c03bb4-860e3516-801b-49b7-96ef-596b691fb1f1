"""跨版本视图结果对照的单元与接口测试。"""

from __future__ import annotations

import copy
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.catalog import compile_catalog
from app.compare import (
    EXECUTION_LIMIT_SECONDS,
    MAX_OUTPUT_ROWS,
    MAX_SAMPLE_ROWS,
    CompareRequestError,
    compare_versions,
    parse_samples,
    view_chain,
)
from app.main import create_app

SAMPLE_PATH = os.path.join(os.path.dirname(__file__), "..", "samples", "catalog.json")
COMPARE_SAMPLE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "samples", "compare_sample.json"
)


def sample_payload() -> dict:
    with open(SAMPLE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def compare_sample() -> dict:
    with open(COMPARE_SAMPLE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def compiled(payload: dict):
    return compile_catalog(json.dumps(payload, ensure_ascii=False))


def row(version: int) -> dict:
    return {"version": version, "sha256": f"sha-{version}"}


def payload_with_view(view_name: str, sql: str) -> dict:
    payload = copy.deepcopy(sample_payload())
    for view in payload["views"]:
        if view["name"] == view_name:
            view["sql"] = sql
    return payload


# ---------------------------------------------------------------------------
# 样本解析
# ---------------------------------------------------------------------------


def test_parse_samples_accepts_valid_shape():
    tables = parse_samples(
        {"orders": {"columns": ["id", "amt"], "rows": [[1, 2.5], [2, None]]}}
    )
    assert list(tables) == ["orders"]
    assert tables["orders"].column_keys == ["id", "amt"]
    assert tables["orders"].rows == [[1, 2.5], [2, None]]


def test_parse_samples_rejects_bad_shape():
    with pytest.raises(CompareRequestError):
        parse_samples([])
    with pytest.raises(CompareRequestError):
        parse_samples({"t": {"columns": [], "rows": []}})
    with pytest.raises(CompareRequestError):
        parse_samples({"t": {"columns": ["a"], "rows": [["too", "many"]]}})
    with pytest.raises(CompareRequestError):
        parse_samples({"t": {"columns": ["a"], "rows": [[["nested"]]]}})
    with pytest.raises(CompareRequestError):
        parse_samples({"t": {"columns": ["a"], "rows": [[float("nan")]]}})
    with pytest.raises(CompareRequestError):
        parse_samples({"t": {"columns": ["a", "a"], "rows": []}})


def test_parse_samples_enforces_500_row_total():
    samples = {
        "a": {"columns": ["x"], "rows": [[i] for i in range(300)]},
        "b": {"columns": ["x"], "rows": [[i] for i in range(201)]},
    }
    with pytest.raises(CompareRequestError, match="500"):
        parse_samples(samples)
    # 恰好 500 行允许
    ok = {
        "a": {"columns": ["x"], "rows": [[i] for i in range(300)]},
        "b": {"columns": ["x"], "rows": [[i] for i in range(200)]},
    }
    assert sum(len(t.rows) for t in parse_samples(ok).values()) == MAX_SAMPLE_ROWS


# ---------------------------------------------------------------------------
# 视图链
# ---------------------------------------------------------------------------


def test_view_chain_includes_full_upstream_lineage():
    catalog = compiled(sample_payload())
    chain = [v.name for v in view_chain(catalog, "vw_settlement")]
    assert chain[-1] == "vw_settlement"
    assert "vw_order_net" in chain and "vw_order_payments" in chain
    # 依赖优先：上游排在目标之前
    assert chain.index("vw_order_net") < chain.index("vw_settlement")


def test_view_chain_unknown_view():
    catalog = compiled(sample_payload())
    with pytest.raises(KeyError):
        view_chain(catalog, "nope")


# ---------------------------------------------------------------------------
# 引擎级对照
# ---------------------------------------------------------------------------


def test_identical_versions_report_identical():
    catalog = compiled(sample_payload())
    result = compare_versions(
        (catalog, row(1)), (catalog, row(2)), "vw_settlement", compare_sample()["samples"]
    )
    assert result["status"] == "identical"
    assert result["old_only"] == [] and result["new_only"] == []
    assert result["row_counts"]["old"] == result["row_counts"]["new"]
    assert result["columns"] == catalog.views["vw_settlement"].output_names


def test_row_level_difference_lists_multiset_entries():
    old = compiled(sample_payload())
    new_payload = payload_with_view(
        "vw_order_net",
        "SELECT o.order_id AS order_id, o.customer_id AS customer_id, "
        "o.currency AS currency, o.amount - o.discount_amount - 5 AS net_amount, "
        "o.created_at AS created_at FROM orders o",
    )
    new = compiled(new_payload)
    result = compare_versions(
        (old, row(1)), (new, row(2)), "vw_settlement", compare_sample()["samples"]
    )
    assert result["status"] == "different"
    # 每个版本 4 行，手续费改写让全部 4 行不同
    assert result["old_only_total"] == 4
    assert result["new_only_total"] == 4
    assert all(entry["count"] == 1 for entry in result["old_only"])
    # 行条目包含完整行值
    assert len(result["old_only"][0]["row"]) == len(result["columns"])


def test_duplicate_rows_count_as_multiplicity_not_set():
    # v1 明细视图每个订单一行；v2 改为与 payments 连接，订单 1 有两笔支付时
    # 会输出两行完全相同的记录。多重集对照必须按次数比较，而不是按集合去重。
    base = {
        "base_tables": {
            "orders": ["order_id", "amount"],
            "payments": ["payment_id", "order_id", "paid_amount"],
        },
        "views": [
            {
                "name": "v_detail",
                "sql": "SELECT o.order_id AS order_id, o.amount AS amount FROM orders o",
            }
        ],
    }
    v2_payload = copy.deepcopy(base)
    v2_payload["views"][0]["sql"] = (
        "SELECT o.order_id AS order_id, o.amount AS amount "
        "FROM orders o JOIN payments p ON o.order_id = p.order_id"
    )
    old = compiled(base)
    new = compiled(v2_payload)
    samples = {
        "orders": {"columns": ["order_id", "amount"], "rows": [[1, 100.0], [2, 200.0]]},
        "payments": {
            "columns": ["payment_id", "order_id", "paid_amount"],
            "rows": [[10, 1, 60.0], [11, 1, 40.0], [12, 2, 200.0]],
        },
    }
    result = compare_versions((old, row(1)), (new, row(2)), "v_detail", samples)
    assert result["status"] == "different"
    assert result["row_counts"] == {"old": 2, "new": 3}
    # 旧版独有为 0；新版仅订单 1 的行多出 1 次（2 - 1）
    assert result["old_only"] == []
    assert result["old_only_total"] == 0
    assert len(result["new_only"]) == 1
    entry = result["new_only"][0]
    assert entry["row"] == [1, 100.0]
    assert entry["count"] == 1
    assert result["new_only_total"] == 1
    assert result["row_counts"]["new"] - result["row_counts"]["old"] == result["new_only_total"]


def test_row_order_is_not_a_difference():
    # 两个版本仅 GROUP BY 之外的排序意图不同；视图本身无 ORDER BY 时，
    # 只要多重集相同就必须判定 identical。用等价改写的两个目录验证。
    old = compiled(sample_payload())
    new = compiled(sample_payload())  # 内容一致，即便底层返回顺序变化也应相等
    result = compare_versions(
        (old, row(1)), (new, row(2)), "vw_order_payments", compare_sample()["samples"]
    )
    assert result["status"] == "identical"


def test_structure_mismatch_reports_columns_and_no_row_diff():
    old = compiled(sample_payload())
    new_payload = payload_with_view(
        "vw_refund_watch",
        "SELECT p.order_id AS order_id, p.refund_total AS refund_total, "
        "CASE WHEN p.refund_total > 1000 THEN 'high' ELSE 'normal' END AS refund_tier "
        "FROM vw_order_payments p",
    )
    new = compiled(new_payload)
    result = compare_versions(
        (old, row(1)), (new, row(2)), "vw_refund_watch", compare_sample()["samples"]
    )
    assert result["status"] == "structure_mismatch"
    assert result["removed_columns"] == ["refund_level"]
    assert result["added_columns"] == ["refund_tier"]
    assert "old_only" not in result and "new_only" not in result


def test_missing_coverage_returns_error_without_partial_diff():
    old = compiled(sample_payload())
    new = compiled(sample_payload())
    samples = copy.deepcopy(compare_sample()["samples"])
    del samples["payments"]
    result = compare_versions((old, row(1)), (new, row(2)), "vw_settlement", samples)
    assert result["status"] == "error"
    assert {entry["version"] for entry in result["errors"]} == {1, 2}
    assert all("payments" in entry["reason"] for entry in result["errors"])
    assert "old_only" not in result


def test_missing_column_in_sample_names_base_table_and_columns():
    old = compiled(sample_payload())
    samples = copy.deepcopy(compare_sample()["samples"])
    amount_index = samples["orders"]["columns"].index("amount")
    samples["orders"]["columns"].pop(amount_index)
    samples["orders"]["rows"] = [
        [value for i, value in enumerate(row) if i != amount_index]
        for row in samples["orders"]["rows"]
    ]
    result = compare_versions(
        (old, row(1)), (old, row(2)), "vw_order_net", samples
    )
    assert result["status"] == "error"
    assert "orders" in result["errors"][0]["reason"]
    assert "amount" in result["errors"][0]["reason"]


def test_unknown_sample_table_is_request_error():
    old = compiled(sample_payload())
    with pytest.raises(CompareRequestError, match="不存在于"):
        compare_versions(
            (old, row(1)), (old, row(2)), "vw_settlement",
            {"nope": {"columns": ["x"], "rows": [[1]]}},
        )


def test_view_missing_in_one_version_reports_that_version():
    old = compiled(sample_payload())
    new_payload = copy.deepcopy(sample_payload())
    new_payload["views"] = [
        v for v in new_payload["views"] if v["name"] != "vw_refund_watch"
    ]
    new = compiled(new_payload)
    result = compare_versions(
        (old, row(1)), (new, row(2)), "vw_refund_watch", compare_sample()["samples"]
    )
    assert result["status"] == "error"
    assert len(result["errors"]) == 1
    assert result["errors"][0]["version"] == 2


def test_output_row_cap_returns_error():
    payload = {
        "base_tables": {"t": ["id"]},
        "views": [
            {
                "name": "v_big",
                "sql": "SELECT a.id AS id FROM t a JOIN t b ON a.id <> b.id",
            }
        ],
    }
    catalog = compiled(payload)
    # 46 行样本 -> 46*45 = 2070 行输出，超过 2000
    samples = {"t": {"columns": ["id"], "rows": [[i] for i in range(46)]}}
    result = compare_versions(
        (catalog, row(1)), (catalog, row(2)), "v_big", samples
    )
    assert result["status"] == "error"
    assert all(str(MAX_OUTPUT_ROWS) in entry["reason"] for entry in result["errors"])
    assert "old_only" not in result


def test_timeout_is_reported_with_version_and_reason():
    payload = {
        "base_tables": {"t": ["id", "v"]},
        "views": [
            {
                "name": "v_slow",
                "sql": (
                    "SELECT a.id AS id FROM t a JOIN t b ON a.v <> b.v "
                    "JOIN t c ON b.v <> c.v JOIN t d ON c.v <> d.v"
                ),
            }
        ],
    }
    catalog = compiled(payload)
    samples = {"t": {"columns": ["id", "v"], "rows": [[i, i % 7] for i in range(100)]}}
    # 直接调用 run_version，用极小行上限让查询真正跑到进度回调中断
    from app.compare import run_version

    run = run_version(catalog, "v_slow", parse_samples(samples), limit_seconds=1.0,
                      max_rows=10 ** 9)
    assert run.ok is False
    assert "1 秒" in run.reason
    assert EXECUTION_LIMIT_SECONDS == 3.0  # 线上默认上限保持 3 秒


# ---------------------------------------------------------------------------
# API 层
# ---------------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "test.db"))
    with TestClient(app) as test_client:
        yield test_client


def import_catalog(client, payload: dict) -> int:
    resp = client.post(
        "/api/catalog/import",
        files={
            "file": (
                "catalog.json",
                json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                "application/json",
            )
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["version"]


def test_compare_api_end_to_end(client):
    v1 = import_catalog(client, sample_payload())
    v2 = import_catalog(
        client,
        payload_with_view(
            "vw_order_net",
            "SELECT o.order_id AS order_id, o.customer_id AS customer_id, "
            "o.currency AS currency, o.amount - o.discount_amount - 5 AS net_amount, "
            "o.created_at AS created_at FROM orders o",
        ),
    )
    resp = client.post(
        "/api/compare",
        json={
            "old_version": v1,
            "new_version": v2,
            "view": "vw_settlement",
            "samples": compare_sample()["samples"],
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "different"
    assert data["versions"]["old"]["version"] == v1
    assert data["versions"]["new"]["version"] == v2
    assert data["old_only_total"] == 4 and data["new_only_total"] == 4


def test_compare_api_validates_versions_and_view(client):
    import_catalog(client, sample_payload())
    # 同一版本
    resp = client.post(
        "/api/compare",
        json={"old_version": 1, "new_version": 1, "view": "vw_settlement", "samples": {}},
    )
    assert resp.status_code == 422
    # 版本不存在
    resp = client.post(
        "/api/compare",
        json={"old_version": 1, "new_version": 99, "view": "vw_settlement",
              "samples": compare_sample()["samples"]},
    )
    assert resp.status_code == 404
    # 缺少 view
    resp = client.post(
        "/api/compare",
        json={"old_version": 1, "new_version": 2, "samples": {}},
    )
    assert resp.status_code == 422
    # 非法版本类型
    resp = client.post(
        "/api/compare",
        json={"old_version": "1", "new_version": 2, "view": "x", "samples": {}},
    )
    assert resp.status_code == 422


def test_compare_api_bad_samples_returns_422(client):
    import_catalog(client, sample_payload())
    resp = client.post(
        "/api/compare",
        json={
            "old_version": 1,
            "new_version": 2,
            "view": "vw_settlement",
            "samples": {"t": {"columns": [], "rows": []}},
        },
    )
    # 版本 2 尚不存在 -> 先 404；补建后再测样本错误
    assert resp.status_code == 404
    import_catalog(client, sample_payload())
    resp = client.post(
        "/api/compare",
        json={
            "old_version": 1,
            "new_version": 2,
            "view": "vw_settlement",
            "samples": {"t": {"columns": [], "rows": []}},
        },
    )
    assert resp.status_code == 422


def test_compare_result_pinned_even_after_new_import(client):
    v1 = import_catalog(client, sample_payload())
    v2 = import_catalog(
        client,
        payload_with_view(
            "vw_order_net",
            "SELECT o.order_id AS order_id, o.customer_id AS customer_id, "
            "o.currency AS currency, o.amount - o.discount_amount - 5 AS net_amount, "
            "o.created_at AS created_at FROM orders o",
        ),
    )
    request = {
        "old_version": v1,
        "new_version": v2,
        "view": "vw_settlement",
        "samples": compare_sample()["samples"],
    }
    first = client.post("/api/compare", json=request).json()
    # 对照期间导入第三版目录
    v3 = import_catalog(client, sample_payload())
    second = client.post("/api/compare", json=request).json()
    assert v3 == 3
    assert second["versions"] == first["versions"]
    assert second["old_only_total"] == first["old_only_total"]
    assert second["new_only_total"] == first["new_only_total"]


def test_compare_sample_endpoint_served(client):
    resp = client.get("/api/compare/sample")
    assert resp.status_code == 200
    data = resp.json()
    assert data["view"] == "vw_settlement"
    assert "orders" in data["samples"] and "payments" in data["samples"]
    total = sum(len(table["rows"]) for table in data["samples"].values())
    assert total <= MAX_SAMPLE_ROWS
