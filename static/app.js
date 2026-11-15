/* 结算视图影响分析前端逻辑。状态中保留「分析时绑定的目录版本」，确保结果
 * 永远对应某一版已提交目录；导入新版本后旧结果会显式标记为过期。 */
(function () {
  "use strict";

  const state = {
    catalog: null,        // { version, sha256, summary, created_at }
    versions: [],         // 已发布版本列表
    selectedTable: null,
    selectedColumn: null,
    result: null,          // 最近一次分析结果
    importFile: null,
    importFileText: null,
    collapsed: new Set(),
    filter: "",
    requestSeq: 0,
    compare: {
      oldVersion: null,
      newVersion: null,
      view: null,
      sampleText: null,
      sampleName: null,
      result: null,        // 最近一次对照结果（固定对应所选两版）
      seq: 0,
    },
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $("dropzone"),
    fileInput: $("file-input"),
    fileMeta: $("file-meta"),
    importBtn: $("import-btn"),
    sampleBtn: $("load-sample-btn"),
    importAlert: $("import-alert"),
    activeVersionText: $("active-version-text"),
    activeVersionBadge: $("active-version"),
    versionList: $("version-list"),
    fieldPicker: $("field-picker"),
    analysisStatus: $("analysis-status"),
    analysisResult: $("analysis-result"),
    catalogOverview: $("catalog-overview"),
    footerVersion: $("footer-version"),
    compareOld: $("compare-old"),
    compareNew: $("compare-new"),
    compareView: $("compare-view"),
    compareSwap: $("compare-swap-btn"),
    compareDropzone: $("compare-dropzone"),
    compareFileInput: $("compare-file-input"),
    compareFileTitle: $("compare-file-title"),
    compareFileMeta: $("compare-file-meta"),
    compareRunBtn: $("compare-run-btn"),
    compareSampleBtn: $("compare-sample-btn"),
    compareAlert: $("compare-alert"),
    compareStatus: $("compare-status"),
    compareResult: $("compare-result"),
  };

  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (_e) { body = { detail: text }; }
    }
    if (!res.ok) {
      const detail = body && body.detail;
      const message =
        typeof detail === "string"
          ? detail
          : detail && detail.message
            ? detail.message
            : `请求失败（HTTP ${res.status}）`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = body;
      throw err;
    }
    return body;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlight(text) {
    if (!state.filter) return escapeHtml(text);
    const needle = state.filter.toLowerCase();
    const source = String(text);
    const lower = source.toLowerCase();
    let out = "";
    let cursor = 0;
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      out += escapeHtml(source.slice(cursor, idx));
      out += "<mark>" + escapeHtml(source.slice(idx, idx + needle.length)) + "</mark>";
      cursor = idx + needle.length;
      idx = lower.indexOf(needle, cursor);
    }
    out += escapeHtml(source.slice(cursor));
    return out;
  }

  function clauseLabel(clause) {
    const map = {
      SELECT: "投影",
      JOIN: "JOIN",
      WHERE: "WHERE",
      "GROUP BY": "GROUP BY",
      HAVING: "HAVING",
      "ORDER BY": "ORDER BY",
      UPSTREAM: "上游整体失效",
    };
    return map[clause] || clause || "-";
  }

  function renderPath(path) {
    if (!path || !path.length) return '<span class="muted">—</span>';
    const parts = path.map((node, index) => {
      const cls =
        node.kind === "field"
          ? "node-field"
          : node.full
            ? "node-full"
            : "node-view";
      const label = escapeHtml(node.label);
      if (index === 0) return `<span class="${cls}">${label}</span>`;
      const arrow = `<span class="arrow">──${escapeHtml(clauseLabel(node.clause))}→</span>`;
      return `${arrow}<span class="${cls}">${label}</span>`;
    });
    return `<div class="path">${parts.join(" ")}</div>`;
  }

  /* ---------------- 版本与目录 ---------------- */

  async function refreshCatalog() {
    const [catalogRes, versionsRes] = await Promise.all([
      api("/api/catalog"),
      api("/api/versions"),
    ]);
    state.catalog = catalogRes.exists ? catalogRes : null;
    state.versions = versionsRes.versions || [];
    renderActiveVersion(catalogRes);
    renderVersions(state.versions);
    renderFieldPicker();
    renderCatalogOverview();
    renderAnalysis();
    renderCompareForm();
  }

  /** 导入产生新版本后，补拉各版本摘要（视图名）并刷新对照表单。 */
  async function refreshCatalogAndSummaries() {
    await refreshCatalog();
    try {
      await ensureVersionSummaries();
      renderCompareForm();
    } catch (err) {
      el.compareStatus.innerHTML =
        `<p class="empty">版本摘要加载失败：${escapeHtml(err.message)}</p>`;
    }
  }

  function renderActiveVersion(catalog) {
    if (catalog && catalog.exists) {
      el.activeVersionBadge.classList.add("live");
      el.activeVersionText.textContent = `当前目录 v${catalog.version}`;
      el.footerVersion.textContent =
        `v${catalog.version} · sha256 ${String(catalog.sha256).slice(0, 12)}…`;
    } else {
      el.activeVersionBadge.classList.remove("live");
      el.activeVersionText.textContent = "尚未导入目录";
      el.footerVersion.textContent = "";
    }
  }

  function renderVersions(versions) {
    if (!versions.length) {
      el.versionList.innerHTML = '<li class="empty">暂无版本</li>';
      return;
    }
    el.versionList.innerHTML = versions
      .map((v) => {
        const cls = v.active ? ' class="active"' : "";
        const tag = v.active
          ? '<span class="v-tag">生效中</span>'
          : `<span class="v-tag" style="background:transparent;color:var(--muted);border:1px solid var(--border)">v${v.version}</span>`;
        return `<li${cls}>
          <span><span class="v-num">v${v.version}</span> · ${v.view_count} 个视图</span>
          ${tag}
        </li>`;
      })
      .join("");
  }

  function baseTables(summary) {
    if (!summary || !summary.base_tables) return [];
    return Object.entries(summary.base_tables).map(([name, cols]) => ({
      name,
      columns: cols,
    }));
  }

  function renderFieldPicker() {
    const tables = baseTables(state.catalog && state.catalog.summary);
    if (!tables.length) {
      el.fieldPicker.innerHTML =
        '<p class="empty">导入目录后，此处列出基础表与字段。</p>';
      return;
    }
    const search = `
      <input class="field-search" id="field-search" type="search"
             placeholder="搜索表名或字段名…" value="${escapeHtml(state.filter)}" />
    `;
    const groups = tables
      .map((table) => {
        const cols = table.columns;
        const visible = state.filter
          ? cols.filter(
              (c) =>
                c.toLowerCase().includes(state.filter.toLowerCase()) ||
                table.name.toLowerCase().includes(state.filter.toLowerCase()),
            )
          : cols;
        if (state.filter && visible.length === 0) return "";
        const collapsed = state.collapsed.has(table.name) && !state.filter;
        const chips = visible
          .map((col) => {
            const selected =
              state.selectedTable === table.name && state.selectedColumn === col;
            return `<button type="button" class="field-chip${selected ? " selected" : ""}"
              data-table="${escapeHtml(table.name)}" data-column="${escapeHtml(col)}"
              title="分析停用 ${escapeHtml(table.name)}.${escapeHtml(col)} 的影响">${highlight(col)}</button>`;
          })
          .join("");
        return `
          <div class="table-group${collapsed ? " collapsed" : ""}" data-table="${escapeHtml(table.name)}">
            <div class="table-head" data-toggle="${escapeHtml(table.name)}">
              <span><span class="chevron">▾</span><span class="t-name">${highlight(table.name)}</span></span>
              <span class="t-meta">${visible.length}/${cols.length} 字段</span>
            </div>
            <div class="field-list">${chips}</div>
          </div>`;
      })
      .join("");
    el.fieldPicker.innerHTML =
      search + (groups || '<p class="empty">没有匹配的表或字段。</p>');

    const searchInput = $("field-search");
    if (searchInput) {
      searchInput.addEventListener("input", (event) => {
        state.filter = event.target.value.trim();
        const pos = event.target.selectionStart;
        renderFieldPicker();
        const next = $("field-search");
        if (next) {
          next.focus();
          next.setSelectionRange(pos, pos);
        }
      });
    }
    el.fieldPicker.querySelectorAll("[data-toggle]").forEach((node) => {
      node.addEventListener("click", () => {
        const name = node.getAttribute("data-toggle");
        if (state.collapsed.has(name)) state.collapsed.delete(name);
        else state.collapsed.add(name);
        renderFieldPicker();
      });
    });
    el.fieldPicker.querySelectorAll(".field-chip").forEach((node) => {
      node.addEventListener("click", () => {
        selectField(node.getAttribute("data-table"), node.getAttribute("data-column"));
      });
    });
  }

  function renderCatalogOverview() {
    const summary = state.catalog && state.catalog.summary;
    if (!summary) {
      el.catalogOverview.innerHTML =
        '<p class="empty">尚未导入目录。可点击「载入示例」快速体验。</p>';
      return;
    }
    const tables = baseTables(summary)
      .map(
        (t) => `
        <div class="cat-card">
          <div class="c-name">${escapeHtml(t.name)}</div>
          <div class="c-cols">${t.columns.map(escapeHtml).join(" · ")}</div>
        </div>`,
      )
      .join("");
    const views = (summary.views || [])
      .map(
        (v) => `
        <div class="cat-card view">
          <div class="c-name">${escapeHtml(v.name)}</div>
          <div class="c-cols">${v.outputs.map(escapeHtml).join(" · ")}</div>
          ${
            v.depends_on && v.depends_on.length
              ? `<div class="c-deps">依赖：${v.depends_on
                  .map((d) => `<code>${escapeHtml(d)}</code>`)
                  .join("、")}</div>`
              : ""
          }
        </div>`,
      )
      .join("");
    el.catalogOverview.innerHTML = tables + views;
  }

  /* ---------------- 导入 ---------------- */

  function setImportFile(name, text) {
    state.importFile = name;
    state.importFileText = text;
    el.importBtn.disabled = false;
    el.dropzone.classList.add("has-file");
    el.fileMeta.textContent = `${name} · ${(new Blob([text]).size / 1024).toFixed(1)} KB，已就绪`;
  }

  function showImportAlert(kind, title, lines) {
    el.importAlert.hidden = false;
    el.importAlert.className = `alert ${kind}`;
    const list = lines && lines.length
      ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
      : "";
    el.importAlert.innerHTML = `<div class="alert-title">${escapeHtml(title)}</div>${list}`;
  }

  async function readFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      showImportAlert("error", "请选择 .json 文件", []);
      return;
    }
    const text = await file.text();
    setImportFile(file.name, text);
    el.importAlert.hidden = true;
  }

  /* label[for] 已负责打开文件选择框，这里只处理拖拽。 */
  el.fileInput.addEventListener("change", (event) => readFile(event.target.files[0]));
  ["dragenter", "dragover"].forEach((type) => {
    el.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    el.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropzone.classList.remove("dragover");
    });
  });
  el.dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    readFile(file);
  });

  el.sampleBtn.addEventListener("click", async () => {
    try {
      const sample = await api("/api/sample");
      setImportFile("catalog.json（示例）", JSON.stringify(sample, null, 2));
      el.importAlert.hidden = true;
    } catch (err) {
      showImportAlert("error", err.message, []);
    }
  });

  el.importBtn.addEventListener("click", async () => {
    if (!state.importFileText) return;
    el.importBtn.disabled = true;
    const originalLabel = el.importBtn.textContent;
    el.importBtn.innerHTML = '<span class="spinner"></span>校验并导入…';
    const form = new FormData();
    form.append(
      "file",
      new Blob([state.importFileText], { type: "application/json" }),
      state.importFile || "catalog.json",
    );
    try {
      const result = await api("/api/catalog/import", { method: "POST", body: form });
      showImportAlert(
        "success",
        `导入成功：已整体替换为 v${result.version}`,
        [
          `${Object.keys(result.summary.base_tables).length} 张基础表，${result.summary.views.length} 个视图`,
          `sha256 ${result.sha256.slice(0, 16)}…`,
        ],
      );
      state.importFile = null;
      state.importFileText = null;
      el.dropzone.classList.remove("has-file");
      el.fileMeta.textContent = "base_tables + views（视图 SELECT 定义）";
      el.fileInput.value = "";
      await refreshCatalogAndSummaries();
    } catch (err) {
      const errors =
        err.payload && err.payload.detail && Array.isArray(err.payload.detail.errors)
          ? err.payload.detail.errors
          : null;
      showImportAlert(
        "error",
        errors ? "整份目录被拒绝，原版目录保持生效" : err.message,
        errors || [],
      );
    } finally {
      el.importBtn.textContent = originalLabel;
      el.importBtn.disabled = !state.importFileText;
    }
  });

  /* ---------------- 分析 ---------------- */

  async function selectField(table, column) {
    state.selectedTable = table;
    state.selectedColumn = column;
    renderFieldPicker();
    const seq = ++state.requestSeq;
    el.analysisStatus.textContent = "正在分析…";
    const pinnedVersion = state.catalog ? state.catalog.version : null;
    const body = { table, column };
    if (pinnedVersion !== null) body.version = pinnedVersion;
    try {
      const result = await api("/api/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (seq !== state.requestSeq) return; // 丢弃过期响应
      state.result = result;
      renderAnalysis();
      syncActiveVersion();
    } catch (err) {
      if (seq !== state.requestSeq) return;
      state.result = null;
      el.analysisStatus.innerHTML = `<span style="color:var(--danger)">${escapeHtml(err.message)}</span>`;
      el.analysisResult.innerHTML = "";
    }
  }

  /** 分析期间可能发生导入；轻量同步生效版本，并把旧结果标记为过期。 */
  async function syncActiveVersion() {
    try {
      const catalog = await api("/api/catalog");
      const previous = state.catalog ? state.catalog.version : null;
      state.catalog = catalog.exists ? catalog : null;
      const current = state.catalog ? state.catalog.version : null;
      if (previous === current) return;
      renderActiveVersion(catalog);
      const versionsRes = await api("/api/versions");
      state.versions = versionsRes.versions || [];
      renderVersions(state.versions);
      renderFieldPicker();
      renderCatalogOverview();
      renderAnalysis();
      renderCompareForm();
      // 对照结果固定对应所选两版；生效版本变化后重渲染以显示过期提示。
      if (state.compare.result) renderCompareResult();
    } catch (_err) {
      /* 同步失败不影响已有结果展示 */
    }
  }

  function renderAnalysis() {
    if (!state.result) {
      el.analysisStatus.innerHTML = state.catalog
        ? "选择左侧基础表字段，查看受影响视图。"
        : "";
      el.analysisResult.innerHTML = "";
      return;
    }
    const result = state.result;
    const activeVersion = state.catalog ? state.catalog.version : null;
    const stale =
      result.catalog.is_active === false ||
      (activeVersion !== null && activeVersion !== result.catalog.version);
    el.analysisStatus.innerHTML = `
      分析结果绑定目录 <span class="pin">v${result.catalog.version}</span>
      · sha256 ${escapeHtml(String(result.catalog.sha256).slice(0, 12))}…
      ${stale ? `<span class="stale">当前生效目录已是 v${activeVersion}，以下结果对应旧版本；重新选择字段可刷新。</span>` : ""}
    `;

    const summary = result.summary;
    const affectedViews = result.affected_views || [];
    const fullCount = (summary.full_impact_views || []).length;
    let html = `
      <div class="result-head">
        <div class="result-field">${escapeHtml(result.field.table)}.${escapeHtml(result.field.column)}</div>
        <div class="result-version">目录版本 <b>v${result.catalog.version}</b>${stale ? "（非当前生效）" : "（当前生效）"}</div>
      </div>
      <div class="stat-row">
        <div class="stat danger"><div class="n">${summary.affected_view_count}</div><div class="l">受影响视图 / 共 ${summary.total_view_count}</div></div>
        <div class="stat warn"><div class="n">${summary.affected_output_count}</div><div class="l">受影响输出列</div></div>
        <div class="stat"><div class="n">${fullCount}</div><div class="l">整视图失效</div></div>
        <div class="stat ok"><div class="n">${result.unaffected_views.length}</div><div class="l">不受影响视图</div></div>
      </div>`;

    if (!affectedViews.length) {
      html += `<div class="empty-state ok">没有视图引用 ${escapeHtml(
        result.field.table,
      )}.${escapeHtml(result.field.column)}，停用该字段不会影响任何结算视图。</div>`;
      el.analysisResult.innerHTML = html;
      return;
    }

    html += affectedViews
      .map((view) => {
        const fullTag = view.full_impact
          ? '<span class="tag full">整视图失效</span>'
          : "";
        const chainTag = view.depends_on && view.depends_on.length
          ? `<span class="tag chain">依赖 ${view.depends_on.map(escapeHtml).join("、")}</span>`
          : "";
        const unaffected =
          view.unaffected_outputs && view.unaffected_outputs.length
            ? `<span class="tag">未受影响：${view.unaffected_outputs.map(escapeHtml).join("、")}</span>`
            : "";
        const rows = view.affected_outputs
          .map((output) => {
            const reasons = (output.reasons || [])
              .map((reason) => {
                const via =
                  reason.via_view
                    ? ` via <code>${escapeHtml(reason.via_view)}.${escapeHtml(reason.via_output || "")}</code>`
                    : "";
                return `<div class="reason-line">${escapeHtml(
                  clauseLabel(reason.clause),
                )}${via} · <code>${escapeHtml(reason.expression)}</code></div>`;
              })
              .join("");
            return `<tr>
              <td class="col-name">${escapeHtml(output.name)}</td>
              <td>${renderPath(output.path)}${reasons}</td>
            </tr>`;
          })
          .join("");
        return `
          <div class="view-card${view.full_impact ? " full" : ""}">
            <div class="view-card-head">
              <span class="view-name">${escapeHtml(view.view)}</span>
              <span class="view-tags">
                ${fullTag}${chainTag}${unaffected}
                <button class="sql-toggle" data-sql="${escapeHtml(view.view)}">查看 SQL</button>
              </span>
            </div>
            <table class="output-table">
              <thead><tr><th style="width:30%">受影响输出列</th><th>引用路径</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <pre class="view-sql" hidden>${escapeHtml(view.sql)}</pre>
          </div>`;
      })
      .join("");

    if (result.unaffected_views.length) {
      html += `
        <div class="unaffected">
          <div class="section-title">不受影响的视图（${result.unaffected_views.length}）</div>
          <div class="unaffected-list">
            ${result.unaffected_views
              .map((name) => `<span class="pill">${escapeHtml(name)}</span>`)
              .join("")}
          </div>
        </div>`;
    }

    el.analysisResult.innerHTML = html;
    el.analysisResult.querySelectorAll("[data-sql]").forEach((node) => {
      node.addEventListener("click", () => {
        const card = node.closest(".view-card");
        const pre = card.querySelector(".view-sql");
        pre.hidden = !pre.hidden;
        node.textContent = pre.hidden ? "查看 SQL" : "收起 SQL";
      });
    });
  }

  /* ---------------- 跨版本结果对照 ---------------- */

  /** 已发布版本（按版本号升序），用于两个版本下拉框。 */
  function compareVersionOptions() {
    return state.versions
      .map((v) => v.version)
      .sort((a, b) => a - b);
  }

  function renderCompareForm() {
    const cmp = state.compare;
    const versions = compareVersionOptions();

    if (versions.length < 2) {
      el.compareOld.innerHTML = "";
      el.compareNew.innerHTML = "";
      el.compareView.innerHTML = "";
      el.compareRunBtn.disabled = true;
      el.compareStatus.innerHTML = versions.length
        ? '<p class="empty">至少需要两个已发布目录版本才能对照，可再导入一份目录。</p>'
        : '<p class="empty">导入目录并产生至少两个版本后可用。</p>';
      return;
    }

    // 保留此前选择；默认旧版选最早版本、新版选最新版本。
    if (!versions.includes(cmp.oldVersion)) cmp.oldVersion = versions[0];
    if (!versions.includes(cmp.newVersion)) cmp.newVersion = versions[versions.length - 1];
    if (cmp.oldVersion === cmp.newVersion) {
      cmp.newVersion = versions.find((v) => v !== cmp.oldVersion);
    }

    const versionOptions = (selected) =>
      versions
        .map((v) => {
          const active = state.catalog && state.catalog.version === v ? "（生效中）" : "";
          return `<option value="${v}"${v === selected ? " selected" : ""}>v${v}${active}</option>`;
        })
        .join("");
    el.compareOld.innerHTML = versionOptions(cmp.oldVersion);
    el.compareNew.innerHTML = versionOptions(cmp.newVersion);

    renderCompareViewOptions();
    updateCompareRunButton();
    if (!cmp.result) el.compareStatus.innerHTML = "";
  }

  /** 目标视图下拉只列出两个版本同名（大小写不敏感）的共同视图。 */
  function renderCompareViewOptions() {
    const cmp = state.compare;
    const common = commonViews(cmp.oldVersion, cmp.newVersion);
    const previous = cmp.view;
    el.compareView.innerHTML = common.length
      ? common.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : "";
    if (common.length) {
      if (previous && common.some((name) => name.toLowerCase() === previous.toLowerCase())) {
        const match = common.find((name) => name.toLowerCase() === previous.toLowerCase());
        el.compareView.value = match;
        cmp.view = match;
      } else {
        el.compareView.value = common[0];
        cmp.view = common[0];
      }
    } else {
      cmp.view = null;
    }
  }

  function commonViews(oldVersion, newVersion) {
    const oldSummary = summaryForVersion(oldVersion);
    const newSummary = summaryForVersion(newVersion);
    if (!oldSummary || !newSummary) return [];
    const newNames = new Set((newSummary.views || []).map((v) => v.name.toLowerCase()));
    const seen = new Set();
    const result = [];
    // 展示旧版中的原始名称；后端按大小写不敏感在两版目录中分别解析视图名。
    (oldSummary.views || []).forEach((v) => {
      const key = v.name.toLowerCase();
      if (newNames.has(key) && !seen.has(key)) {
        seen.add(key);
        result.push(v.name);
      }
    });
    return result;
  }

  function summaryForVersion(version) {
    // /api/versions 只给视图数量；视图名需要逐版本摘要。结果缓存避免重复请求。
    return state.versionSummaries && state.versionSummaries[version]
      ? state.versionSummaries[version]
      : null;
  }

  function updateCompareRunButton() {
    const cmp = state.compare;
    el.compareRunBtn.disabled =
      !cmp.oldVersion ||
      !cmp.newVersion ||
      cmp.oldVersion === cmp.newVersion ||
      !cmp.view ||
      !cmp.sampleText;
  }

  function showCompareAlert(kind, title, lines) {
    el.compareAlert.hidden = false;
    el.compareAlert.className = `alert ${kind}`;
    const list = lines && lines.length
      ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
      : "";
    el.compareAlert.innerHTML = `<div class="alert-title">${escapeHtml(title)}</div>${list}`;
  }

  async function readCompareFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      showCompareAlert("error", "请选择 .json 文件", []);
      return;
    }
    const text = await file.text();
    state.compare.sampleText = text;
    state.compare.sampleName = file.name;
    el.compareDropzone.classList.add("has-file");
    el.compareFileTitle.textContent = file.name;
    el.compareFileMeta.textContent = "样本已载入，提交时再次校验格式与 500 行上限";
    el.compareAlert.hidden = true;
    updateCompareRunButton();
  }

  el.compareFileInput.addEventListener("change", (event) =>
    readCompareFile(event.target.files[0]),
  );
  ["dragenter", "dragover"].forEach((type) => {
    el.compareDropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.compareDropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    el.compareDropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.compareDropzone.classList.remove("dragover");
    });
  });
  el.compareDropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    readCompareFile(file);
  });

  el.compareSwap.addEventListener("click", () => {
    const cmp = state.compare;
    const tmp = cmp.oldVersion;
    cmp.oldVersion = cmp.newVersion;
    cmp.newVersion = tmp;
    renderCompareForm();
  });

  el.compareOld.addEventListener("change", () => {
    state.compare.oldVersion = Number(el.compareOld.value);
    if (state.compare.oldVersion === state.compare.newVersion) {
      state.compare.newVersion = Number(
        compareVersionOptions().find((v) => v !== state.compare.oldVersion),
      );
    }
    renderCompareForm();
  });
  el.compareNew.addEventListener("change", () => {
    state.compare.newVersion = Number(el.compareNew.value);
    if (state.compare.oldVersion === state.compare.newVersion) {
      state.compare.oldVersion = Number(
        compareVersionOptions().find((v) => v !== state.compare.newVersion),
      );
    }
    renderCompareForm();
  });
  el.compareView.addEventListener("change", () => {
    state.compare.view = el.compareView.value;
    updateCompareRunButton();
  });

  el.compareSampleBtn.addEventListener("click", async () => {
    try {
      const sample = await api("/api/compare/sample");
      state.compare.sampleText = JSON.stringify(sample.samples, null, 2);
      state.compare.sampleName = "compare_sample.json（示例）";
      el.compareDropzone.classList.add("has-file");
      el.compareFileTitle.textContent = "compare_sample.json（示例样本）";
      el.compareFileMeta.textContent =
        `目标视图示例：${sample.view}；样本已载入，可直接运行对照`;
      el.compareAlert.hidden = true;
      if (!state.compare.view && sample.view) state.compare.view = sample.view;
      updateCompareRunButton();
    } catch (err) {
      showCompareAlert("error", err.message, []);
    }
  });

  el.compareRunBtn.addEventListener("click", async () => {
    const cmp = state.compare;
    if (!cmp.sampleText || !cmp.view) return;
    let samples;
    try {
      samples = JSON.parse(cmp.sampleText);
    } catch (_err) {
      showCompareAlert("error", "样本 JSON 解析失败，请检查文件内容", []);
      return;
    }
    el.compareRunBtn.disabled = true;
    const originalLabel = el.compareRunBtn.textContent;
    el.compareRunBtn.innerHTML = '<span class="spinner"></span>运行中…';
    const seq = ++cmp.seq;
    el.compareStatus.innerHTML = '<p class="empty">正在两个版本上重建视图链并执行…</p>';
    el.compareResult.innerHTML = "";
    try {
      const result = await api("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_version: cmp.oldVersion,
          new_version: cmp.newVersion,
          view: cmp.view,
          samples,
        }),
      });
      if (seq !== cmp.seq) return;
      cmp.result = result;
      renderCompareResult();
    } catch (err) {
      if (seq !== cmp.seq) return;
      cmp.result = null;
      el.compareResult.innerHTML = "";
      el.compareStatus.innerHTML = "";
      showCompareAlert("error", err.message, []);
    } finally {
      el.compareRunBtn.textContent = originalLabel;
      updateCompareRunButton();
    }
  });

  function renderCompareResult() {
    const result = state.compare.result;
    el.compareAlert.hidden = true;
    if (!result) {
      el.compareStatus.innerHTML = "";
      el.compareResult.innerHTML = "";
      return;
    }
    const { old: oldMeta, new: newMeta } = result.versions;
    const active = state.catalog ? state.catalog.version : null;
    const staleNote =
      active !== null && active !== oldMeta.version && active !== newMeta.version
        ? `<span class="stale">当前生效目录为 v${active}，本结果仍只对应 v${oldMeta.version} 与 v${newMeta.version}</span>`
        : "";
    el.compareStatus.innerHTML = `
      <div class="compare-pin">
        对照视图 <b>${escapeHtml(result.view)}</b> ·
        旧版 <span class="pin">v${oldMeta.version}</span>
        vs 新版 <span class="pin">v${newMeta.version}</span>
        ${staleNote}
      </div>`;

    if (result.status === "error") {
      const items = result.errors
        .map(
          (e) =>
            `<li>v${e.version}：${escapeHtml(e.reason)}${
              e.elapsed_ms !== undefined ? `（${e.elapsed_ms} ms）` : ""
            }</li>`,
        )
        .join("");
      el.compareResult.innerHTML = `
        <div class="compare-error-box">
          <div class="alert-title">对照未完成，不展示部分差异</div>
          <ul>${items}</ul>
        </div>`;
      return;
    }

    if (result.status === "structure_mismatch") {
      el.compareResult.innerHTML = `
        <div class="compare-block">
          <div class="compare-banner structure">两版输出列名不同，存在结构差异（不再比较数据行）</div>
          <div class="structure-grid">
            <div>
              <div class="section-title">旧版 v${oldMeta.version} 输出列（${result.old_columns.length}）</div>
              ${result.old_columns.map((c) => `<span class="pill">${escapeHtml(c)}</span>`).join("")}
            </div>
            <div>
              <div class="section-title">新版 v${newMeta.version} 输出列（${result.new_columns.length}）</div>
              ${result.new_columns.map((c) => `<span class="pill">${escapeHtml(c)}</span>`).join("")}
            </div>
          </div>
          <table class="diff-table">
            <thead><tr><th>仅旧版有的列</th><th>仅新版有的列</th></tr></thead>
            <tbody><tr>
              <td>${result.removed_columns.map(escapeHtml).join("、") || "—"}</td>
              <td>${result.added_columns.map(escapeHtml).join("、") || "—"}</td>
            </tr></tbody>
          </table>
          ${result.order_changed ? '<p class="empty">列名集合相同但顺序不同。</p>' : ""}
          ${renderCompareMeta(result)}
        </div>`;
      return;
    }

    const identical = result.status === "identical";
    const banner = identical
      ? '<div class="compare-banner ok">两版输出完全一致（多重集相同，行顺序差异已忽略）</div>'
      : '<div class="compare-banner different">两版输出存在数据行差异（按完整行的多重集对照，行顺序不计）</div>';
    el.compareResult.innerHTML = `
      <div class="compare-block">
        ${banner}
        <div class="stat-row">
          <div class="stat"><div class="n">${result.row_counts.old}</div><div class="l">旧版输出行数</div></div>
          <div class="stat"><div class="n">${result.row_counts.new}</div><div class="l">新版输出行数</div></div>
          <div class="stat warn"><div class="n">${result.old_only_total}</div><div class="l">旧版独有行（合计次数）</div></div>
          <div class="stat danger"><div class="n">${result.new_only_total}</div><div class="l">新版独有行（合计次数）</div></div>
        </div>
        ${identical ? "" : renderDiffTables(result)}
        ${renderCompareMeta(result)}
      </div>`;
  }

  function renderCompareMeta(result) {
    if (!result.timing_ms) return "";
    return `<p class="empty compare-meta">执行耗时：旧版 ${result.timing_ms.old} ms · 新版 ${result.timing_ms.new} ms（上限 3000 ms，每版输出上限 2000 行）</p>`;
  }

  function renderDiffTables(result) {
    const columns = result.columns || [];
    const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const rowsOf = (entries) =>
      entries.length
        ? entries
            .map(
              (entry) =>
                `<tr><td class="diff-count">×${entry.count}</td>${entry.row
                  .map((v) => `<td>${formatCell(v)}</td>`)
                  .join("")}</tr>`,
            )
            .join("")
        : '<tr><td class="empty" colspan="' + (columns.length + 1) + '">无</td></tr>';
    return `
      <div class="diff-grid">
        <div>
          <div class="section-title">仅旧版 v${result.versions.old.version} 独有（${result.old_only.length} 种行 / ${result.old_only_total} 次）</div>
          <div class="diff-table-wrap">
            <table class="diff-table">
              <thead><tr><th>次数</th>${head}</tr></thead>
              <tbody>${rowsOf(result.old_only)}</tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="section-title">仅新版 v${result.versions.new.version} 独有（${result.new_only.length} 种行 / ${result.new_only_total} 次）</div>
          <div class="diff-table-wrap">
            <table class="diff-table">
              <thead><tr><th>次数</th>${head}</tr></thead>
              <tbody>${rowsOf(result.new_only)}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function formatCell(value) {
    if (value === null) return '<span class="null-cell">NULL</span>';
    if (typeof value === "boolean") return value ? "true" : "false";
    return escapeHtml(String(value));
  }

  /** 加载两个所选版本的摘要（视图名），供共同视图下拉使用。 */
  async function ensureVersionSummaries() {
    const versions = compareVersionOptions();
    state.versionSummaries = state.versionSummaries || {};
    await Promise.all(
      versions.map(async (v) => {
        if (state.versionSummaries[v]) return;
        const detail = await api(`/api/versions/${v}`);
        state.versionSummaries[v] = detail.summary;
      }),
    );
  }

  /* ---------------- 启动 ---------------- */
  async function bootstrap() {
    await refreshCatalogAndSummaries();
  }

  bootstrap().catch((err) => {
    el.catalogOverview.innerHTML = `<p class="empty">加载失败：${escapeHtml(err.message)}</p>`;
  });

  // 页面重新获得焦点时轻量核对生效版本，及时标记过期结果（影响分析或对照）。
  window.addEventListener("focus", () => {
    if (state.result || state.compare.result) syncActiveVersion();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (state.result || state.compare.result)) {
      syncActiveVersion();
    }
  });
})();
