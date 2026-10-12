// xmrwallet frontend — vanilla JS, zero third-party, strict CSP.
// Wallet-app flow: the only entry points are create-new-seed or import-seed.
// An anonymous session is created automatically with the first wallet action.
"use strict";

const $ = (id) => document.getElementById(id);
const PICONERO = 1000000000000n;

let me = null;
let currentWalletId = null;
let listTimer = null;
let network = "mainnet";
let xmrUsd = null;

const PICONERO_F = 1e12;

async function refreshPrice() {
  try {
    const { usd } = await api("/api/price");
    if (typeof usd === "number") xmrUsd = usd;
  } catch {
    /* price is optional */
  }
}
function usdOf(atomic) {
  if (xmrUsd === null || atomic === null || atomic === undefined) return null;
  const v = (Number(atomic) / PICONERO_F) * xmrUsd;
  if (!Number.isFinite(v)) return null;
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function setUsd(el, atomic) {
  el.textContent = atomic === null ? "" : `≈ ${usdOf(atomic) ?? ""}`;
}

function explorerBase() {
  return network === "stagenet" ? "https://xmrchain.net" : "https://xmrchain.net";
}

/* ---------------- helpers ---------------- */

function withLoading(btn, fn) {
  return async (...args) => {
    btn.classList.add("loading");
    try {
      return await fn(...args);
    } finally {
      btn.classList.remove("loading");
    }
  };
}

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", isError);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) void refreshPrice();
setInterval(() => {
  void refreshPrice().then(() => {
    if (currentWalletId && !$("wallet-detail").hidden) void renderDetail();
  });
}, 60_000);
void refreshMe().then(() => {
  // stay on the wallet page across refreshes
  const m = location.hash.match(/^#wallet\/([0-9a-f-]{36})$/);
  if (m && me) void showWallet(m[1], false);
});
    throw new Error(body.error || res.statusText);
  }
  return body;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

function fmtXMR(atomic) {
  if (atomic === null || atomic === undefined) return "—";
  const n = BigInt(atomic);
  const whole = n / PICONERO;
  let frac = (n % PICONERO).toString().padStart(12, "0");
  frac = frac.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}.0`;
}

const STATE_META = {
  queued: { label: "queued", cls: "warn" },
  restoring: { label: "restoring…", cls: "warn" },
  ready: { label: "syncing", cls: "ok" },
  watching: { label: "synced", cls: "ok" },
  error: { label: "error", cls: "err" },
};

function setBadge(el, state, errorText, progressPct) {
  const m = STATE_META[state] ?? { label: state, cls: "warn" };
  el.className = `badge ${m.cls}`;
  el.textContent = progressPct != null ? `${m.label} ${progressPct}%` : m.label;
  el.title = errorText || m.label;
}

function syncPct(w) {
  if (w.state !== "restoring" || !w.sync_target) return null;
  if (w.sync_target <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor(((w.sync_height ?? 0) / w.sync_target) * 100)));
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/* ---------------- session ---------------- */

async function refreshMe() {
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  try {
    ({ network } = await api("/api/config"));
  } catch {
    /* keep default */
  }
  const badge = $("net-badge");
  badge.textContent = network;
  badge.classList.toggle("stagenet", network === "stagenet");
  $("footer-tag").textContent =
    network === "stagenet"
      ? "xmrwallet · stagenet testnet only · funds have no value"
      : "xmrwallet · open-source Monero web wallet";
  const signedIn = !!me;
  $("hero-panel").hidden = signedIn;
  $("wallet-panel").hidden = !signedIn;
  $("btn-logout").hidden = !signedIn;
  $("auth-status").textContent = signedIn ? (me.isAnon ? "anonymous session" : me.email) : "";
  if (signedIn) {
    await refreshWallets();
    startListPolling();
  } else {
    stopListPolling();
    $("wallet-detail").hidden = true;
    currentWalletId = null;
  }
}

// create the anon session on demand (first wallet action)
async function ensureSession() {
  if (me) return;
  await api("/api/auth/anon", { method: "POST" });
  me = await api("/api/me");
  await refreshMe();
}

/* ---------------- wallet list ---------------- */

async function refreshWallets() {
  const list = $("wallet-list");
  const { wallets } = await api("/api/wallets");
  list.textContent = "";
  $("btn-new-wallet").hidden = creatingWallet || !me;
  if (creatingWallet) {
    const li = document.createElement("li");
    li.className = "empty creating";
    li.style.cursor = "default";
    li.innerHTML = "";
    const spin = document.createElement("span");
    spin.className = "create-spinner";
    const text = document.createElement("span");
    text.textContent = "Creating wallet…";
    li.append(spin, text);
    list.appendChild(li);
    return;
  }
  if (wallets.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.style.cursor = "default";
    li.textContent = "No wallets yet — create one to get started.";
    list.appendChild(li);
    return;
  }
  for (const w of wallets) {
    const li = document.createElement("li");
    li.dataset.id = w.id;

    const label = document.createElement("span");
    label.className = "w-label";
    label.textContent = w.label || `wallet ${w.id.slice(0, 8)}`;

    const stateEl = document.createElement("span");
    setBadge(stateEl, w.state, w.error, syncPct(w));

    const meta = document.createElement("span");
    meta.className = "w-meta";
    meta.textContent = fmtDate(w.created_at);

    li.append(stateEl, label, meta);
    li.addEventListener("click", () => showWallet(w.id));
    list.appendChild(li);
  }
}

function startListPolling() {
  stopListPolling();
  listTimer = setInterval(async () => {
    if (me && !$("wallet-panel").hidden) {
      const { wallets } = await api("/api/wallets").catch(() => ({ wallets: [] }));
      const busy = wallets.some((w) => w.state === "queued" || w.state === "restoring");
      if (busy) await refreshWallets();
    }
  }, 4000);
}
function stopListPolling() {
  if (listTimer) clearInterval(listTimer);
  listTimer = null;
}

/* ---------------- wallet detail ---------------- */

let detailTimer = null;

async function showWallet(id, updateHash = true) {
  currentWalletId = id;
  if (updateHash) location.hash = `wallet/${id}`;
  stopListPolling();
  $("wallet-panel").hidden = true;
  $("wallet-detail").hidden = false;
  window.scrollTo(0, 0);
  await renderDetail();
  scheduleDetailRefresh(4000);
}

function scheduleDetailRefresh(ms = 4000) {
  if (detailTimer) clearTimeout(detailTimer);
  detailTimer = setTimeout(async () => {
    if (!currentWalletId || $("wallet-detail").hidden) return;
    let w;
    try {
      w = await api(`/api/wallets/${currentWalletId}`);
    } catch (e) {
      if (String(e.message).includes("not found")) {
        toast("That wallet no longer exists");
        backToList();
        return;
      }
      scheduleDetailRefresh(); // keep polling through transient errors
      return;
    }
    const busy = w.state === "queued" || w.state === "restoring";
    renderDetailFrom(w);
    scheduleDetailRefresh(busy ? 4000 : 12000);
  }, 4000);
}

async function renderDetail() {
  let w;
  try {
    w = await api(`/api/wallets/${currentWalletId}`);
  } catch (e) {
    if (String(e.message).includes("not found")) {
      // stale hash pointing at a wallet that no longer exists
      toast("That wallet no longer exists");
      backToList();
      return;
    }
    toast(e.message, true);
    return;
  }
  renderDetailFrom(w);
}

function renderDetailFrom(w) {
  $("wd-title").textContent = w.label || `wallet ${w.id.slice(0, 8)}`;
  setBadge($("wd-state"), w.state, w.error, syncPct(w));
  const pct = syncPct(w);
  $("wd-progress").hidden = pct === null;
  if (pct !== null) {
    $("wd-progress-fill").style.width = `${pct}%`;
    const h = w.sync_height ?? 0;
    const now = Date.now();
    let eta = "";
    if (lastSync.height !== null && h > lastSync.height && now > lastSync.at) {
      const rate = (h - lastSync.height) / ((now - lastSync.at) / 1000); // blocks/s
      const remaining = (w.sync_target - h) / Math.max(rate, 1);
      const mins = Math.round(remaining / 60);
      eta = mins >= 60
        ? ` · ~${Math.floor(mins / 60)}h ${mins % 60}m left`
        : mins >= 1
          ? ` · ~${mins}m left`
          : " · <1m left";
    }
    if (lastSync.height !== h) lastSync = { height: h, at: now };
    $("wd-progress-text").textContent = `${pct}% — block ${h} of ${w.sync_target}${eta}`;
  }
  const errEl = $("wd-error");
  if (w.error && w.state === "error") {
    errEl.textContent = w.error;
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }
  $("wd-balance").textContent = fmtXMR(w.balance_atomic);
  $("wd-unlocked").textContent = fmtXMR(w.unlocked_atomic);
  const locked =
    w.balance_atomic !== null && w.unlocked_atomic !== null
      ? BigInt(w.balance_atomic) - BigInt(w.unlocked_atomic)
      : 0n;
  $("wd-locked-line").hidden = locked <= 0n;
  $("wd-locked").textContent = fmtXMR(locked.toString());
  setUsd($("wd-balance-usd"), w.balance_atomic);
  setUsd($("wd-unlocked-usd"), w.unlocked_atomic);
  setUsd($("wd-locked-usd"), locked <= 0n ? null : locked.toString());
  renderAddresses();
  renderIncoming();
}

let addrRenderSeq = 0;
let incRenderSeq = 0;
let lastSync = { height: null, at: 0 };
async function renderAddresses() {
  const seq = ++addrRenderSeq;
  const ul = $("wd-addresses");
  let addresses;
  try {
    ({ addresses } = await api(`/api/wallets/${currentWalletId}/addresses`));
  } catch {
    if (seq !== addrRenderSeq) return;
    ul.textContent = "";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Addresses appear once the wallet is ready.";
    ul.appendChild(li);
    return;
  }
  if (seq !== addrRenderSeq) return; // a newer render superseded this one
  ul.textContent = "";
  for (const a of addresses) {
    const li = document.createElement("li");

    const tag = document.createElement("span");
    tag.className = `addr-tag${a.used ? " used" : ""}`;
    tag.textContent = a.index === 0 ? "primary" : `#${a.index}`;

    const code = document.createElement("code");
    code.textContent = a.address;

    const label = document.createElement("span");
    label.className = "addr-label";
    label.textContent = a.label || "";

    const copy = document.createElement("button");
    copy.className = "btn ghost small";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      copyText(a.address).then((ok) => toast(ok ? "Address copied" : "Copy failed", !ok));
    });

    li.append(tag, code, label, copy);
    ul.appendChild(li);
  }
}

