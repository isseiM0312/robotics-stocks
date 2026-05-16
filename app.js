(() => {
  "use strict";

  const TODO_KEY = "robotics-stocks.todo.v1";
  const FILTER_KEY = "robotics-stocks.filter.v1";
  const PROC_KEY = "robotics-stocks.proc.v1";

  const CATEGORY_LABEL = {
    robot_kit: "ロボットキット",
    driver_ic: "ドライバIC",
    switch: "スイッチ",
    resistor: "抵抗",
    diode: "ダイオード",
    led: "LED",
    cable: "ケーブル",
    compute_board: "計算ボード",
    sensor: "センサー",
    motor: "モーター",
    power: "電源",
    tool: "工具",
    storage: "収納",
    other: "その他",
  };

  const STATUS_LABEL = {
    unopened: { label: "未開封", cls: "badge--ok" },
    unopened_or_partially_opened: { label: "未/一部開封", cls: "badge--info" },
    opened: { label: "開封済", cls: "badge--info" },
    in_use: { label: "使用中", cls: "badge--warn" },
    consumed: { label: "消費済", cls: "badge--mute" },
    unknown: { label: "不明", cls: "badge--mute" },
  };

  const CONFIDENCE_LABEL = {
    high: { label: "確認済", cls: "badge--ok" },
    medium: { label: "推定", cls: "badge--mute" },
    low: { label: "要確認", cls: "badge--mute" },
  };

  const PROC_STATUS = [
    { value: "unknown", label: "未確認", p: 0.45 },
    { value: "maybe", label: "在庫微妙", p: 0.65 },
    { value: "in", label: "在庫あり", p: 0.95 },
    { value: "out", label: "在庫なし", p: 0.05 },
  ];

  const AKIBA_SHOPS = ["akizuki", "marutsu"];
  const ONLINE_SHOPS = ["switch_science", "amazon", "marutsu"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    inventory: null,
    shopping: null,
    procurement: null,
    procurementScan: null,
    activeCategory: "all",
    query: "",
    activeProject: null,
    todo: loadJson(TODO_KEY, {}),
    procState: loadJson(PROC_KEY, null),
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function saveFilter() {
    saveJson(FILTER_KEY, { category: state.activeCategory, query: state.query });
  }

  function loadFilter() {
    return loadJson(FILTER_KEY, null);
  }

  function saveTodo() {
    saveJson(TODO_KEY, state.todo);
  }

  function saveProcState() {
    saveJson(PROC_KEY, state.procState);
  }

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.json();
  }

  function fmtQty(item) {
    return `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;
  }

  function categoryLabel(cat) {
    return CATEGORY_LABEL[cat] || cat;
  }

  function badge(label, cls = "") {
    const span = document.createElement("span");
    span.className = "badge " + cls;
    span.textContent = label;
    return span;
  }

  /* ---------- INVENTORY ---------- */

  function renderSummary(items) {
    const wrap = $("#summary");
    const total = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const skuCount = items.length;
    const cats = new Set(items.map((it) => it.category));
    const lowConfidence = items.filter((it) => it.confidence !== "high").length;
    wrap.innerHTML = "";
    const cards = [
      { label: "登録SKU", value: skuCount },
      { label: "合計数量", value: total },
      { label: "カテゴリ", value: cats.size },
      { label: "要確認", value: lowConfidence },
    ];
    for (const c of cards) {
      const el = document.createElement("div");
      el.className = "summary__card";
      el.innerHTML = `<div class="summary__label">${c.label}</div><div class="summary__value">${c.value}</div>`;
      wrap.appendChild(el);
    }
  }

  function renderFilters(items) {
    const wrap = $("#filters");
    const cats = ["all", ...new Set(items.map((it) => it.category))];
    wrap.innerHTML = "";
    for (const c of cats) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (state.activeCategory === c ? " is-active" : "");
      btn.textContent = c === "all" ? "すべて" : categoryLabel(c);
      btn.addEventListener("click", () => {
        state.activeCategory = c;
        saveFilter();
        renderFilters(items);
        renderInventoryList();
      });
      wrap.appendChild(btn);
    }
  }

  function filterItems() {
    const items = state.inventory.items;
    const q = state.query.trim().toLowerCase();
    return items.filter((it) => {
      if (state.activeCategory !== "all" && it.category !== state.activeCategory) return false;
      if (!q) return true;
      const haystack = [
        it.name,
        it.model,
        it.value,
        it.pos_code,
        it.id,
        categoryLabel(it.category),
        ...(Array.isArray(it.notes) ? it.notes : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function renderItemCard(item) {
    const li = document.createElement("li");
    li.className = "card";

    const head = document.createElement("div");
    head.className = "card__head";
    const name = document.createElement("div");
    name.className = "card__name";
    name.textContent = item.name + (item.value ? ` (${item.value})` : "");
    const qty = document.createElement("div");
    qty.className = "card__qty";
    qty.textContent = fmtQty(item);
    head.append(name, qty);

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.appendChild(badge(categoryLabel(item.category), "badge--cat"));
    const st = STATUS_LABEL[item.status] || STATUS_LABEL.unknown;
    badges.appendChild(badge(st.label, st.cls));
    const cf = CONFIDENCE_LABEL[item.confidence] || CONFIDENCE_LABEL.medium;
    badges.appendChild(badge(cf.label, cf.cls));

    const meta = document.createElement("div");
    meta.className = "card__meta";
    if (item.model && item.model !== "unknown") meta.innerHTML += `<span><b>型番</b> ${item.model}</span>`;
    if (item.pos_code) meta.innerHTML += `<span><b>POS</b> ${item.pos_code}</span>`;

    li.append(head, badges);
    if (meta.innerHTML) li.appendChild(meta);

    if (Array.isArray(item.notes) && item.notes.length) {
      const ul = document.createElement("ul");
      ul.className = "card__notes";
      for (const n of item.notes) {
        const li2 = document.createElement("li");
        li2.textContent = n;
        ul.appendChild(li2);
      }
      li.appendChild(ul);
    }
    return li;
  }

  function renderInventoryList() {
    const list = $("#inventory-list");
    const empty = $("#inventory-empty");
    list.innerHTML = "";
    const items = filterItems();
    if (!items.length) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      const frag = document.createDocumentFragment();
      for (const it of items) frag.appendChild(renderItemCard(it));
      list.appendChild(frag);
    }
    $("#count-inventory").textContent = state.inventory.items.length;
  }

  /* ---------- SHOPPING ---------- */

  function renderProjectSwitch() {
    const wrap = $("#project-switch");
    wrap.innerHTML = "";
    for (const p of state.shopping.projects) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (state.activeProject === p.id ? " is-active" : "");
      btn.textContent = p.name;
      btn.addEventListener("click", () => {
        state.activeProject = p.id;
        renderProjectSwitch();
        renderShopping();
      });
      wrap.appendChild(btn);
    }
  }

  function checkedCount(project) {
    let n = 0;
    for (const g of project.groups) {
      for (const it of g.items) {
        if (state.todo[it.id]) n++;
      }
    }
    return n;
  }

  function renderShopping() {
    const root = $("#shopping");
    root.innerHTML = "";
    const project = state.shopping.projects.find((p) => p.id === state.activeProject) || state.shopping.projects[0];
    if (!project) return;

    const total = project.groups.reduce((s, g) => s + g.items.length, 0);
    const done = checkedCount(project);

    const overall = document.createElement("div");
    overall.className = "summary__overall";
    overall.innerHTML = `<div>${project.summary || ""}</div><div>${done} / ${total}</div>`;
    root.appendChild(overall);

    for (const group of project.groups) {
      const gWrap = document.createElement("section");
      gWrap.className = "shop-group";

      const head = document.createElement("div");
      head.className = "shop-group__head";
      const name = document.createElement("div");
      name.className = "shop-group__name";
      name.textContent = group.name;
      const prog = document.createElement("div");
      prog.className = "shop-group__progress";
      const groupDone = group.items.filter((it) => state.todo[it.id]).length;
      prog.textContent = `${groupDone} / ${group.items.length}`;
      head.append(name, prog);
      gWrap.appendChild(head);

      const list = document.createElement("ul");
      list.className = "shop-list";
      for (const it of group.items) {
        const li = document.createElement("li");
        li.className = "shop-item" + (state.todo[it.id] ? " is-done" : "");

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!state.todo[it.id];
        cb.id = `chk-${it.id}`;
        cb.addEventListener("change", () => {
          state.todo[it.id] = cb.checked;
          saveTodo();
          renderShopping();
        });

        const body = document.createElement("label");
        body.className = "shop-item__body";
        body.htmlFor = cb.id;
        const lbl = document.createElement("div");
        lbl.className = "shop-item__label";
        lbl.textContent = it.label;
        const sub = document.createElement("div");
        sub.className = "shop-item__sub";
        const subParts = [];
        if (it.where) subParts.push(it.where);
        if (it.note) subParts.push(it.note);
        sub.textContent = subParts.join(" · ");
        body.append(lbl);
        if (subParts.length) body.appendChild(sub);

        li.append(cb, body);
        list.appendChild(li);
      }
      gWrap.appendChild(list);
      root.appendChild(gWrap);
    }
    $("#count-shopping").textContent = total - done;
  }

  /* ---------- PROCUREMENT ---------- */

  function initProcStateIfNeeded() {
    if (!state.procurement) return;
    const defaults = state.procurement.defaults || {};

    if (!state.procState || typeof state.procState !== "object") state.procState = {};
    if (!state.procState.params || typeof state.procState.params !== "object") state.procState.params = {};
    if (!state.procState.items || typeof state.procState.items !== "object") state.procState.items = {};

    for (const [k, v] of Object.entries(defaults)) {
      const cur = Number(state.procState.params[k]);
      state.procState.params[k] = Number.isFinite(cur) ? cur : v;
    }

    for (const item of state.procurement.items || []) {
      if (!state.procState.items[item.id]) {
        state.procState.items[item.id] = { akiba: "unknown", online: "unknown" };
      }
    }
  }

  function getProcStatusP(v) {
    const f = PROC_STATUS.find((x) => x.value === v);
    return f ? f.p : 0.45;
  }

  function fmtDuration(min) {
    if (min < 60) return `${Math.round(min)}分`;
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m ? `${h}時間${m}分` : `${h}時間`;
  }

  function buildSearchUrl(shopId, query) {
    const shop = (state.procurement.shops || []).find((s) => s.id === shopId);
    if (!shop || !query) return null;
    return `${shop.search_url}${encodeURIComponent(query)}`;
  }

  function evaluateProcurement() {
    const items = state.procurement.items || [];
    const params = state.procState.params || {};
    const totalWeight = items.reduce((s, i) => s + (Number(i.weight) || 1), 0) || 1;

    let akibaW = 0;
    let onlineW = 0;
    let unresolvedCritical = 0;

    for (const item of items) {
      const w = Number(item.weight) || 1;
      const st = state.procState.items[item.id] || { akiba: "unknown", online: "unknown" };
      akibaW += w * getProcStatusP(st.akiba);
      onlineW += w * getProcStatusP(st.online);
      if (w >= 1.2 && st.akiba === "unknown" && st.online === "unknown") unresolvedCritical++;
    }

    const akibaProb = akibaW / totalWeight;
    const onlineProb = onlineW / totalWeight;

    const akibaEtaMin =
      Number(params.prep_min) +
      Number(params.transit_oneway_min) +
      Number(params.store_stay_min) +
      Number(params.extra_retry_min) * (1 - akibaProb);

    const now = new Date();
    const cutoff = Number(params.online_cutoff_hour);
    const afterCutoff = Number.isFinite(cutoff) ? now.getHours() >= cutoff : false;
    const dispatchPlus = afterCutoff ? 1 : 0;
    const onlineBaseMin =
      (dispatchPlus + Number(params.online_dispatch_days) + Number(params.online_shipping_days)) * 24 * 60;
    const onlineEtaMin = onlineBaseMin + (1 - onlineProb) * 12 * 60;

    let recommendation = "hybrid";
    let reason = "店舗と通販の期待値が近いため、クリティカル部品のみ先行調達が安全。";

    if (akibaProb >= onlineProb + 0.12 && akibaEtaMin <= onlineEtaMin * 1.2) {
      recommendation = "akiba";
      reason = "今日の完了期待が高く、到着時間も短いので秋葉原優先。";
    } else if (onlineProb >= akibaProb + 0.12 && onlineEtaMin < akibaEtaMin) {
      recommendation = "online";
      reason = "通販の確実性と到着予測が優位。オンライン優先で良い。";
    } else if (akibaEtaMin <= 180 && akibaProb >= 0.55) {
      recommendation = "akiba";
      reason = "短時間で確認できる見込みがあり、今日前進しやすい。";
    }

    return { akibaProb, onlineProb, akibaEtaMin, onlineEtaMin, unresolvedCritical, recommendation, reason };
  }

  function recommendationLabel(code) {
    if (code === "akiba") return { text: "秋葉原に行く", badge: "GO" };
    if (code === "online") return { text: "通販優先", badge: "WEB" };
    return { text: "ハイブリッド", badge: "MIX" };
  }

  function applyScanToState({ overwrite = false } = {}) {
    if (!state.procurementScan || !Array.isArray(state.procurementScan.items)) return;

    const map = new Map(state.procurementScan.items.map((it) => [it.id, it]));
    for (const item of state.procurement.items || []) {
      const scan = map.get(item.id);
      if (!scan) continue;
      const current = state.procState.items[item.id] || { akiba: "unknown", online: "unknown" };
      for (const channel of ["akiba", "online"]) {
        const candidate = scan[channel]?.status;
        if (!candidate || !PROC_STATUS.some((x) => x.value === candidate)) continue;
        if (overwrite || current[channel] === "unknown") {
          current[channel] = candidate;
        }
      }
      state.procState.items[item.id] = current;
    }
    saveProcState();
  }

  function renderProcurement() {
    const root = $("#procurement");
    root.innerHTML = "";
    if (!state.procurement) return;

    $("#proc-updated").textContent = `更新 ${state.procurement.updated_at}`;

    const ev = evaluateProcurement();
    const rec = recommendationLabel(ev.recommendation);
    $("#count-procurement").textContent = rec.badge;

    const top = document.createElement("div");
    top.className = "proc-grid";
    const scanText = state.procurementScan?.generated_at
      ? `最新スキャン: ${state.procurementScan.generated_at}`
      : "最新スキャン: なし";
    top.innerHTML = `
      <section class="proc-card">
        <h3 class="proc-card__title">判定</h3>
        <div class="proc-reco proc-reco--${ev.recommendation}">
          <div class="proc-reco__title">${rec.text}</div>
          <div class="proc-reco__reason">${ev.reason}</div>
        </div>
        <div class="proc-metrics">
          <div class="proc-metric"><span>秋葉原 完了見込み</span><b>${Math.round(ev.akibaProb * 100)}%</b></div>
          <div class="proc-metric"><span>通販 完了見込み</span><b>${Math.round(ev.onlineProb * 100)}%</b></div>
          <div class="proc-metric"><span>秋葉原 ETA</span><b>${fmtDuration(ev.akibaEtaMin)}</b></div>
          <div class="proc-metric"><span>通販 ETA</span><b>${fmtDuration(ev.onlineEtaMin)}</b></div>
          <div class="proc-metric"><span>未確認クリティカル</span><b>${ev.unresolvedCritical}件</b></div>
        </div>
      </section>
      <section class="proc-card">
        <h3 class="proc-card__title">計算パラメータ</h3>
        <div class="proc-form">
          <label>出発準備 (分)<input type="number" min="0" step="1" data-proc-param="prep_min" value="${state.procState.params.prep_min}" /></label>
          <label>片道移動 (分)<input type="number" min="0" step="1" data-proc-param="transit_oneway_min" value="${state.procState.params.transit_oneway_min}" /></label>
          <label>店頭探索 (分)<input type="number" min="0" step="1" data-proc-param="store_stay_min" value="${state.procState.params.store_stay_min}" /></label>
          <label>再探索追加 (分)<input type="number" min="0" step="1" data-proc-param="extra_retry_min" value="${state.procState.params.extra_retry_min}" /></label>
          <label>通販当日締切 (時)<input type="number" min="0" max="23" step="1" data-proc-param="online_cutoff_hour" value="${state.procState.params.online_cutoff_hour}" /></label>
          <label>発送日数 (日)<input type="number" min="0" step="0.5" data-proc-param="online_dispatch_days" value="${state.procState.params.online_dispatch_days}" /></label>
          <label>配送日数 (日)<input type="number" min="0" step="0.5" data-proc-param="online_shipping_days" value="${state.procState.params.online_shipping_days}" /></label>
        </div>
        <div class="proc-actions">
          <div class="proc-scan-info">${scanText}</div>
          <button class="ghost-btn" type="button" id="proc-apply-scan">スキャン結果を反映</button>
          <button class="ghost-btn" type="button" id="proc-overwrite-scan">スキャンで上書き</button>
          <button class="ghost-btn" type="button" id="proc-reset">判定を未確認に戻す</button>
        </div>
      </section>
    `;
    root.appendChild(top);

    const table = document.createElement("section");
    table.className = "proc-card";
    table.innerHTML = `
      <h3 class="proc-card__title">部品ごとの在庫判定（半自動クロール入力）</h3>
      <p class="proc-help">Nodeスクリプトで検索結果を集めて反映し、必要に応じて手修正する運用。</p>
      <div class="proc-items" id="proc-items"></div>
    `;
    root.appendChild(table);

    const itemsRoot = $("#proc-items", table);
    for (const item of state.procurement.items || []) {
      const status = state.procState.items[item.id] || { akiba: "unknown", online: "unknown" };
      const row = document.createElement("article");
      row.className = "proc-item";

      const storesAkiba = AKIBA_SHOPS.map((id) => {
        const q = item.queries?.[id];
        const shop = (state.procurement.shops || []).find((s) => s.id === id);
        const url = buildSearchUrl(id, q);
        return shop && url ? `<a href="${url}" target="_blank" rel="noreferrer">${shop.name}</a>` : "";
      })
        .filter(Boolean)
        .join(" / ");

      const storesOnline = ONLINE_SHOPS.map((id) => {
        const q = item.queries?.[id];
        const shop = (state.procurement.shops || []).find((s) => s.id === id);
        const url = buildSearchUrl(id, q);
        return shop && url ? `<a href="${url}" target="_blank" rel="noreferrer">${shop.name}</a>` : "";
      })
        .filter(Boolean)
        .join(" / ");

      row.innerHTML = `
        <div class="proc-item__main">
          <div class="proc-item__title">${item.label}</div>
          <div class="proc-item__meta">重要度 ${item.weight}</div>
          <div class="proc-item__links"><span>店舗検索:</span> ${storesAkiba || "-"}</div>
          <div class="proc-item__links"><span>通販検索:</span> ${storesOnline || "-"}</div>
        </div>
        <div class="proc-item__controls">
          <label>秋葉原
            <select data-proc-item="${item.id}" data-channel="akiba">
              ${PROC_STATUS.map((s) => `<option value="${s.value}" ${status.akiba === s.value ? "selected" : ""}>${s.label}</option>`).join("")}
            </select>
          </label>
          <label>通販
            <select data-proc-item="${item.id}" data-channel="online">
              ${PROC_STATUS.map((s) => `<option value="${s.value}" ${status.online === s.value ? "selected" : ""}>${s.label}</option>`).join("")}
            </select>
          </label>
        </div>
      `;
      itemsRoot.appendChild(row);
    }

    $$("[data-proc-param]", root).forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.procParam;
        const val = Number(input.value);
        if (!Number.isFinite(val)) return;
        state.procState.params[key] = val;
        saveProcState();
        renderProcurement();
      });
    });

    $$("select[data-proc-item]", root).forEach((sel) => {
      sel.addEventListener("change", () => {
        const itemId = sel.dataset.procItem;
        const channel = sel.dataset.channel;
        if (!state.procState.items[itemId]) state.procState.items[itemId] = { akiba: "unknown", online: "unknown" };
        state.procState.items[itemId][channel] = sel.value;
        saveProcState();
        renderProcurement();
      });
    });

    const applyBtn = $("#proc-apply-scan", root);
    applyBtn.disabled = !state.procurementScan;
    applyBtn.addEventListener("click", () => {
      if (!state.procurementScan) return;
      applyScanToState({ overwrite: false });
      renderProcurement();
    });

    const overwriteBtn = $("#proc-overwrite-scan", root);
    overwriteBtn.disabled = !state.procurementScan;
    overwriteBtn.addEventListener("click", () => {
      if (!state.procurementScan) return;
      if (!confirm("現在の手動判定をスキャン結果で上書きしますか？")) return;
      applyScanToState({ overwrite: true });
      renderProcurement();
    });

    $("#proc-reset", root).addEventListener("click", () => {
      if (!confirm("在庫判定（秋葉原/通販）を全て未確認に戻しますか？")) return;
      for (const item of state.procurement.items || []) {
        state.procState.items[item.id] = { akiba: "unknown", online: "unknown" };
      }
      saveProcState();
      renderProcurement();
    });
  }

  /* ---------- TABS ---------- */

  function setupTabs() {
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        $$(".tab").forEach((b) => {
          const active = b.dataset.tab === target;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        $$(".panel").forEach((p) => {
          const active = p.id === `tab-${target}`;
          p.classList.toggle("is-active", active);
          p.hidden = !active;
        });
      });
    });
  }

  function setupSearch() {
    const input = $("#search");
    input.value = state.query;
    input.addEventListener("input", () => {
      state.query = input.value;
      saveFilter();
      renderInventoryList();
    });
  }

  function setupReset() {
    $("#reset-todo").addEventListener("click", () => {
      if (!confirm("買い物チェックを全部クリアしますか？")) return;
      state.todo = {};
      saveTodo();
      renderShopping();
    });
  }

  /* ---------- BOOT ---------- */

  async function init() {
    $("#year").textContent = String(new Date().getFullYear());
    try {
      const [inv, shop, proc, procScan] = await Promise.all([
        fetchJson("./data/inventory.json"),
        fetchJson("./data/shopping.json"),
        fetchJson("./data/procurement.json"),
        fetchJson("./data/procurement_scan.json").catch(() => null),
      ]);

      state.inventory = inv;
      state.shopping = shop;
      state.procurement = proc;
      state.procurementScan = procScan;

      $("#meta-updated").textContent = `更新 ${inv.updated_at}`;

      const savedFilter = loadFilter();
      if (savedFilter) {
        state.activeCategory = savedFilter.category || "all";
        state.query = savedFilter.query || "";
      }
      state.activeProject = (shop.projects[0] && shop.projects[0].id) || null;

      initProcStateIfNeeded();
      saveProcState();

      setupTabs();
      setupSearch();
      setupReset();

      renderSummary(inv.items);
      renderFilters(inv.items);
      renderInventoryList();
      renderProjectSwitch();
      renderShopping();
      renderProcurement();
    } catch (e) {
      console.error(e);
      document.body.innerHTML = `<pre style="padding:24px;color:#b00020;">データ読み込みに失敗しました。\n${e.message}</pre>`;
    }
  }

  init();
})();
