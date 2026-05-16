(() => {
  "use strict";

  const TODO_KEY = "robotics-stocks.todo.v1";
  const FILTER_KEY = "robotics-stocks.filter.v1";

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

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    inventory: null,
    shopping: null,
    activeCategory: "all",
    query: "",
    activeProject: null,
    todo: loadTodo(),
  };

  function loadTodo() {
    try {
      const raw = localStorage.getItem(TODO_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveTodo() {
    localStorage.setItem(TODO_KEY, JSON.stringify(state.todo));
  }

  function loadFilter() {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveFilter() {
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ category: state.activeCategory, query: state.query }),
    );
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
      btn.dataset.value = c;
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

  function badge(label, cls = "") {
    const span = document.createElement("span");
    span.className = "badge " + cls;
    span.textContent = label;
    return span;
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

  function totalShoppingCount() {
    return state.shopping.projects.reduce(
      (s, p) => s + p.groups.reduce((s2, g) => s2 + g.items.length, 0),
      0,
    );
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
    overall.innerHTML = `
      <div>${project.summary || ""}</div>
      <div>${done} / ${total}</div>
    `;
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
      const [inv, shop] = await Promise.all([
        fetchJson("./data/inventory.json"),
        fetchJson("./data/shopping.json"),
      ]);
      state.inventory = inv;
      state.shopping = shop;

      $("#meta-updated").textContent = `更新 ${inv.updated_at}`;

      const savedFilter = loadFilter();
      if (savedFilter) {
        state.activeCategory = savedFilter.category || "all";
        state.query = savedFilter.query || "";
      }

      state.activeProject = (shop.projects[0] && shop.projects[0].id) || null;

      setupTabs();
      setupSearch();
      setupReset();

      renderSummary(inv.items);
      renderFilters(inv.items);
      renderInventoryList();
      renderProjectSwitch();
      renderShopping();
    } catch (e) {
      console.error(e);
      document.body.innerHTML = `<pre style="padding:24px;color:#b00020;">データ読み込みに失敗しました。\n${e.message}</pre>`;
    }
  }

  init();
})();