async function renderIncoming() {
  const seq = ++incRenderSeq;
  const ul = $("wd-incoming");
  let incoming, outgoing;
  try {
    ({ incoming, outgoing } = await api(`/api/wallets/${currentWalletId}/incoming`));
  } catch {
    return; // wallet not ready yet
  }
  if (seq !== incRenderSeq) return;
  ul.textContent = "";
  const all = [
    ...(incoming ?? []).map((t) => ({ dir: "in", ...t })),
    ...(outgoing ?? []).map((t) => ({ dir: "out", ...t })),
  ].sort((a, b) => {
    const ah = a.height ?? 0;
    const bh = b.height ?? 0;
    if (ah === 0 !== (bh === 0)) return ah === 0 ? -1 : 1; // pending first
    return bh - ah; // then newest confirmed
  });
  if (all.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No transfers yet.";
    ul.appendChild(li);
    return;
  }
  for (const t of all) {
    const li = document.createElement("li");
    const amt = document.createElement("span");
    amt.className = `tx-amt ${t.dir === "out" ? "tx-out" : ""}`;
    const usd = usdOf(t.amount_atomic);
    amt.textContent = `${t.dir === "out" ? "−" : "+"}${fmtXMR(t.amount_atomic)} XMR${usd ? ` (${usd})` : ""}`;
    const meta = document.createElement("span");
    meta.className = "tx-meta";
    const addrTag =
      t.dir === "in" && t.subaddress_index > 0 ? `→ #${t.subaddress_index} · ` : "";
    const fee = t.dir === "out" && t.fee_atomic ? ` · fee ${fmtXMR(t.fee_atomic)}` : "";
    const when = !t.height
      ? "Pending"
      : t.timestamp
        ? new Date(t.timestamp * 1000).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          })
        : `height ${t.height}`;
    const conf = t.confirmations != null ? `${t.confirmations} conf` : "";
    meta.textContent = `${when}${conf ? ` · ${conf}` : ""} · ${addrTag}`;
    const link = document.createElement("a");
    link.href = `${explorerBase()}/tx/${t.txid}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "tx-link";
    link.textContent = `${t.txid.slice(0, 12)}…`;
    meta.append(link);
    if (fee) meta.append(document.createTextNode(fee));
    li.append(amt, meta);
    ul.appendChild(li);
  }
}

function backToList() {
  currentWalletId = null;
  history.replaceState(null, "", location.pathname + location.search);
  if (detailTimer) clearTimeout(detailTimer);
  $("wallet-detail").hidden = true;
  $("wallet-panel").hidden = false;
  void refreshWallets();
  startListPolling();
}

/* ---------------- wallet creation / import ---------------- */

let creatingWallet = false;

async function createWallet(label) {
  await ensureSession();
  creatingWallet = true;
  refreshWallets(); // shows the creating placeholder + hides the button
  try {
    const w = await api("/api/wallets", {
      method: "POST",
      body: JSON.stringify({ mode: "new", label: label || null }),
    });
    if (w.mnemonic) {
      $("mnemonic-text").textContent = w.mnemonic;
      $("mnemonic-modal").hidden = false;
    }
    await refreshMe();
    toast("Wallet created — restoring in background");
  } finally {
    creatingWallet = false;
  }
}

async function importSeed(mnemonic, restoreHeight, dateStr) {
  await ensureSession();
  // date → height estimate (unless an explicit height was given)
  if (dateStr && restoreHeight === 0) {
    try {
      const { height } = await api(`/api/height-for-date?date=${encodeURIComponent(dateStr)}`);
      restoreHeight = height;
      toast(`Estimated restore height ${height} from ${dateStr}`);
    } catch {
      toast("Height estimate failed — using 0", true);
    }
  }
  const w = await api("/api/wallets", {
    method: "POST",
    body: JSON.stringify({ mode: "restore", mnemonic, restore_height: restoreHeight }),
  });
  await refreshMe();
  if (w.existing) {
    toast("Already imported — showing your existing wallet");
  } else {
    toast("Seed imported — restore queued");
  }
}

function validateMnemonic(mnemonic) {
  if (mnemonic.split(/\s+/).length < 13) {
    toast("Seed looks too short (need 13/25 words)", true);
    return false;
  }
  return true;
}

/* ---------------- wiring ---------------- */

// homepage CTAs
$("btn-create").addEventListener("click", () => {
  $("hero-import-box").hidden = true;
  $("hero-create-box").hidden = !$("hero-create-box").hidden;
  if (!$("hero-create-box").hidden) $("create-label").focus();
});

$("btn-import").addEventListener("click", () => {
  $("hero-create-box").hidden = true;
  $("hero-import-box").hidden = !$("hero-import-box").hidden;
  if (!$("hero-import-box").hidden) $("import-mnemonic").focus();
});

$("form-hero-create").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  btn.classList.add("loading");
  try {
    await createWallet($("create-label").value.trim());
    $("create-label").value = "";
    $("hero-create-box").hidden = true;
  } catch (e) { toast(e.message, true); }
  btn.classList.remove("loading");
});

$("form-hero-import").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const mnemonic = $("import-mnemonic").value.trim();
  if (!validateMnemonic(mnemonic)) return;
  try {
    await importSeed(mnemonic, Number($("import-height").value || "0"), $("import-date").value);
    $("import-mnemonic").value = "";
    $("hero-import-box").hidden = true;
  } catch (e) { toast(e.message, true); }
});

// signed-in panel
$("btn-new-wallet").addEventListener("click", async () => {
  const label = prompt("Wallet label (optional):", "") ?? "";
  $("btn-new-wallet").classList.add("loading");
  try {
    await createWallet(label.trim());
  } catch (e) { toast(e.message, true); }
  $("btn-new-wallet").classList.remove("loading");
});

$("form-restore-wallet").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const mnemonic = $("restore-mnemonic").value.trim();
  if (!validateMnemonic(mnemonic)) return;
  try {
    await importSeed(mnemonic, Number($("restore-height").value || "0"), $("restore-date").value);
    $("restore-mnemonic").value = "";
    $("restore-details").open = false;
  } catch (e) { toast(e.message, true); }
});

// seed modal
$("btn-mnemonic-close").addEventListener("click", () => {
  $("mnemonic-modal").hidden = true;
  $("mnemonic-text").textContent = "";
  $("btn-new-wallet").hidden = false;
  void refreshWallets();
});
$("btn-copy-seed").addEventListener("click", () => {
  copyText($("mnemonic-text").textContent).then(
    (ok) => toast(ok ? "Seed copied" : "Copy failed — select it manually", !ok),
    () => toast("Copy failed", true),
  );
});

// misc
$("btn-copy-donate").addEventListener("click", () => {
  const btn = $("btn-copy-donate");
  const address = btn.dataset.address ?? "";
  if (!address || address.length < 90) {
    toast("Donation address not set yet", true);
    return;
  }
  copyText(address).then(
    (ok) => toast(ok ? "Donation address copied" : "Copy failed", !ok),
    () => toast("Copy failed", true),
  );
});

$("btn-new-address").addEventListener("click", async () => {
  if (!currentWalletId) return;
  const label = prompt("Address label (optional):", "") ?? "";
  const btn = $("btn-new-address");
  btn.classList.add("loading");
  try {
    await api(`/api/wallets/${currentWalletId}/addresses`, {
      method: "POST",
      body: JSON.stringify({ label: label.trim() || null }),
    });
    toast("Address created");
    await renderAddresses();
  } catch (e) { toast(e.message, true); }
  btn.classList.remove("loading");
});

let sendMax = false;

$("btn-max").addEventListener("click", () => {
  sendMax = true;
  const unlocked = $("wd-unlocked").textContent;
  $("send-amount").value = unlocked === "—" ? "" : unlocked;
  $("send-amount").dispatchEvent(new Event("input"));
});

$("send-amount").addEventListener("input", () => {
  if (document.activeElement === $("send-amount")) sendMax = false;
  const v = $("send-amount").value.trim();
  if (!/^[0-9.]+$/.test(v)) { $("send-usd-hint").textContent = ""; return; }
  const n = Number(v);
  $("send-usd-hint").textContent =
    Number.isFinite(n) && xmrUsd !== null ? `≈ ${(n * xmrUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD` : "";
});

$("form-send").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!currentWalletId) { toast("No wallet selected", true); return; }
  const address = $("send-address").value.trim();
  const amountXmr = $("send-amount").value.trim();
  if (!/^\d+(\.\d+)?$/.test(amountXmr) || Number(amountXmr) <= 0) {
    toast("Bad amount (e.g. 0.001)", true);
    return;
  }
  const [whole, frac = ""] = amountXmr.split(".");
  if (frac.length > 12) { toast("Too many decimals (max 12)", true); return; }
  const amountAtomic = BigInt(whole) * PICONERO + BigInt(frac.padEnd(12, "0"));
  const shortAddr = address.length > 16 ? address.slice(0, 8) + "…" + address.slice(-8) : address;
  if (!confirm(`Send ${sendMax ? "ALL (max)" : amountXmr} XMR to\n${shortAddr}\n\nThis cannot be undone.`)) return;
  const btn = ev.target.querySelector('button[type="submit"]');
  btn.classList.add("loading");
  try {
    const { txid } = await api(`/api/wallets/${currentWalletId}/send`, {
      method: "POST",
      body: JSON.stringify(
        sendMax
          ? { address, max: true }
          : { address, amount_atomic: amountAtomic.toString() },
      ),
    });
    $("send-amount").value = "";
    sendMax = false;
    toast(`Sent — tx ${txid.slice(0, 12)}…`);
    await renderDetail();
  } catch (e) { toast(e.message, true); }
  btn.classList.remove("loading");
});

$("btn-back").addEventListener("click", backToList);
window.addEventListener("hashchange", () => {
  const m = location.hash.match(/^#wallet\/([0-9a-f-]{36})$/);
  if (m && me && m[1] !== currentWalletId) void showWallet(m[1], false);
});
$("btn-logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    me = null;
    await refreshMe();
    toast("Signed out");
  } catch (e) { toast(e.message, true); }
});

void refreshPrice();
setInterval(() => {
  void refreshPrice().then(() => {
    if (currentWalletId && !$("wallet-detail").hidden) void renderDetail();
  });
}, 60_000);
void refreshMe().then(() => {
  // stay on the wallet page across refreshes
  const m = location.hash.match(/^#wallet\/([0-9a-f-]{36})$/);
  if (m && me) void showWallet(m[1], false);
});
