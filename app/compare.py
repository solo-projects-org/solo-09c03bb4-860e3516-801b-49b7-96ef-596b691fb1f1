"""跨版本视图结果对照。

选定两个已发布目录版本与共同视图后，用上传的基础表样本（按表名提供
``columns`` / ``rows``）在内存 SQLite 中分别重建两个版本的完整上游视图链，
执行目标视图并对照输出：

* 输出列名不同 -> 结构差异，不再比较行；
* 列名一致 -> 按完整行的多重集（multiset）列出两侧独有的行与次数，行序忽略；
* 任一版本执行失败 / 超时 / 超行数 -> 整体返回错误并注明版本与原因，不展示
  部分差异。

每次对照使用独立的内存数据库，版本快照不可变，因此对照期间即使导入新目录，
结果也只对应请求中选定的两个版本。
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .catalog import Catalog, ViewDef, norm

# 样本总行数上限（所有基础表合计）。
MAX_SAMPLE_ROWS = 500
# 每个版本目标视图输出行数上限。
MAX_OUTPUT_ROWS = 2000
# 每个版本完整视图链的执行时间上限（秒）。
EXECUTION_LIMIT_SECONDS = 3.0
# 进度回调的 VDBE 指令间隔；回调中检查截止时间以中断超时查询。
_PROGRESS_STEPS = 10000


class CompareRequestError(ValueError):
    """请求本身不合法（样本格式 / 行数 / 未知表等），对应 HTTP 422。"""


@dataclass(frozen=True)
class SampleTable:
    name: str
    columns: list[str]
    column_keys: list[str]
    rows: list[list[Any]]


@dataclass
class RunResult:
    """单个版本的执行结果；ok 为 False 时 reason 必填且不含任何差异数据。"""

    ok: bool
    reason: str | None = None
    columns: list[str] = field(default_factory=list)
    rows: list[tuple[Any, ...]] = field(default_factory=list)
    elapsed_ms: int = 0


# ---------------------------------------------------------------------------
# 样本解析
# ---------------------------------------------------------------------------


def _is_scalar(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    return False


def parse_samples(raw: Any) -> dict[str, SampleTable]:
    """解析并校验上传样本。

    格式：``{"表名": {"columns": ["c1", ...], "rows": [[v1, ...], ...]}}``。
    """
    if not isinstance(raw, dict) or not raw:
        raise CompareRequestError("samples 必须是非空对象（按基础表名提供 columns 和 rows）")

    tables: dict[str, SampleTable] = {}
    total_rows = 0
    for raw_name, body in raw.items():
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise CompareRequestError("样本中存在非法基础表名")
        name = raw_name.strip()
        if norm(name) in {norm(table.name) for table in tables.values()}:
            raise CompareRequestError(f"样本基础表重名：{name}")
        if not isinstance(body, dict):
            raise CompareRequestError(f"样本表 {name} 必须是包含 columns 和 rows 的对象")

        raw_columns = body.get("columns")
        if not isinstance(raw_columns, list) or not raw_columns:
            raise CompareRequestError(f"样本表 {name} 的 columns 必须是非空数组")
        columns: list[str] = []
        column_keys: list[str] = []
        for item in raw_columns:
            if not isinstance(item, str) or not item.strip():
                raise CompareRequestError(f"样本表 {name} 的列名必须是非空字符串")
            column = item.strip()
            key = norm(column)
            if key in column_keys:
                raise CompareRequestError(f"样本表 {name} 列名重名：{column}")
            columns.append(column)
            column_keys.append(key)

        raw_rows = body.get("rows", [])
        if not isinstance(raw_rows, list):
            raise CompareRequestError(f"样本表 {name} 的 rows 必须是数组")
        rows: list[list[Any]] = []
        for index, raw_row in enumerate(raw_rows):
            if not isinstance(raw_row, list):
                raise CompareRequestError(f"样本表 {name} 第 {index + 1} 行必须是数组")
            if len(raw_row) != len(columns):
                raise CompareRequestError(
                    f"样本表 {name} 第 {index + 1} 行有 {len(raw_row)} 个值，"
                    f"与 columns 的 {len(columns)} 列不一致"
                )
            for value in raw_row:
                if not _is_scalar(value):
                    raise CompareRequestError(
                        f"样本表 {name} 第 {index + 1} 行包含不支持的值类型"
                        "（仅允许字符串、数字、布尔、null）"
                    )
            rows.append(raw_row)
        total_rows += len(rows)
        if total_rows > MAX_SAMPLE_ROWS:
            raise CompareRequestError(
                f"样本总计 {total_rows} 行，超过上限 {MAX_SAMPLE_ROWS} 行"
            )
        tables[name] = SampleTable(
            name=name, columns=columns, column_keys=column_keys, rows=rows
        )
    return tables


# ---------------------------------------------------------------------------
# 视图链与字段覆盖
# ---------------------------------------------------------------------------


def view_chain(catalog: Catalog, view_name: str) -> list[ViewDef]:
    """目标视图及其全部传递上游视图，按依赖优先（拓扑）顺序排列。"""
    target = catalog.get_view(view_name)
    if target is None:
        raise KeyError(view_name)

    seen: set[str] = set()

    def walk(view: ViewDef) -> None:
        for dep_key in view.dependency_keys:
            if dep_key in seen:
                continue
            seen.add(dep_key)
            dep = catalog.views.get(catalog.view_index.get(dep_key, ""))
            if dep is not None:
                walk(dep)

    walk(target)
    order_index = {norm(name): i for i, name in enumerate(catalog.topological_order)}
    ordered_keys = sorted(seen | {target.name_key}, key=lambda key: order_index[key])
    return [catalog.views[catalog.view_index[key]] for key in ordered_keys]


def _check_coverage(
    catalog: Catalog,
    chain: list[ViewDef],
    samples: dict[str, SampleTable],
) -> str | None:
    """检查样本是否覆盖该版本视图链所需的全部基础表与字段。"""
    sample_by_key = {norm(table.name): table for table in samples.values()}
    missing_tables: list[str] = []
    missing_columns: list[str] = []
    for view in chain:
        refs = list(view.filter_refs)
        for projection in view.projections:
            refs.extend(projection.refs)
        grouped: dict[str, set[str]] = {}
        for ref in refs:
            source = view.sources.get(ref.alias_key)
            if source is None or source.kind != "table":
                continue
            grouped.setdefault(source.name_key, set()).add(ref.column_key)
        for table_key, column_keys in grouped.items():
            original_name = catalog.base_index.get(table_key, table_key)
            sample = sample_by_key.get(table_key)
            if sample is None:
                missing_tables.append(original_name)
                continue
            absent = sorted(column_keys - set(sample.column_keys))
            if absent:
                missing_columns.append(f"{original_name} 缺少字段：{'、'.join(absent)}")
    problems = [
        f"样本缺少基础表 {name}（视图链需要）" for name in sorted(set(missing_tables))
    ]
    problems.extend(sorted(set(missing_columns)))
    return "；".join(problems) if problems else None


# ---------------------------------------------------------------------------
# 单版本执行
# ---------------------------------------------------------------------------


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def run_version(
    catalog: Catalog,
    view_name: str,
    samples: dict[str, SampleTable],
    limit_seconds: float = EXECUTION_LIMIT_SECONDS,
    max_rows: int = MAX_OUTPUT_ROWS,
) -> RunResult:
    """在内存 SQLite 中重建该版本的完整上游视图链并执行目标视图。"""
    chain = view_chain(catalog, view_name)
    target = catalog.get_view(view_name)
    assert target is not None

    coverage = _check_coverage(catalog, chain, samples)
    if coverage:
        return RunResult(ok=False, reason=coverage)

    started = time.monotonic()
    deadline = started + limit_seconds
    conn = sqlite3.connect(":memory:")
    # SQLite 进度回调返回非 0 表示中断查询，返回 0 表示继续。
    conn.set_progress_handler(
        lambda: 1 if time.monotonic() > deadline else 0, _PROGRESS_STEPS
    )
    try:
        sample_by_key = {norm(table.name): table for table in samples.values()}
        # 仅创建该版本目录中存在的基础表；另一版本独有的样本表在此忽略。
        for table_key, original_name in catalog.base_index.items():
            sample = sample_by_key.get(table_key)
            if sample is None:
                continue
            conn.execute(
                f"CREATE TABLE {_quote(original_name)} ("
                + ", ".join(_quote(column) for column in sample.columns)
                + ")"
            )
            if sample.rows:
                placeholders = ", ".join("?" for _ in sample.columns)
                conn.executemany(
                    f"INSERT INTO {_quote(original_name)} ("
                    + ", ".join(_quote(column) for column in sample.columns)
                    + f") VALUES ({placeholders})",
                    sample.rows,
                )

        for view in chain:
            conn.execute(f"CREATE VIEW {_quote(view.name)} AS {view.sql}")

        cursor = conn.execute(
            f"SELECT * FROM {_quote(target.name)} LIMIT {max_rows + 1}"
        )
        described = [description[0] for description in cursor.description or []]
        rows = cursor.fetchall()
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if time.monotonic() > deadline:
            return RunResult(
                ok=False,
                reason=f"执行超过 {limit_seconds:g} 秒上限，已中断",
                elapsed_ms=elapsed_ms,
            )
        if len(described) != len(target.output_names):
            return RunResult(
                ok=False,
                reason=(
                    f"实际输出 {len(described)} 列与目录声明的 "
                    f"{len(target.output_names)} 列不一致"
                ),
                elapsed_ms=elapsed_ms,
            )
        if len(rows) > max_rows:
            return RunResult(
                ok=False,
                reason=f"输出 {len(rows)} 行（已截断），超过每版 {max_rows} 行上限",
                elapsed_ms=elapsed_ms,
            )
        return RunResult(
            ok=True,
            columns=list(target.output_names),
            rows=list(rows),
            elapsed_ms=elapsed_ms,
        )
    except sqlite3.OperationalError as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if time.monotonic() > deadline or str(exc).strip().lower() == "interrupted":
            return RunResult(
                ok=False,
                reason=f"执行超过 {limit_seconds:g} 秒上限，已中断",
                elapsed_ms=elapsed_ms,
            )
        return RunResult(ok=False, reason=f"SQL 执行失败：{exc}", elapsed_ms=elapsed_ms)
    except sqlite3.DatabaseError as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if str(exc).strip().lower() == "interrupted":
            return RunResult(
                ok=False,
                reason=f"执行超过 {limit_seconds:g} 秒上限，已中断",
                elapsed_ms=elapsed_ms,
            )
        return RunResult(ok=False, reason=f"SQL 执行失败：{exc}", elapsed_ms=elapsed_ms)
    finally:
        conn.set_progress_handler(None, 0)
        conn.close()


# ---------------------------------------------------------------------------
# 双版本对照
# ---------------------------------------------------------------------------


def _structure_diff(old_columns: list[str], new_columns: list[str]) -> dict[str, Any]:
    old_key_set = {norm(name) for name in old_columns}
    new_key_set = {norm(name) for name in new_columns}
    old_keys = [norm(name) for name in old_columns]
    new_keys = [norm(name) for name in new_columns]
    removed = [name for name in old_columns if norm(name) not in new_key_set]
    added = [name for name in new_columns if norm(name) not in old_key_set]
    return {
        "old_columns": old_columns,
        "new_columns": new_columns,
        "removed_columns": removed,
        "added_columns": added,
        "order_changed": not removed and not added and old_keys != new_keys,
    }


def _row_sort_key(row: list[Any]) -> str:
    return json.dumps(row, ensure_ascii=False, default=str)


def _multiset_diff(
    rows: list[tuple[Any, ...]], other: Counter[tuple[Any, ...]]
) -> list[dict[str, Any]]:
    counter = Counter(rows)
    entries = [
        {"row": list(row), "count": count - other.get(row, 0)}
        for row, count in counter.items()
        if count - other.get(row, 0) > 0
    ]
    return sorted(entries, key=lambda entry: _row_sort_key(entry["row"]))


def compare_versions(
    old: tuple[Catalog, dict[str, Any]],
    new: tuple[Catalog, dict[str, Any]],
    view_name: str,
    samples_raw: Any,
) -> dict[str, Any]:
    samples = parse_samples(samples_raw)
    old_catalog, old_row = old
    new_catalog, new_row = new
    old_version = int(old_row["version"])
    new_version = int(new_row["version"])

    version_meta = {
        "old": {"version": old_version, "sha256": old_row["sha256"]},
        "new": {"version": new_version, "sha256": new_row["sha256"]},
    }
    base: dict[str, Any] = {"view": view_name.strip(), "versions": version_meta}

    # 样本表必须至少属于其中一个版本的目录。
    known = set(old_catalog.base_index) | set(new_catalog.base_index)
    for table in samples.values():
        if norm(table.name) not in known:
            raise CompareRequestError(
                f"样本表 {table.name} 不存在于 v{old_version} 或 v{new_version} 的目录中"
            )

    errors: list[dict[str, Any]] = []
    if old_catalog.get_view(view_name) is None:
        errors.append({"version": old_version, "reason": "该版本目录不存在此视图"})
    if new_catalog.get_view(view_name) is None:
        errors.append({"version": new_version, "reason": "该版本目录不存在此视图"})
    if errors:
        return {**base, "status": "error", "errors": errors}

    old_run = run_version(old_catalog, view_name, samples)
    new_run = run_version(new_catalog, view_name, samples)

    run_errors = [
        {"version": version, "reason": run.reason, "elapsed_ms": run.elapsed_ms}
        for version, run in (
            (old_version, old_run),
            (new_version, new_run),
        )
        if not run.ok
    ]
    if run_errors:
        # 任一版本失败都不展示部分差异。
        return {**base, "status": "error", "errors": run_errors}

    base["timing_ms"] = {"old": old_run.elapsed_ms, "new": new_run.elapsed_ms}
    base["row_counts"] = {"old": len(old_run.rows), "new": len(new_run.rows)}

    if [norm(name) for name in old_run.columns] != [
        norm(name) for name in new_run.columns
    ]:
        return {
            **base,
            "status": "structure_mismatch",
            **_structure_diff(old_run.columns, new_run.columns),
        }

    old_counter = Counter(old_run.rows)
    new_counter = Counter(new_run.rows)
    old_only = _multiset_diff(old_run.rows, new_counter)
    new_only = _multiset_diff(new_run.rows, old_counter)
    return {
        **base,
        "status": "identical" if not old_only and not new_only else "different",
        "columns": old_run.columns,
        "old_only": old_only,
        "new_only": new_only,
        "old_only_total": sum(item["count"] for item in old_only),
        "new_only_total": sum(item["count"] for item in new_only),
    }
