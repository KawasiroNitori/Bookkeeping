(() => {
  "use strict";

  const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwPzshs-qmMlPCsBIIW6VLUyqgkD3F3nPI96hAm7QbXigVZueCVo4a2wZlXlCwikCg/exec";
  const KAKAO_JS_KEY = "c7dfd909d0143edbc6e746d79027416d";
  const BASELINE = 50000;
  const THRESHOLD = 20000;
  const CACHE_KEY = "lab-ledger-cache-v2";

  const app = document.getElementById("app");

  const state = {
    members: [],
    transactions: [],
    restaurants: [],
    reviews: [],
    activeTab: "home",
    status: "loading",
    statusDetail: "구글 시트 확인 중",
    error: "",
    lastSynced: null,
    txType: "delivery",
    historyFilter: "all",
    expandedTxnId: "",
    expandedMemberId: "",
    selectedRestaurantId: "",
    restaurantSearchResults: [],
    restaurantMapError: "",
    reviewStoreStatus: "",
    modal: null,
    saving: false,
  };

  const form = {
    deposit: { memberId: "", amount: "", memo: "" },
    withdraw: { memberId: "", amount: "", memo: "" },
    shared: { memberIds: [], amount: "", memo: "" },
    transfer: { fromMemberId: "", toMemberId: "", amount: "", memo: "" },
    delivery: { memberIds: [], amounts: {}, sharedAmount: "", payerId: "lab", memo: "" },
    restaurant: { query: "", memberId: "", rating: "5", comment: "" },
    member: { name: "", balance: "50000" },
    editMemberId: "",
    editBalance: "",
  };

  const txLabels = {
    deposit: "입금",
    withdraw: "출금",
    shared: "공동지출",
    transfer: "송금",
    delivery: "배달정산",
  };

  const avatarPalette = [
    ["#dbeafe", "#1d4ed8"],
    ["#dcfce7", "#15803d"],
    ["#fef3c7", "#92400e"],
    ["#fce7f3", "#9d174d"],
    ["#d1fae5", "#065f46"],
    ["#ede9fe", "#5b21b6"],
    ["#e0f2fe", "#0369a1"],
  ];

  let kakaoLoader = null;
  let restaurantMap = null;
  let restaurantMarkers = [];
  let restaurantInfoWindow = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmt(value) {
    return new Intl.NumberFormat("ko-KR").format(Math.round(Number(value) || 0));
  }

  function parseMoney(value) {
    const cleaned = String(value ?? "").replace(/[^\d.-]/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : 0;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function isLocalHttp() {
    return location.protocol.startsWith("http") && ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
  }

  function parseSheet(data) {
    const members = (data.members || []).map((member) => ({
      ...member,
      id: String(member.id),
      name: String(member.name || ""),
      balance: Number(member.balance) || 0,
    }));

    const transactions = (data.transactions || []).map((txn) => ({
      ...txn,
      id: String(txn.id || uid()),
      date: txn.date || new Date().toISOString(),
      type: txn.type || "shared",
      amount: Number(txn.amount) || 0,
      amountPerPerson: Number(txn.amountPerPerson) || 0,
      sharedAmount: Number(txn.sharedAmount) || 0,
      memberId: String(txn.memberId || ""),
      fromMemberId: String(txn.fromMemberId || ""),
      toMemberId: String(txn.toMemberId || ""),
      payerId: String(txn.payerId || ""),
      memberIds: Array.isArray(txn.memberIds)
        ? txn.memberIds.map(String)
        : String(txn.memberIds || "").split(",").filter(Boolean),
      participants: (txn.participants || []).map((part) => ({
        id: String(part.id),
        amount: Number(part.amount) || 0,
      })),
      memo: String(txn.memo || ""),
    }));

    const restaurants = (data.restaurants || []).map((restaurant) => ({
      ...restaurant,
      id: String(restaurant.id || uid()),
      provider: String(restaurant.provider || "kakao"),
      providerPlaceId: String(restaurant.providerPlaceId || restaurant.placeId || ""),
      name: String(restaurant.name || ""),
      address: String(restaurant.address || ""),
      lat: Number(restaurant.lat) || 0,
      lng: Number(restaurant.lng) || 0,
      phone: String(restaurant.phone || ""),
      category: String(restaurant.category || ""),
      placeUrl: String(restaurant.placeUrl || ""),
      createdAt: restaurant.createdAt || new Date().toISOString(),
    }));

    const reviews = (data.reviews || []).map((review) => ({
      ...review,
      id: String(review.id || uid()),
      restaurantId: String(review.restaurantId || ""),
      memberId: String(review.memberId || ""),
      rating: Math.max(1, Math.min(5, Number(review.rating) || 5)),
      comment: String(review.comment || ""),
      createdAt: review.createdAt || new Date().toISOString(),
    }));

    return { members, transactions, restaurants, reviews };
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    } catch {
      // Cache failure should never block the ledger itself.
    }
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    return response.json();
  }

  async function fetchLedger() {
    const sources = isLocalHttp() ? ["/api/ledger", SCRIPT_URL] : [SCRIPT_URL];
    const errors = [];

    for (const source of sources) {
      try {
        const data = parseSheet(await fetchJson(source));
        saveCache(data);
        return { data, source };
      } catch (error) {
        errors.push(`${source}: ${error.message || error}`);
      }
    }

    throw new Error(errors.join(" / "));
  }

  async function saveLedger(members, transactions, restaurants = state.restaurants, reviews = state.reviews) {
    const payload = JSON.stringify({ action: "saveAll", members, transactions, restaurants, reviews });
    saveCache({ members, transactions, restaurants, reviews });

    if (isLocalHttp()) {
      try {
        const response = await fetch("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }
        return { verified: true };
      } catch (error) {
        console.warn("Local save proxy failed, falling back to Apps Script:", error);
      }
    }

    await fetch(SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      body: payload,
    });
    return { verified: false };
  }

  async function loadLedger() {
    const cached = readCache();
    if (cached?.members && cached?.transactions) {
      state.members = cached.members;
      state.transactions = cached.transactions;
      state.restaurants = cached.restaurants || [];
      state.reviews = cached.reviews || [];
      state.status = "cached";
      state.statusDetail = "캐시 표시 중";
      state.error = "";
      render();
    } else {
      state.status = "loading";
      state.statusDetail = "구글 시트 확인 중";
      state.error = "";
      render();
    }

    try {
      const result = await fetchLedger();
      state.members = result.data.members;
      state.transactions = result.data.transactions;
      state.restaurants = result.data.restaurants.length ? result.data.restaurants : (cached?.restaurants || []);
      state.reviews = result.data.reviews.length ? result.data.reviews : (cached?.reviews || []);
      state.status = "ok";
      state.statusDetail = result.source === "/api/ledger" ? "로컬 프록시로 연결됨" : "구글 시트 연결됨";
      state.lastSynced = new Date();
      state.error = "";
    } catch (error) {
      state.status = cached ? "cached" : "error";
      state.statusDetail = cached ? "캐시 표시 중" : "연결 실패";
      state.error = error.message || "데이터를 불러오지 못했습니다.";
    }
    render();
  }

  async function applyUpdate(members, transactions, afterSuccess) {
    state.members = members;
    state.transactions = transactions;
    state.saving = true;
    state.status = "saving";
    state.statusDetail = "저장 중";
    state.error = "";
    render();

    try {
      const result = await saveLedger(members, transactions);
      afterSuccess?.();
      state.status = result.verified ? "ok" : "sent";
      state.statusDetail = result.verified ? "구글 시트에 저장됨" : "저장 요청 전송됨";
      state.lastSynced = new Date();
    } catch (error) {
      state.status = "error";
      state.statusDetail = "저장 실패";
      state.error = error.message || "저장하지 못했습니다.";
    } finally {
      state.saving = false;
      render();
    }
  }

  async function applyRestaurantUpdate(restaurants, reviews, afterSuccess) {
    state.restaurants = restaurants;
    state.reviews = reviews;
    state.saving = true;
    state.status = "saving";
    state.statusDetail = "저장 중";
    state.reviewStoreStatus = "식당 리뷰 저장 중";
    state.error = "";
    render();

    try {
      const result = await saveLedger(state.members, state.transactions, restaurants, reviews);
      afterSuccess?.();
      state.status = result.verified ? "ok" : "sent";
      state.statusDetail = result.verified ? "구글 시트에 저장됨" : "저장 요청 전송됨";
      state.reviewStoreStatus = result.verified
        ? "식당 리뷰가 저장되었습니다."
        : "저장 요청을 보냈습니다. Apps Script가 식당/리뷰 시트를 저장하도록 확장되어야 다른 사람에게도 보입니다.";
      state.lastSynced = new Date();
    } catch (error) {
      state.status = "error";
      state.statusDetail = "저장 실패";
      state.reviewStoreStatus = "식당 리뷰 저장 실패";
      state.error = error.message || "저장하지 못했습니다.";
    } finally {
      state.saving = false;
      render();
    }
  }

  function memberById() {
    return Object.fromEntries(state.members.map((member) => [member.id, member]));
  }

  function computeChanges(txn) {
    switch (txn.type) {
      case "deposit":
        return [{ memberId: txn.memberId, delta: Number(txn.amount) || 0 }];
      case "withdraw":
        return [{ memberId: txn.memberId, delta: -(Number(txn.amount) || 0) }];
      case "transfer":
        return [
          { memberId: txn.fromMemberId, delta: -(Number(txn.amount) || 0) },
          { memberId: txn.toMemberId, delta: Number(txn.amount) || 0 },
        ];
      case "shared": {
        const ids = txn.memberIds || [];
        const per = ids.length ? (Number(txn.amount) || 0) / ids.length : 0;
        return ids.map((id) => ({ memberId: id, delta: -per }));
      }
      case "delivery": {
        const participants = txn.participants || [];
        const sharedPer = participants.length ? (Number(txn.sharedAmount) || 0) / participants.length : 0;
        const total = Number(txn.amount) || 0;
        const payerId = txn.payerId && txn.payerId !== "lab" ? txn.payerId : "";
        return participants.map((part) => {
          const cost = (Number(part.amount) || 0) + sharedPer;
          return { memberId: part.id, delta: -cost + (part.id === payerId ? total : 0) };
        });
      }
      default:
        return [];
    }
  }

  function getMemberHistory(memberId, transactions, currentBalance) {
    const relevant = [];
    [...transactions]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .forEach((txn) => {
        const change = computeChanges(txn).find((item) => item.memberId === memberId);
        if (change) {
          relevant.push({ txn, delta: change.delta });
        }
      });

    let balance = currentBalance;
    const result = [];
    for (let index = relevant.length - 1; index >= 0; index -= 1) {
      result.unshift({ ...relevant[index], balanceAfter: balance });
      balance -= relevant[index].delta;
    }
    return result;
  }

  function avatar(name, size = 38) {
    const text = String(name || "?");
    const index = text.charCodeAt(0) % avatarPalette.length;
    const [bg, fg] = avatarPalette[index];
    return `<span class="avatar" style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.38)}px">${escapeHtml(text.slice(0, 1))}</span>`;
  }

  function statusClass() {
    if (state.status === "ok") return "ok";
    if (state.status === "saving") return "saving";
    if (state.status === "error") return "error";
    if (state.status === "cached" || state.status === "sent") return "warn";
    return "";
  }

  function statusText() {
    const suffix = state.lastSynced
      ? ` · ${state.lastSynced.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
      : "";
    return `${state.statusDetail}${suffix}`;
  }

  function render() {
    app.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div>
            <h1 class="title">연구실 장부</h1>
            <div class="subline">
              <span class="status-pill ${statusClass()}">${state.status === "saving" ? '<span class="spinner" aria-hidden="true"></span>' : ""}${escapeHtml(statusText())}</span>
              <span>${fmt(THRESHOLD)}원 미만 충전 · 목표 ${fmt(BASELINE)}원</span>
            </div>
          </div>
          <div class="actions">
            <button class="btn" data-action="refresh" ${state.saving ? "disabled" : ""}>새로고침</button>
          </div>
        </header>
        ${state.error ? `<div class="error-box">${escapeHtml(state.error)}</div>` : ""}
        <nav class="tabbar" aria-label="장부 메뉴">
          ${[
            ["home", "잔액현황"],
            ["txn", "거래입력"],
            ["history", "거래내역"],
            ["members", "멤버관리"],
            ["restaurants", "식당 리뷰"],
          ].map(([id, label]) => `<button class="tab ${state.activeTab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}</button>`).join("")}
        </nav>
        <main>${renderMain()}</main>
      </div>
      ${renderModal()}
    `;
    if (state.activeTab === "restaurants") {
      window.requestAnimationFrame(initRestaurantMap);
    }
  }

  function renderMain() {
    if (state.status === "loading" && state.members.length === 0) {
      return `<div class="boot"><div class="spinner" aria-hidden="true"></div><div>구글 시트에서 데이터를 불러오는 중...</div></div>`;
    }

    if (state.status === "error" && state.members.length === 0) {
      return `
        <div class="empty">
          <div>
            <strong>데이터를 불러오지 못했습니다.</strong>
            <div class="note" style="margin-top:6px">네트워크나 Google Apps Script 접근 상태를 확인한 뒤 새로고침해 주세요.</div>
          </div>
        </div>
      `;
    }

    if (state.activeTab === "txn") return renderTransactionTab();
    if (state.activeTab === "history") return renderHistoryTab();
    if (state.activeTab === "members") return renderMembersTab();
    if (state.activeTab === "restaurants") return renderRestaurantTab();
    return renderHomeTab();
  }

  function renderHomeTab() {
    const total = state.members.reduce((sum, member) => sum + member.balance, 0);
    const below = state.members.filter((member) => member.balance < THRESHOLD);
    const sorted = [...state.members].sort((a, b) => a.balance - b.balance);

    return `
      <section class="grid">
        <div class="grid two">
          <div class="metric">
            <div class="metric-label">전체 잔액</div>
            <div class="metric-value">${fmt(total)}원</div>
          </div>
          <div class="metric">
            <div class="metric-label">충전 필요</div>
            <div class="metric-value" style="color:${below.length ? "var(--bad)" : "var(--good)"}">${below.length}명</div>
          </div>
        </div>

        <div>
          <div class="section-title">개인별 잔액</div>
          <div class="stack">
            ${sorted.map(renderBalanceCard).join("") || `<div class="empty">멤버가 없습니다</div>`}
          </div>
        </div>

        ${below.length ? `
          <div>
            <div class="section-title">충전 필요 목록</div>
            <div class="alert-list">
              ${below.map((member) => `
                <div class="alert-item">
                  <div class="row" style="justify-content:flex-start">${avatar(member.name, 30)}<strong>${escapeHtml(member.name)}</strong></div>
                  <div class="amount neg">+${fmt(BASELINE - member.balance)}원 납부 필요</div>
                </div>
              `).join("")}
            </div>
          </div>
        ` : ""}
      </section>
    `;
  }

  function renderBalanceCard(member) {
    const low = member.balance < THRESHOLD;
    const percentage = Math.min(100, Math.max(0, (member.balance / BASELINE) * 100));
    const threshold = Math.min(100, Math.max(0, (THRESHOLD / BASELINE) * 100));
    const diff = member.balance - THRESHOLD;
    return `
      <article class="card member-card ${low ? "low" : ""}">
        ${avatar(member.name)}
        <div>
          <div class="row">
            <div class="name">${escapeHtml(member.name)}</div>
            <div class="amount ${low ? "neg" : ""}">${fmt(member.balance)}원</div>
          </div>
          <div class="gauge ${low ? "low" : ""}">
            <span style="width:${percentage}%"></span>
            <i class="threshold" style="left:${threshold}%"></i>
          </div>
          <div class="note" style="margin-top:5px;color:${low ? "var(--bad)" : "var(--muted)"}">
            ${low ? `충전 필요 · ${fmt(BASELINE - member.balance)}원 납부` : `여유 +${fmt(diff)}원`}
          </div>
        </div>
      </article>
    `;
  }

  function renderTransactionTab() {
    const typeButtons = Object.entries(txLabels).map(([id, label]) => `
      <button class="chip ${state.txType === id ? "active" : ""}" data-action="tx-type" data-type="${id}">${label}</button>
    `).join("");

    return `
      <section class="grid sidebar">
        <div class="metric">
          <div class="metric-label">거래 종류</div>
          <div class="chips" style="margin-top:12px">${typeButtons}</div>
        </div>
        ${renderCurrentTransactionForm()}
      </section>
    `;
  }

  function renderCurrentTransactionForm() {
    if (state.txType === "shared") return renderSharedForm();
    if (state.txType === "transfer") return renderTransferForm();
    if (state.txType === "delivery") return renderDeliveryForm();
    return renderDepositWithdrawForm(state.txType);
  }

  function memberChips(options) {
    const { selected = [], action = "select-member", group, disabledId = "" } = options;
    return state.members.map((member) => {
      const active = selected.includes(member.id);
      const disabled = disabledId && disabledId === member.id;
      return `<button class="chip ${active ? "active" : ""}" data-action="${action}" data-group="${group}" data-id="${member.id}" ${disabled ? "disabled" : ""}>${escapeHtml(member.name)}</button>`;
    }).join("");
  }

  function renderDepositWithdrawForm(type) {
    const current = form[type];
    return `
      <form class="form-panel" data-form-root="${type}">
        <div class="field">
          <div class="field-label">대상 멤버</div>
          <div class="chips">${memberChips({ selected: current.memberId ? [current.memberId] : [], group: type })}</div>
        </div>
        <div class="field">
          <label for="${type}-amount">금액</label>
          <div class="input-money">
            <input id="${type}-amount" inputmode="numeric" type="number" min="0" data-form="${type}" data-field="amount" value="${escapeHtml(current.amount)}" placeholder="0">
            <span>원</span>
          </div>
        </div>
        <div class="field">
          <label for="${type}-memo">메모</label>
          <input id="${type}-memo" type="text" data-form="${type}" data-field="memo" value="${escapeHtml(current.memo)}" placeholder="내용을 입력하세요">
        </div>
        ${renderSaveButton()}
      </form>
    `;
  }

  function renderSharedForm() {
    const current = form.shared;
    const ids = current.memberIds.length ? current.memberIds : state.members.map((member) => member.id);
    const amount = parseMoney(current.amount);
    const per = ids.length ? amount / ids.length : 0;
    const allSelected = current.memberIds.length === state.members.length;

    return `
      <form class="form-panel" data-form-root="shared">
        <div class="field">
          <div class="field-label">참여 멤버</div>
          <div class="chips">
            ${memberChips({ selected: current.memberIds, group: "shared" })}
            <button class="chip" data-action="shared-all">${allSelected ? "전체 해제" : "전체"}</button>
          </div>
          <div class="note">아무도 선택하지 않으면 전체 멤버에게 균등 분배됩니다.</div>
        </div>
        <div class="field">
          <label for="shared-amount">금액</label>
          <div class="input-money">
            <input id="shared-amount" inputmode="numeric" type="number" min="0" data-form="shared" data-field="amount" value="${escapeHtml(current.amount)}" placeholder="0">
            <span>원</span>
          </div>
          <div class="note" id="shared-hint">${amount > 0 ? `1인당 ${fmt(per)}원 · ${ids.length}명` : ""}</div>
        </div>
        <div class="field">
          <label for="shared-memo">메모</label>
          <input id="shared-memo" type="text" data-form="shared" data-field="memo" value="${escapeHtml(current.memo)}" placeholder="간식비, 행사비 등">
        </div>
        ${renderSaveButton()}
      </form>
    `;
  }

  function renderTransferForm() {
    const current = form.transfer;
    const amount = parseMoney(current.amount);
    const fromName = state.members.find((member) => member.id === current.fromMemberId)?.name || "";
    const toName = state.members.find((member) => member.id === current.toMemberId)?.name || "";

    return `
      <form class="form-panel" data-form-root="transfer">
        <div class="field">
          <div class="field-label">보내는 사람</div>
          <div class="chips">${memberChips({ selected: current.fromMemberId ? [current.fromMemberId] : [], group: "transfer-from" })}</div>
        </div>
        <div class="field">
          <div class="field-label">받는 사람</div>
          <div class="chips">${memberChips({ selected: current.toMemberId ? [current.toMemberId] : [], group: "transfer-to", disabledId: current.fromMemberId })}</div>
        </div>
        <div class="field">
          <label for="transfer-amount">금액</label>
          <div class="input-money">
            <input id="transfer-amount" inputmode="numeric" type="number" min="0" data-form="transfer" data-field="amount" value="${escapeHtml(current.amount)}" placeholder="0">
            <span>원</span>
          </div>
          <div class="note" id="transfer-hint">${fromName && toName && amount > 0 ? `${escapeHtml(fromName)} → ${escapeHtml(toName)} · ${fmt(amount)}원` : ""}</div>
        </div>
        <div class="field">
          <label for="transfer-memo">메모</label>
          <input id="transfer-memo" type="text" data-form="transfer" data-field="memo" value="${escapeHtml(current.memo)}" placeholder="내용을 입력하세요">
        </div>
        ${renderSaveButton()}
      </form>
    `;
  }

  function renderDeliveryForm() {
    const current = form.delivery;
    const selectedMembers = current.memberIds.map((id) => state.members.find((member) => member.id === id)).filter(Boolean);
    const sharedAmount = parseMoney(current.sharedAmount);
    const preview = deliveryPreview();
    const total = preview.reduce((sum, item) => sum + item.individual, 0) + sharedAmount;

    return `
      <form class="form-panel" data-form-root="delivery">
        <div class="field">
          <div class="field-label">참여 멤버</div>
          <div class="chips">${memberChips({ selected: current.memberIds, group: "delivery" })}</div>
        </div>
        ${selectedMembers.length ? `
          <div class="field">
            <div class="field-label">개인 금액</div>
            <div class="mini-grid">
              ${selectedMembers.map((member) => `
                <div class="member-input-row">
                  ${avatar(member.name, 30)}
                  <strong>${escapeHtml(member.name)}</strong>
                  <div class="input-money">
                    <input type="number" min="0" inputmode="numeric" data-form="delivery" data-field="amounts" data-id="${member.id}" value="${escapeHtml(current.amounts[member.id] || "")}" placeholder="0">
                    <span>원</span>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        ` : ""}
        <div class="field">
          <label for="delivery-shared">공동 금액</label>
          <div class="input-money">
            <input id="delivery-shared" inputmode="numeric" type="number" min="0" data-form="delivery" data-field="sharedAmount" value="${escapeHtml(current.sharedAmount)}" placeholder="0">
            <span>원</span>
          </div>
          <div class="note">${selectedMembers.length && sharedAmount > 0 ? `1인당 +${fmt(sharedAmount / selectedMembers.length)}원` : "배달팁이나 공동메뉴처럼 균등 분배할 금액입니다."}</div>
        </div>
        <div class="field">
          <div class="field-label">결제자</div>
          <div class="chips">
            <button class="chip ${current.payerId === "lab" ? "active" : ""}" data-action="payer" data-id="lab">랩비카드</button>
            ${selectedMembers.map((member) => `<button class="chip ${current.payerId === member.id ? "active" : ""}" data-action="payer" data-id="${member.id}">${escapeHtml(member.name)}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label for="delivery-memo">메모</label>
          <input id="delivery-memo" type="text" data-form="delivery" data-field="memo" value="${escapeHtml(current.memo)}" placeholder="음식점, 택시, 회식 등">
        </div>
        ${selectedMembers.length ? `<div id="delivery-preview">${total > 0 ? renderDeliveryPreview() : ""}</div>` : ""}
        ${renderSaveButton()}
      </form>
    `;
  }

  function renderSaveButton() {
    return `
      <button class="btn primary" type="button" data-action="submit-txn" ${state.saving ? "disabled" : ""}>
        ${state.saving ? '<span class="saving-inline"><span class="spinner" aria-hidden="true"></span>저장 중...</span>' : "저장"}
      </button>
    `;
  }

  function deliveryPreview() {
    const current = form.delivery;
    const participants = current.memberIds.map((id) => ({
      id,
      individual: parseMoney(current.amounts[id]),
    }));
    const sharedAmount = parseMoney(current.sharedAmount);
    const sharedPer = participants.length ? sharedAmount / participants.length : 0;
    const total = participants.reduce((sum, item) => sum + item.individual, 0) + sharedAmount;

    return participants.map((item) => {
      const cost = item.individual + sharedPer;
      const isPayer = current.payerId === item.id;
      return { ...item, cost, delta: -cost + (isPayer ? total : 0), isPayer };
    });
  }

  function renderDeliveryPreview() {
    const byId = memberById();
    const preview = deliveryPreview();
    const sharedAmount = parseMoney(form.delivery.sharedAmount);
    const total = preview.reduce((sum, item) => sum + item.individual, 0) + sharedAmount;

    return `
      <div class="preview">
        <div class="section-title" style="margin:0">정산 미리보기</div>
        ${preview.map((item) => {
          const member = byId[item.id];
          return `
            <div class="row">
              <div class="row" style="justify-content:flex-start">
                ${avatar(member?.name || "?", 26)}
                <strong>${escapeHtml(member?.name || "?")}</strong>
                ${item.isPayer && form.delivery.payerId !== "lab" ? `<span class="status-pill" style="min-height:22px">결제자</span>` : ""}
              </div>
              <div class="amount ${item.delta >= 0 ? "pos" : "neg"}">${item.delta >= 0 ? "+" : ""}${fmt(item.delta)}원</div>
            </div>
          `;
        }).join("")}
        <div class="row" style="border-top:1px solid var(--line);padding-top:8px">
          <span class="note">합계</span>
          <strong>${fmt(total)}원</strong>
        </div>
      </div>
    `;
  }

  function restaurantById() {
    return Object.fromEntries(state.restaurants.map((restaurant) => [restaurant.id, restaurant]));
  }

  function reviewsForRestaurant(restaurantId) {
    return state.reviews
      .filter((review) => review.restaurantId === restaurantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function averageRating(restaurantId) {
    const reviews = reviewsForRestaurant(restaurantId);
    if (!reviews.length) return 0;
    return reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length;
  }

  function starText(rating) {
    const rounded = Math.round(Number(rating) || 0);
    return "★".repeat(rounded) + "☆".repeat(Math.max(0, 5 - rounded));
  }

  function selectedRestaurant() {
    return state.restaurants.find((restaurant) => restaurant.id === state.selectedRestaurantId) || null;
  }

  function renderRestaurantTab() {
    const selected = selectedRestaurant();
    const sortedRestaurants = [...state.restaurants].sort((a, b) => {
      const avgDiff = averageRating(b.id) - averageRating(a.id);
      if (avgDiff) return avgDiff;
      return reviewsForRestaurant(b.id).length - reviewsForRestaurant(a.id).length;
    });
    const totalReviews = state.reviews.length;
    const overallAverage = totalReviews
      ? state.reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / totalReviews
      : 0;

    return `
      <section class="grid">
        <div class="grid two">
          <div class="metric">
            <div class="metric-label">등록 식당</div>
            <div class="metric-value">${state.restaurants.length}곳</div>
          </div>
          <div class="metric">
            <div class="metric-label">리뷰 평균</div>
            <div class="metric-value">${totalReviews ? overallAverage.toFixed(1) : "-"}점</div>
          </div>
        </div>

        <div class="restaurant-layout">
          <div class="card restaurant-map-card">
            <div id="restaurant-map" class="restaurant-map" aria-label="식당 지도"></div>
            ${state.restaurantMapError ? `<div class="error-box">${escapeHtml(state.restaurantMapError)}</div>` : ""}
            <div class="note">Kakao 지도에서 식당을 검색하고 마커로 확인할 수 있습니다.</div>
          </div>

          <form class="form-panel" data-form-root="restaurant">
            <div class="field">
              <label for="restaurant-query">식당 검색</label>
              <div class="search-row">
                <input id="restaurant-query" type="search" data-form="restaurant" data-field="query" value="${escapeHtml(form.restaurant.query)}" placeholder="식당 이름 또는 장소">
                <button class="btn" type="button" data-action="restaurant-search" ${state.saving ? "disabled" : ""}>검색</button>
              </div>
            </div>

            ${state.restaurantSearchResults.length ? `
              <div class="field">
                <div class="field-label">검색 결과</div>
                <div class="restaurant-results">
                  ${state.restaurantSearchResults.map((place) => `
                    <button class="restaurant-result" type="button" data-action="select-restaurant-result" data-place-id="${escapeHtml(place.providerPlaceId)}">
                      <strong>${escapeHtml(place.name)}</strong>
                      <span>${escapeHtml(place.address || "주소 정보 없음")}</span>
                    </button>
                  `).join("")}
                </div>
              </div>
            ` : ""}

            <div class="field">
              <div class="field-label">선택한 식당</div>
              ${selected ? `
                <div class="selected-restaurant">
                  <strong>${escapeHtml(selected.name)}</strong>
                  <span>${escapeHtml(selected.address || "주소 정보 없음")}</span>
                  ${selected.placeUrl ? `<a href="${escapeHtml(selected.placeUrl)}" target="_blank" rel="noreferrer">카카오맵에서 보기</a>` : ""}
                </div>
              ` : `<div class="note">검색 결과나 아래 목록에서 식당을 선택해 주세요.</div>`}
            </div>

            <div class="field">
              <label for="review-member">작성자</label>
              <select id="review-member" data-form="restaurant" data-field="memberId">
                <option value="">멤버 선택</option>
                ${state.members.map((member) => `<option value="${member.id}" ${form.restaurant.memberId === member.id ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("")}
              </select>
            </div>

            <div class="field">
              <label for="review-rating">별점</label>
              <select id="review-rating" data-form="restaurant" data-field="rating">
                ${[5, 4, 3, 2, 1].map((rating) => `<option value="${rating}" ${String(form.restaurant.rating) === String(rating) ? "selected" : ""}>${rating}점 ${starText(rating)}</option>`).join("")}
              </select>
            </div>

            <div class="field">
              <label for="review-comment">평가</label>
              <textarea id="review-comment" data-form="restaurant" data-field="comment" rows="4" placeholder="메뉴, 분위기, 재방문 의사 등을 남겨주세요.">${escapeHtml(form.restaurant.comment)}</textarea>
            </div>

            ${state.reviewStoreStatus ? `<div class="note">${escapeHtml(state.reviewStoreStatus)}</div>` : ""}

            <button class="btn primary" type="button" data-action="submit-review" ${state.saving ? "disabled" : ""}>
              ${state.saving ? '<span class="saving-inline"><span class="spinner" aria-hidden="true"></span>저장 중...</span>' : "리뷰 저장"}
            </button>
          </form>
        </div>

        <div>
          <div class="section-title">식당 목록</div>
          <div class="restaurant-list">
            ${sortedRestaurants.length ? sortedRestaurants.map(renderRestaurantCard).join("") : `<div class="empty">등록된 식당 리뷰가 없습니다</div>`}
          </div>
        </div>
      </section>
    `;
  }

  function renderRestaurantCard(restaurant) {
    const reviews = reviewsForRestaurant(restaurant.id);
    const avg = averageRating(restaurant.id);
    const byId = memberById();
    const selected = state.selectedRestaurantId === restaurant.id;

    return `
      <article class="card restaurant-card ${selected ? "selected" : ""}">
        <div class="restaurant-card-head">
          <div>
            <div class="row wrap" style="justify-content:flex-start">
              <strong class="restaurant-name">${escapeHtml(restaurant.name)}</strong>
              <span class="rating-badge">${reviews.length ? `${avg.toFixed(1)} ${starText(avg)}` : "리뷰 없음"}</span>
            </div>
            <div class="note">${escapeHtml(restaurant.address || "주소 정보 없음")}</div>
          </div>
          <div class="actions">
            <button class="btn" type="button" data-action="select-restaurant" data-id="${restaurant.id}">선택</button>
            ${restaurant.placeUrl ? `<a class="btn" href="${escapeHtml(restaurant.placeUrl)}" target="_blank" rel="noreferrer">지도</a>` : ""}
          </div>
        </div>
        <div class="review-stack">
          ${reviews.length ? reviews.map((review) => `
            <div class="review-item">
              <div>
                <div class="row wrap" style="justify-content:flex-start">
                  <strong>${escapeHtml(byId[review.memberId]?.name || "익명")}</strong>
                  <span class="stars">${starText(review.rating)}</span>
                  <span class="note">${new Date(review.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })}</span>
                </div>
                ${review.comment ? `<div class="review-comment">${escapeHtml(review.comment)}</div>` : ""}
              </div>
              <button class="btn danger" type="button" data-action="delete-review" data-id="${review.id}" ${state.saving ? "disabled" : ""}>삭제</button>
            </div>
          `).join("") : `<div class="note">아직 리뷰가 없습니다.</div>`}
        </div>
      </article>
    `;
  }

  function loadKakaoMaps() {
    if (window.kakao?.maps?.services) return Promise.resolve();
    if (kakaoLoader) return kakaoLoader;

    kakaoLoader = new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-kakao-map]");
      if (existing) {
        existing.addEventListener("load", () => window.kakao.maps.load(resolve), { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.dataset.kakaoMap = "true";
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false&libraries=services`;
      script.async = true;
      script.onload = () => window.kakao.maps.load(resolve);
      script.onerror = () => reject(new Error("Kakao 지도 SDK를 불러오지 못했습니다."));
      document.head.appendChild(script);
    });

    return kakaoLoader;
  }

  async function initRestaurantMap() {
    if (state.activeTab !== "restaurants") return;
    const target = document.getElementById("restaurant-map");
    if (!target) return;

    try {
      await loadKakaoMaps();
      if (!restaurantMap || restaurantMap.__target !== target) {
        const center = new kakao.maps.LatLng(36.3504, 127.3845);
        restaurantMap = new kakao.maps.Map(target, { center, level: 5 });
        restaurantMap.__target = target;
        restaurantInfoWindow = new kakao.maps.InfoWindow({ zIndex: 10 });
      }
      state.restaurantMapError = "";
      renderRestaurantMarkers();
    } catch (error) {
      state.restaurantMapError = error.message || "지도를 불러오지 못했습니다.";
      const message = String(state.restaurantMapError);
      if (message.includes("등록") || message.includes("domain") || message.includes("도메인")) {
        state.restaurantMapError += " Kakao Developers의 JavaScript SDK 도메인에는 https://kawasironitori.github.io 도 함께 등록되어 있어야 합니다.";
      }
      target.classList.add("map-error");
      target.textContent = state.restaurantMapError;
      const box = target.parentElement?.querySelector(".error-box");
      if (box) box.textContent = state.restaurantMapError;
    }
  }

  function renderRestaurantMarkers() {
    if (!restaurantMap || !window.kakao?.maps) return;
    restaurantMarkers.forEach((marker) => marker.setMap(null));
    restaurantMarkers = [];

    const bounds = new kakao.maps.LatLngBounds();
    const restaurants = state.restaurants.filter((restaurant) => restaurant.lat && restaurant.lng);

    restaurants.forEach((restaurant) => {
      const position = new kakao.maps.LatLng(restaurant.lat, restaurant.lng);
      const marker = new kakao.maps.Marker({ map: restaurantMap, position, title: restaurant.name });
      kakao.maps.event.addListener(marker, "click", () => {
        state.selectedRestaurantId = restaurant.id;
        restaurantInfoWindow.setContent(`<div style="padding:8px 10px;font-size:13px;font-weight:700">${escapeHtml(restaurant.name)}</div>`);
        restaurantInfoWindow.open(restaurantMap, marker);
        render();
      });
      restaurantMarkers.push(marker);
      bounds.extend(position);
    });

    if (restaurants.length > 1) {
      restaurantMap.setBounds(bounds);
    } else if (restaurants.length === 1) {
      restaurantMap.setCenter(new kakao.maps.LatLng(restaurants[0].lat, restaurants[0].lng));
      restaurantMap.setLevel(4);
    }
  }

  async function searchRestaurants() {
    syncInputs();
    const query = form.restaurant.query.trim();
    if (!query) return setStatusError("검색할 식당 이름을 입력해 주세요.");

    state.reviewStoreStatus = "식당 검색 중";
    state.restaurantMapError = "";
    render();

    try {
      await loadKakaoMaps();
      const places = new kakao.maps.services.Places();
      const results = await new Promise((resolve, reject) => {
        places.keywordSearch(query, (data, status) => {
          if (status === kakao.maps.services.Status.OK) return resolve(data);
          if (status === kakao.maps.services.Status.ZERO_RESULT) return resolve([]);
          reject(new Error("식당 검색에 실패했습니다."));
        }, { category_group_code: "FD6" });
      });

      state.restaurantSearchResults = results.slice(0, 8).map((place) => ({
        id: `kakao-${place.id}`,
        provider: "kakao",
        providerPlaceId: String(place.id),
        name: place.place_name,
        address: place.road_address_name || place.address_name || "",
        lat: Number(place.y) || 0,
        lng: Number(place.x) || 0,
        phone: place.phone || "",
        category: place.category_name || "",
        placeUrl: place.place_url || "",
        createdAt: new Date().toISOString(),
      }));
      state.reviewStoreStatus = state.restaurantSearchResults.length ? "" : "검색 결과가 없습니다.";
    } catch (error) {
      state.restaurantSearchResults = [];
      state.reviewStoreStatus = "";
      state.restaurantMapError = error.message || "식당 검색에 실패했습니다.";
    }

    render();
  }

  function selectRestaurantCandidate(providerPlaceId) {
    syncInputs();
    const candidate = state.restaurantSearchResults.find((place) => place.providerPlaceId === providerPlaceId);
    if (!candidate) return;

    const existing = state.restaurants.find((restaurant) => restaurant.provider === "kakao" && restaurant.providerPlaceId === providerPlaceId);
    if (existing) {
      state.selectedRestaurantId = existing.id;
    } else {
      const restaurant = { ...candidate, id: uid() };
      state.restaurants = [restaurant, ...state.restaurants];
      state.selectedRestaurantId = restaurant.id;
      saveCache({
        members: state.members,
        transactions: state.transactions,
        restaurants: state.restaurants,
        reviews: state.reviews,
      });
    }
    state.reviewStoreStatus = "식당을 선택했습니다. 리뷰를 남기면 저장됩니다.";
    render();
  }

  async function submitReview() {
    syncInputs();
    const restaurant = selectedRestaurant();
    if (!restaurant) return setStatusError("리뷰를 남길 식당을 먼저 선택해 주세요.");
    if (!form.restaurant.memberId) return setStatusError("작성자 멤버를 선택해 주세요.");
    const rating = Math.max(1, Math.min(5, Number(form.restaurant.rating) || 5));
    const comment = form.restaurant.comment.trim();

    const restaurants = state.restaurants.some((item) => item.id === restaurant.id)
      ? state.restaurants
      : [restaurant, ...state.restaurants];
    const review = {
      id: uid(),
      restaurantId: restaurant.id,
      memberId: form.restaurant.memberId,
      rating,
      comment,
      createdAt: new Date().toISOString(),
    };

    await applyRestaurantUpdate(restaurants, [review, ...state.reviews], () => {
      form.restaurant.comment = "";
      form.restaurant.rating = "5";
    });
  }

  async function deleteReview(reviewId) {
    const review = state.reviews.find((item) => item.id === reviewId);
    if (!review) return;
    if (!window.confirm("이 식당 리뷰를 삭제할까요?")) return;
    await applyRestaurantUpdate(state.restaurants, state.reviews.filter((item) => item.id !== reviewId));
  }

  function renderHistoryTab() {
    const filters = [
      ["all", "전체"],
      ["deposit", "입금"],
      ["withdraw", "출금"],
      ["transfer", "송금"],
      ["shared", "공동"],
      ["delivery", "배달"],
    ];
    const transactions = state.historyFilter === "all"
      ? state.transactions
      : state.transactions.filter((txn) => txn.type === state.historyFilter);

    return `
      <section class="grid">
        <div class="chips">
          ${filters.map(([id, label]) => `<button class="chip ${state.historyFilter === id ? "active" : ""}" data-action="history-filter" data-filter="${id}">${label}</button>`).join("")}
        </div>
        <div class="stack">
          ${transactions.length ? transactions.map(renderHistoryItem).join("") : `<div class="empty">거래 내역이 없습니다</div>`}
        </div>
      </section>
    `;
  }

  function txnInfo(txn) {
    const byId = memberById();
    if (txn.type === "deposit") {
      return { label: `${byId[txn.memberId]?.name || "?"} 입금`, glyph: "+", bg: "var(--good-soft)", color: "var(--good)", amount: `+${fmt(txn.amount)}원` };
    }
    if (txn.type === "withdraw") {
      return { label: `${byId[txn.memberId]?.name || "?"} 출금`, glyph: "-", bg: "var(--bad-soft)", color: "var(--bad)", amount: `-${fmt(txn.amount)}원` };
    }
    if (txn.type === "transfer") {
      return { label: `${byId[txn.fromMemberId]?.name || "?"} → ${byId[txn.toMemberId]?.name || "?"}`, glyph: "↔", bg: "var(--violet-soft)", color: "var(--violet)", amount: `${fmt(txn.amount)}원` };
    }
    if (txn.type === "shared") {
      const names = (txn.memberIds || []).map((id) => byId[id]?.name).filter(Boolean).join(", ");
      return { label: `공동지출 · ${names}`, glyph: "÷", bg: "var(--blue-soft)", color: "var(--bad)", amount: `-${fmt(txn.amount)}원` };
    }
    if (txn.type === "delivery") {
      const names = (txn.participants || []).map((part) => byId[part.id]?.name).filter(Boolean).join(", ");
      return { label: `배달정산 · ${names}`, glyph: "배", bg: "var(--warn-soft)", color: "var(--warn)", amount: `${fmt(txn.amount)}원` };
    }
    return { label: "기타", glyph: "·", bg: "#f4f4f5", color: "var(--muted)", amount: `${fmt(txn.amount)}원` };
  }

  function renderHistoryItem(txn) {
    const info = txnInfo(txn);
    const date = new Date(txn.date).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const expanded = state.expandedTxnId === txn.id;
    return `
      <article class="card history-item">
        <div class="history-head">
          <div class="type-badge" style="background:${info.bg};color:${info.color}">${escapeHtml(info.glyph)}</div>
          <div>
            <div class="history-title">${escapeHtml(txn.memo || info.label)}</div>
            <div class="history-meta">${escapeHtml(txn.memo ? `${info.label} · ${date}` : date)}</div>
          </div>
          <div class="amount" style="color:${info.color}">${escapeHtml(info.amount)}</div>
          <div class="row" style="justify-content:flex-end">
            ${txn.type === "delivery" ? `<button class="btn" data-action="expand-txn" data-id="${txn.id}">${expanded ? "접기" : "자세히"}</button>` : ""}
            <button class="btn danger" data-action="delete-txn" data-id="${txn.id}" ${state.saving ? "disabled" : ""}>삭제</button>
          </div>
        </div>
        ${expanded ? renderDeliveryDetail(txn) : ""}
      </article>
    `;
  }

  function renderDeliveryDetail(txn) {
    const byId = memberById();
    const participants = txn.participants || [];
    const sharedPer = participants.length ? (Number(txn.sharedAmount) || 0) / participants.length : 0;
    const payerName = txn.payerId && txn.payerId !== "lab" ? byId[txn.payerId]?.name || "?" : "랩비카드";

    return `
      <div class="detail">
        ${participants.map((part) => {
          const member = byId[part.id];
          const individual = Number(part.amount) || 0;
          const total = individual + sharedPer;
          return `
            <div class="detail-row">
              ${avatar(member?.name || "?", 28)}
              <strong>${escapeHtml(member?.name || "?")}${part.id === txn.payerId ? " · 결제자" : ""}</strong>
              <div class="amount">${fmt(total)}원</div>
            </div>
          `;
        }).join("") || `<div class="note">참여자 정보가 없습니다.</div>`}
        <div class="row" style="border-top:1px solid var(--line);padding-top:10px;margin-top:8px">
          <span class="note">결제: ${escapeHtml(payerName)} · 공동금액 ${fmt(txn.sharedAmount || 0)}원</span>
          <strong>${fmt(txn.amount)}원</strong>
        </div>
      </div>
    `;
  }

  function renderMembersTab() {
    return `
      <section class="grid sidebar">
        <form class="form-panel" data-form-root="member">
          <div class="field">
            <label for="member-name">이름</label>
            <input id="member-name" type="text" data-form="member" data-field="name" value="${escapeHtml(form.member.name)}" placeholder="새 멤버 이름">
          </div>
          <div class="field">
            <label for="member-balance">초기 잔액</label>
            <div class="input-money">
              <input id="member-balance" type="number" inputmode="numeric" data-form="member" data-field="balance" value="${escapeHtml(form.member.balance)}">
              <span>원</span>
            </div>
          </div>
          <button class="btn primary" type="button" data-action="add-member" ${state.saving ? "disabled" : ""}>멤버 추가</button>
        </form>
        <div>
          <div class="section-title">멤버 목록 (${state.members.length}명)</div>
          <div class="stack">
            ${state.members.map(renderMemberManagerCard).join("") || `<div class="empty">멤버가 없습니다</div>`}
          </div>
        </div>
      </section>
    `;
  }

  function renderMemberManagerCard(member) {
    const expanded = state.expandedMemberId === member.id;
    const editing = form.editMemberId === member.id;
    const low = member.balance < THRESHOLD;
    return `
      <article class="card">
        <div class="member-card ${low ? "low" : ""}" style="grid-template-columns:auto minmax(0,1fr) auto">
          ${avatar(member.name)}
          <div>
            <div class="row wrap">
              <strong>${escapeHtml(member.name)}</strong>
              ${low ? `<span class="status-pill error" style="min-height:22px">충전 필요</span>` : ""}
            </div>
            ${editing ? `
              <div class="row" style="justify-content:flex-start;margin-top:8px">
                <input type="number" data-form="edit" data-field="balance" value="${escapeHtml(form.editBalance)}" style="max-width:150px">
                <button class="btn" data-action="save-member-edit" data-id="${member.id}">저장</button>
                <button class="btn ghost" data-action="cancel-member-edit">취소</button>
              </div>
            ` : `<div class="note" style="margin-top:4px">${fmt(member.balance)}원</div>`}
          </div>
          <div class="actions">
            <button class="btn" data-action="expand-member" data-id="${member.id}">${expanded ? "접기" : "이력"}</button>
            <button class="btn" data-action="edit-member" data-id="${member.id}">수정</button>
            <button class="btn danger" data-action="delete-member" data-id="${member.id}" ${state.saving ? "disabled" : ""}>삭제</button>
          </div>
        </div>
        ${expanded ? renderMemberHistory(member) : ""}
      </article>
    `;
  }

  function renderMemberHistory(member) {
    const history = getMemberHistory(member.id, state.transactions, member.balance).reverse();
    return `
      <div class="detail" style="margin:0 14px 14px">
        ${history.length ? history.map(({ txn, delta, balanceAfter }) => {
          const date = new Date(txn.date).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `
            <div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
              <div style="min-width:0">
                <strong style="font-size:13px">${escapeHtml(txn.memo || txLabels[txn.type] || "거래")}</strong>
                <div class="note">${escapeHtml(date)} · 잔액 ${fmt(balanceAfter)}원</div>
              </div>
              <div class="amount ${delta >= 0 ? "pos" : "neg"}">${delta >= 0 ? "+" : ""}${fmt(delta)}원</div>
            </div>
          `;
        }).join("") : `<div class="note">거래 이력이 없습니다.</div>`}
      </div>
    `;
  }

  function renderModal() {
    if (!state.modal) return "";
    const { type, id } = state.modal;
    const isTxn = type === "deleteTxn";
    const target = isTxn ? state.transactions.find((txn) => txn.id === id) : state.members.find((member) => member.id === id);
    const message = isTxn
      ? `${txnInfo(target || {}).label}${target?.memo ? ` · ${target.memo}` : ""}`
      : `${target?.name || "선택한 멤버"} 멤버`;

    return `
      <div class="modal-backdrop" role="presentation">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>정말 삭제할까요?</h2>
          <p>${escapeHtml(message)}를 삭제합니다. ${isTxn ? "잔액은 삭제한 거래만큼 되돌립니다." : "기존 거래 내역의 이름 표시에 영향을 줄 수 있습니다."}</p>
          <div class="modal-actions">
            <button class="btn" data-action="modal-cancel">취소</button>
            <button class="btn danger" data-action="modal-confirm" ${state.saving ? "disabled" : ""}>삭제</button>
          </div>
        </div>
      </div>
    `;
  }

  function syncInputs() {
    app.querySelectorAll("[data-form][data-field]").forEach((input) => {
      const formName = input.dataset.form;
      const field = input.dataset.field;
      if (formName === "delivery" && field === "amounts") {
        form.delivery.amounts[input.dataset.id] = input.value;
      } else if (formName === "edit") {
        form.editBalance = input.value;
      } else if (form[formName]) {
        form[formName][field] = input.value;
      }
    });
  }

  function handleInput(event) {
    const input = event.target.closest("[data-form][data-field]");
    if (!input) return;
    const formName = input.dataset.form;
    const field = input.dataset.field;
    if (formName === "delivery" && field === "amounts") {
      form.delivery.amounts[input.dataset.id] = input.value;
      updateDeliveryPreviewOnly();
    } else if (formName === "edit") {
      form.editBalance = input.value;
    } else if (form[formName]) {
      form[formName][field] = input.value;
      if (formName === "shared" || formName === "transfer" || formName === "delivery") {
        updateDeliveryPreviewOnly();
        updateSharedHintOnly();
        updateTransferHintOnly();
      }
    }
  }

  function updateSharedHintOnly() {
    const hint = document.getElementById("shared-hint");
    if (!hint) return;
    const ids = form.shared.memberIds.length ? form.shared.memberIds : state.members.map((member) => member.id);
    const amount = parseMoney(form.shared.amount);
    hint.textContent = amount > 0 ? `1인당 ${fmt(ids.length ? amount / ids.length : 0)}원 · ${ids.length}명` : "";
  }

  function updateTransferHintOnly() {
    const hint = document.getElementById("transfer-hint");
    if (!hint) return;
    const amount = parseMoney(form.transfer.amount);
    const fromName = state.members.find((member) => member.id === form.transfer.fromMemberId)?.name || "";
    const toName = state.members.find((member) => member.id === form.transfer.toMemberId)?.name || "";
    hint.textContent = fromName && toName && amount > 0 ? `${fromName} → ${toName} · ${fmt(amount)}원` : "";
  }

  function updateDeliveryPreviewOnly() {
    const target = document.getElementById("delivery-preview");
    if (target) {
      const preview = deliveryPreview();
      const sharedAmount = parseMoney(form.delivery.sharedAmount);
      const total = preview.reduce((sum, item) => sum + item.individual, 0) + sharedAmount;
      target.innerHTML = total > 0 ? renderDeliveryPreview() : "";
    }
  }

  function setStatusError(message) {
    state.status = "error";
    state.statusDetail = "확인 필요";
    state.error = message;
    render();
  }

  async function submitTransaction() {
    syncInputs();
    const type = state.txType;
    const now = new Date().toISOString();

    if (type === "deposit" || type === "withdraw") {
      const current = form[type];
      const amount = parseMoney(current.amount);
      if (!current.memberId || amount <= 0) return setStatusError("대상 멤버와 금액을 확인해 주세요.");
      const delta = type === "deposit" ? amount : -amount;
      const members = state.members.map((member) => member.id === current.memberId ? { ...member, balance: member.balance + delta } : member);
      const txn = {
        id: uid(),
        date: now,
        type,
        amount,
        memo: current.memo,
        memberId: current.memberId,
        memberIds: [],
        amountPerPerson: 0,
        fromMemberId: "",
        toMemberId: "",
        payerId: "",
        sharedAmount: 0,
        participants: [],
      };
      await applyUpdate(members, [txn, ...state.transactions], () => {
        form[type] = { memberId: "", amount: "", memo: "" };
      });
      return;
    }

    if (type === "shared") {
      const current = form.shared;
      const amount = parseMoney(current.amount);
      if (amount <= 0) return setStatusError("공동지출 금액을 확인해 주세요.");
      const ids = current.memberIds.length ? current.memberIds : state.members.map((member) => member.id);
      if (!ids.length) return setStatusError("공동지출을 나눌 멤버가 없습니다.");
      const per = amount / ids.length;
      const members = state.members.map((member) => ids.includes(member.id) ? { ...member, balance: member.balance - per } : member);
      const txn = {
        id: uid(),
        date: now,
        type: "shared",
        amount,
        memo: current.memo,
        memberId: "",
        memberIds: ids,
        amountPerPerson: per,
        fromMemberId: "",
        toMemberId: "",
        payerId: "",
        sharedAmount: 0,
        participants: [],
      };
      await applyUpdate(members, [txn, ...state.transactions], () => {
        form.shared = { memberIds: [], amount: "", memo: "" };
      });
      return;
    }

    if (type === "transfer") {
      const current = form.transfer;
      const amount = parseMoney(current.amount);
      if (!current.fromMemberId || !current.toMemberId || current.fromMemberId === current.toMemberId || amount <= 0) {
        return setStatusError("보내는 사람, 받는 사람, 금액을 확인해 주세요.");
      }
      const members = state.members.map((member) => {
        if (member.id === current.fromMemberId) return { ...member, balance: member.balance - amount };
        if (member.id === current.toMemberId) return { ...member, balance: member.balance + amount };
        return member;
      });
      const txn = {
        id: uid(),
        date: now,
        type: "transfer",
        amount,
        memo: current.memo,
        memberId: "",
        memberIds: [],
        amountPerPerson: 0,
        fromMemberId: current.fromMemberId,
        toMemberId: current.toMemberId,
        payerId: "",
        sharedAmount: 0,
        participants: [],
      };
      await applyUpdate(members, [txn, ...state.transactions], () => {
        form.transfer = { fromMemberId: "", toMemberId: "", amount: "", memo: "" };
      });
      return;
    }

    const current = form.delivery;
    const preview = deliveryPreview();
    const sharedAmount = parseMoney(current.sharedAmount);
    const total = preview.reduce((sum, item) => sum + item.individual, 0) + sharedAmount;
    if (!current.memberIds.length || total <= 0) return setStatusError("배달정산 참여 멤버와 금액을 확인해 주세요.");
    const members = state.members.map((member) => {
      const change = preview.find((item) => item.id === member.id);
      return change ? { ...member, balance: member.balance + change.delta } : member;
    });
    const txn = {
      id: uid(),
      date: now,
      type: "delivery",
      amount: total,
      memo: current.memo,
      memberId: "",
      memberIds: [],
      amountPerPerson: 0,
      fromMemberId: "",
      toMemberId: "",
      payerId: current.payerId,
      sharedAmount,
      participants: current.memberIds.map((id) => ({ id, amount: parseMoney(current.amounts[id]) })),
    };
    await applyUpdate(members, [txn, ...state.transactions], () => {
      form.delivery = { memberIds: [], amounts: {}, sharedAmount: "", payerId: "lab", memo: "" };
    });
  }

  function toggleArrayValue(values, value) {
    return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  }

  function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || !app.contains(button)) return;
    const action = button.dataset.action;
    event.preventDefault();

    if (action === "refresh") return loadLedger();
    if (action === "tab") {
      syncInputs();
      state.activeTab = button.dataset.tab;
      state.error = "";
      return render();
    }
    if (action === "tx-type") {
      syncInputs();
      state.txType = button.dataset.type;
      state.error = "";
      return render();
    }
    if (action === "select-member") {
      syncInputs();
      const id = button.dataset.id;
      const group = button.dataset.group;
      if (group === "deposit" || group === "withdraw") {
        form[group].memberId = id;
      } else if (group === "shared") {
        form.shared.memberIds = toggleArrayValue(form.shared.memberIds, id);
      } else if (group === "transfer-from") {
        form.transfer.fromMemberId = id;
        if (form.transfer.toMemberId === id) form.transfer.toMemberId = "";
      } else if (group === "transfer-to") {
        form.transfer.toMemberId = id;
      } else if (group === "delivery") {
        form.delivery.memberIds = toggleArrayValue(form.delivery.memberIds, id);
        if (!form.delivery.memberIds.includes(id)) delete form.delivery.amounts[id];
        if (!form.delivery.memberIds.includes(form.delivery.payerId)) form.delivery.payerId = "lab";
      }
      return render();
    }
    if (action === "shared-all") {
      syncInputs();
      form.shared.memberIds = form.shared.memberIds.length === state.members.length ? [] : state.members.map((member) => member.id);
      return render();
    }
    if (action === "payer") {
      syncInputs();
      form.delivery.payerId = button.dataset.id;
      return render();
    }
    if (action === "submit-txn") return submitTransaction();
    if (action === "restaurant-search") return searchRestaurants();
    if (action === "select-restaurant-result") return selectRestaurantCandidate(button.dataset.placeId);
    if (action === "select-restaurant") {
      syncInputs();
      state.selectedRestaurantId = button.dataset.id;
      state.reviewStoreStatus = "";
      return render();
    }
    if (action === "submit-review") return submitReview();
    if (action === "delete-review") {
      return deleteReview(button.dataset.id);
    }
    if (action === "history-filter") {
      state.historyFilter = button.dataset.filter;
      return render();
    }
    if (action === "expand-txn") {
      state.expandedTxnId = state.expandedTxnId === button.dataset.id ? "" : button.dataset.id;
      return render();
    }
    if (action === "delete-txn") {
      state.modal = { type: "deleteTxn", id: button.dataset.id };
      return render();
    }
    if (action === "expand-member") {
      state.expandedMemberId = state.expandedMemberId === button.dataset.id ? "" : button.dataset.id;
      return render();
    }
    if (action === "edit-member") {
      const member = state.members.find((item) => item.id === button.dataset.id);
      form.editMemberId = member?.id || "";
      form.editBalance = String(Math.round(member?.balance || 0));
      return render();
    }
    if (action === "cancel-member-edit") {
      form.editMemberId = "";
      form.editBalance = "";
      return render();
    }
    if (action === "save-member-edit") return saveMemberEdit(button.dataset.id);
    if (action === "delete-member") {
      state.modal = { type: "deleteMember", id: button.dataset.id };
      return render();
    }
    if (action === "add-member") return addMember();
    if (action === "modal-cancel") {
      state.modal = null;
      return render();
    }
    if (action === "modal-confirm") return confirmDelete();
  }

  async function addMember() {
    syncInputs();
    const name = form.member.name.trim();
    if (!name) return setStatusError("추가할 멤버 이름을 입력해 주세요.");
    const balance = parseMoney(form.member.balance);
    const members = [...state.members, { id: uid(), name, balance }];
    await applyUpdate(members, state.transactions, () => {
      form.member = { name: "", balance: "50000" };
    });
  }

  async function saveMemberEdit(id) {
    syncInputs();
    const balance = parseMoney(form.editBalance);
    const members = state.members.map((member) => member.id === id ? { ...member, balance } : member);
    await applyUpdate(members, state.transactions, () => {
      form.editMemberId = "";
      form.editBalance = "";
    });
  }

  async function confirmDelete() {
    const modal = state.modal;
    if (!modal) return;
    state.modal = null;

    if (modal.type === "deleteTxn") {
      const txn = state.transactions.find((item) => item.id === modal.id);
      if (!txn) return render();
      const changes = computeChanges(txn);
      const members = state.members.map((member) => {
        const change = changes.find((item) => item.memberId === member.id);
        return change ? { ...member, balance: member.balance - change.delta } : member;
      });
      const transactions = state.transactions.filter((item) => item.id !== modal.id);
      await applyUpdate(members, transactions);
      return;
    }

    const members = state.members.filter((member) => member.id !== modal.id);
    await applyUpdate(members, state.transactions);
  }

  app.addEventListener("click", handleClick);
  app.addEventListener("input", handleInput);

  loadLedger();
})();
