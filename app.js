import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc, updateDoc, onSnapshot, query, where, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);
// secondary app — lets a manager create child logins without dropping their own session
let secondaryApp; try { secondaryApp = initializeApp(firebaseConfig, 'secondary'); } catch (_) {}
const secondaryAuth = secondaryApp ? getAuth(secondaryApp) : null;

// ── State ──────────────────────────────────────────────────────────────────
let trades = [], strategies = [], portfolios = [], adjustments = [];
let stratMap = {};                       // key -> {id,name,threshold,color,virtual,legacyTag}
let sortKey = 'date', sortDir = 1;
let fResult = '';
let charts = {};
let appReady = false;
let curPage = 'dashboard';
let curStratId = null, curPfId = null;

// auth / multi-account context
let me = null;            // my profile {uid,email,displayName,role,parentId}
let ctxOwnerId = null;    // whose data is currently loaded
let viewing = null;       // null = my own account; else the child profile I'm viewing (read-only)
let children = [];        // my direct child accounts
let dataUnsubs = [];      // active onSnapshot unsubscribers

const PALETTE = ['#f97316','#3b82f6','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899','#14b8a6','#f43f5e'];
const DEFAULT_THRESHOLD = 1000;
const isRO = () => !!viewing;                                   // read-only when viewing a child
const canManage = () => me && (me.role === 'superadmin' || me.role === 'manager');
function roGuard() { if (isRO()) { showToast('Read-only — viewing another account'); return true; } return false; }

// ── Auth boot ────────────────────────────────────────────────────────────────
function boot() {
  onAuthStateChanged(auth, async user => {
    if (!user) { me = null; showLogin(); return; }
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (!snap.exists()) { authError('This login has no profile yet. Use first-time setup (superadmin), or ask your manager to recreate it.'); return; }
      me = { uid: user.uid, ...snap.data() };
      if (me.role === 'superadmin') { try { await claimLegacy(); } catch (e) { console.error('claim', e); } }
      hideLogin();
      await loadChildren();
      renderTopUser();
      setContext(me.uid, null);
    } catch (e) { console.error(e); authError('Could not load your account — check connection and rules.'); }
  });
}

// one-time: stamp ownerId on pre-auth (legacy) docs — superadmin only
async function claimLegacy() {
  const flag = 'tj_claimed_' + me.uid;
  try { if (localStorage.getItem(flag) === '1') return; } catch (_) {}
  for (const coll of ['trades', 'strategies', 'portfolios', 'adjustments']) {
    const snap = await getDocs(collection(db, coll));
    const orphans = snap.docs.filter(d => d.data().ownerId === undefined);
    for (let i = 0; i < orphans.length; i += 400) {
      const b = writeBatch(db);
      orphans.slice(i, i + 400).forEach(d => b.update(doc(db, coll, d.id), { ownerId: me.uid }));
      await b.commit();
    }
  }
  try { localStorage.setItem(flag, '1'); } catch (_) {}
}

async function loadChildren() {
  children = [];
  try {
    const snap = (me.role === 'superadmin')
      ? await getDocs(collection(db, 'users'))
      : await getDocs(query(collection(db, 'users'), where('parentId', '==', me.uid)));
    children = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => u.uid !== me.uid)
      .sort((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || ''));
  } catch (e) { console.error('children', e); }
}

// switch which account's data is loaded (own = editable, child = read-only)
function setContext(ownerId, viewProfile) {
  ctxOwnerId = ownerId;
  viewing = viewProfile || null;
  dataUnsubs.forEach(u => { try { u(); } catch (_) {} });
  dataUnsubs = [];
  trades = []; strategies = []; portfolios = []; adjustments = [];
  setSyncState('syncing');
  document.getElementById('app').classList.toggle('ro', isRO());
  renderViewBanner();
  subData('strategies', s => strategies = s);
  subData('portfolios', s => portfolios = s);
  subData('adjustments', s => adjustments = s);
  subData('trades', s => trades = s);
}

function subData(name, assign) {
  const un = onSnapshot(query(collection(db, name), where('ownerId', '==', ctxOwnerId)),
    snap => {
      assign(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setSyncState('live');
      if (!appReady) { appReady = true; showApp(); }
      renderAll();
    },
    err => { console.error(name, err); setSyncState('error'); if (!appReady) { appReady = true; showApp(); } }
  );
  dataUnsubs.push(un);
}

function showApp() {
  document.getElementById('splash').classList.add('out');
  document.getElementById('app').classList.remove('hidden');
}

function setSyncState(state) {
  const badge = document.getElementById('sync-pill');
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  if (!badge) return;
  badge.className = 'sync-pill' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
  dot.className = 'sync-dot' + (state === 'live' ? ' pulse' : '');
  lbl.textContent = state === 'live' ? 'Live' : state === 'syncing' ? 'Syncing' : 'Error';
}

// ── Formatters ─────────────────────────────────────────────────────────────
function fmt(n) { return Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 }); }
function inr(n) { return '₹' + fmt(n); }
function sig(n) { return (n >= 0 ? '+' : '−') + inr(Math.abs(n)); }
function pc(n) { return n > 0 ? 'vpos' : n < 0 ? 'vneg' : 'vneu'; }
const net = t => (t.pnl || 0) - (t.tax || 0);
const esc = s => (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ── Strategy resolution (handles legacy 200/300 trades) ──────────────────────
function keyOf(t) { return t.strategyId || (t.strat ? 'L:' + t.strat : 'L:?'); }

function buildStratMap() {
  const m = {};
  strategies.forEach(s => { m[s.id] = { ...s, virtual: false, threshold: s.threshold ?? DEFAULT_THRESHOLD }; });
  trades.forEach(t => {
    const k = keyOf(t);
    if (!m[k]) {
      const legacyTag = t.strategyId ? null : (t.strat || '?');
      m[k] = {
        id: k, virtual: true, legacyTag,
        name: legacyTag ? legacyTag + '% Strategy' : 'Unassigned',
        threshold: DEFAULT_THRESHOLD,
        color: legacyTag === '200' ? '#f97316' : legacyTag === '300' ? '#737373' : '#888888',
      };
    }
  });
  stratMap = m;
}
const stratOf = t => stratMap[keyOf(t)] || { name: '—', color: '#888', threshold: DEFAULT_THRESHOLD, virtual: true };
const realStrategies = () => Object.values(stratMap).filter(s => !s.virtual);
const hasLegacy = () => Object.values(stratMap).some(s => s.virtual && s.legacyTag);

// ── DD Engine ──────────────────────────────────────────────────────────────
function computeDD(arr) {
  let run = 0, peak = 0, wasDD = false;
  return arr.map(t => {
    run += net(t);
    if (run > peak) peak = run;
    const dd = Math.min(0, run - peak);
    const normalize = wasDD && dd === 0;
    wasDD = dd < 0;
    const ddpl = dd < 0 && t.lots > 0 ? dd / t.lots : 0;
    return { run, peak, dd, ddpl, normalize };
  });
}
const isAlert = (d, th) => !!d && d.dd < 0 && d.ddpl <= -(th ?? DEFAULT_THRESHOLD);

// Per-strategy DD map: trade.id -> dd-row (uses that strategy's threshold for alerts)
function ddMapAll() {
  const map = {};
  const groups = {};
  trades.forEach(t => { const k = keyOf(t); (groups[k] = groups[k] || []).push(t); });
  Object.entries(groups).forEach(([k, arr]) => {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    computeDD(arr).forEach((d, i) => { map[arr[i].id] = d; });
  });
  return map;
}

// ── Account aggregation ──────────────────────────────────────────────────────
function accountTotals() {
  const tradesNet = trades.reduce((s, t) => s + net(t), 0);
  const gross = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const tax = trades.reduce((s, t) => s + (t.tax || 0), 0);
  const adjTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0);
  const allTimeNet = tradesNet + adjTotal;
  const activeSet = new Set(portfolios.filter(p => p.active).flatMap(p => p.strategyIds || []));
  const activeNet = trades.filter(t => activeSet.has(t.strategyId)).reduce((s, t) => s + net(t), 0);
  return { tradesNet, gross, tax, adjTotal, allTimeNet, activeNet, activeSet };
}

// ── DD cell ──────────────────────────────────────────────────────────────────
function ddCell(d, th) {
  if (!d) return `<span style="color:#555">—</span>`;
  if (d.normalize) return `<span class="tag-norm">↓ normalize delta</span>`;
  if (d.dd >= 0) return `<span style="color:#555">—</span>`;
  const abs = Math.abs(d.ddpl);
  const pct = Math.min(100, abs / th * 100);
  const col = pct >= 100 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : pct >= 40 ? 'var(--amber)' : 'var(--green)';
  return `<div class="dd-wrap"><div class="dd-inner">
      <span class="vneg">−${inr(abs)}</span>
      ${isAlert(d, th) ? `<span class="tag-delta">↑ delta</span>` : ''}
    </div><div class="dd-bar"><div class="dd-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div></div>`;
}
function emptyRow(cols, msg) { return `<tr><td colspan="${cols}" class="empty-cell">${msg || 'No trades yet'}</td></tr>`; }
function stratTag(s) { return `<span class="strat-tag dyn" style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}55">${esc(s.name)}</span>`; }

function renderKPIs(elId, items) {
  const el = document.getElementById(elId); if (!el) return;
  el.innerHTML = items.map(k => `<div class="kpi">
      <div class="kpi-top"><span class="kpi-lbl">${k.label}</span>${k.dot ? `<span class="kpi-dot" style="background:${k.dot}"></span>` : ''}</div>
      <div class="kpi-val ${k.valCls}">${k.value}</div>
      ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''}
    </div>`).join('');
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const a = accountTotals();
  document.getElementById('hero-alltime').textContent = sig(a.allTimeNet);
  document.getElementById('hero-active').textContent = sig(a.activeNet);
  const runCount = portfolios.filter(p => p.active).length;
  document.getElementById('hero-active-sub').textContent = runCount + ' running portfolio' + (runCount !== 1 ? 's' : '');

  renderKPIs('kpi-dash', [
    { label: 'All-time Net', value: sig(a.allTimeNet), valCls: a.allTimeNet >= 0 ? 'kpi-pos' : 'kpi-neg', sub: 'Gross ' + sig(a.gross) },
    { label: 'Active Net', value: sig(a.activeNet), valCls: a.activeNet >= 0 ? 'kpi-pos' : 'kpi-neg', sub: runCount + ' running' },
    { label: 'Adjustments', value: a.adjTotal === 0 ? '₹0' : sig(a.adjTotal), valCls: a.adjTotal === 0 ? 'kpi-neu' : a.adjTotal > 0 ? 'kpi-pos' : 'kpi-neg', sub: adjustments.length + ' sync' + (adjustments.length !== 1 ? 's' : '') },
    { label: 'Total Taxes', value: inr(a.tax), valCls: 'kpi-neu', sub: trades.length + ' trade' + (trades.length !== 1 ? 's' : '') },
  ]);

  // Running portfolios list
  const running = portfolios.filter(p => p.active);
  document.getElementById('run-tag').textContent = running.length + ' active';
  const runEl = document.getElementById('run-list');
  runEl.innerHTML = running.length ? `<div class="runlist">` + running.map(p => {
    const set = new Set(p.strategyIds || []);
    const n = trades.filter(t => set.has(t.strategyId)).reduce((s, t) => s + net(t), 0);
    const col = (stratMap[(p.strategyIds || [])[0]] || {}).color || '#888';
    return `<div class="runitem"><span class="cdot" style="background:${col}"></span>
      <div class="ri-info"><div class="ri-sym">${esc(p.name)}</div><div class="ri-date">${(p.strategyIds || []).length} strategies</div></div>
      <div class="ri-pnl ${pc(n)}">${sig(n)}</div></div>`;
  }).join('') + `</div>` : `<div style="padding:18px;text-align:center;color:#555;font-size:13px">No portfolios running — toggle one on the Portfolios page</div>`;

  // Recent trades
  const recent = [...trades].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 6);
  document.getElementById('recent-tag').textContent = recent.length + ' of ' + trades.length;
  document.getElementById('recent-list').innerHTML = recent.length ? `<div class="runlist">` + recent.map(t => {
    const s = stratOf(t), n = net(t);
    return `<div class="runitem"><span class="cdot" style="background:${s.color}"></span>
      <div class="ri-info"><div class="ri-sym">${esc(t.symbol || '—')}</div><div class="ri-date">${t.date} · ${esc(s.name)} · ${t.lots} lots</div></div>
      <div class="ri-pnl ${pc(n)}">${sig(n)}</div></div>`;
  }).join('') + `</div>` : `<div style="padding:18px;text-align:center;color:#555;font-size:13px">No trades yet</div>`;

  // Combined curve
  killChart('dm');
  const sorted = [...trades].sort((x, y) => x.date.localeCompare(y.date));
  if (sorted.length) {
    let cum = 0; const labels = [], data = [];
    sorted.forEach(t => { cum += net(t); labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#16a34a' : '#dc2626';
    charts['dm'] = new Chart(document.getElementById('ch-dash'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: chartOpts() });
  }
}

// ── All Trades ─────────────────────────────────────────────────────────────
function buildDates() {
  const dates = [...new Set(trades.map(t => t.date))].sort();
  ['fil-from', 'fil-to'].forEach(id => {
    const el = document.getElementById(id); const cur = el.value;
    el.innerHTML = `<option value="">${id === 'fil-from' ? 'From…' : 'To…'}</option>` + dates.map(d => `<option${d === cur ? ' selected' : ''}>${d}</option>`).join('');
  });
  const fs = document.getElementById('fil-strat'); const cur = fs.value;
  fs.innerHTML = `<option value="">All Strategies</option>` + Object.values(stratMap)
    .map(s => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${esc(s.name)}${s.virtual ? ' (legacy)' : ''}</option>`).join('');
}

function renderAllTrades() {
  const fStrat = (document.getElementById('fil-strat') || {}).value || '';
  const fy = (document.getElementById('fil-symbol') || {}).value || '';
  const ff = (document.getElementById('fil-from') || {}).value || '';
  const ft = (document.getElementById('fil-to') || {}).value || '';
  const dd = ddMapAll();

  let list = trades.filter(t => {
    if (fStrat && keyOf(t) !== fStrat) return false;
    if (fy && t.symbol !== fy) return false;
    if (ff && t.date < ff) return false;
    if (ft && t.date > ft) return false;
    const d = dd[t.id], th = stratOf(t).threshold;
    if (fResult === 'loss' && t.pnl >= 0) return false;
    if (fResult === 'profit' && t.pnl <= 0) return false;
    if (fResult === 'alert' && !isAlert(d, th)) return false;
    return true;
  }).sort((a, b) => {
    const kv = t => ({ date: t.date, pnl: t.pnl, net: net(t), lots: t.lots }[sortKey] ?? 0);
    const av = kv(a), bv = kv(b);
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });

  document.getElementById('all-sub').textContent = `${list.length} of ${trades.length} trades`;
  const tb = document.getElementById('tbody-all');
  tb.innerHTML = !list.length ? emptyRow(12, 'No trades match') : list.map((t, i) => {
    const s = stratOf(t), d = dd[t.id], al = isAlert(d, s.threshold), n = net(t);
    return `<tr class="${al ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="text-align:center;color:#555">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td>${stratTag(s)}</td>
      <td><span class="sym-tag">${esc(t.symbol || '—')}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax || 0)}</td>
      <td class="${pc(n)}">${sig(n)}</td>
      <td class="${pc(d ? d.dd : 0)}">${d && d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d, s.threshold)}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555;font-size:12px" title="${esc(t.notes)}">${esc(t.notes) || '—'}</td>
      <td><button class="del-btn" onclick="deleteTrade('${t.id}')">×</button></td>
    </tr>`;
  }).join('');
  renderSymTable();
}

function renderSymTable() {
  const map = {};
  trades.forEach(t => {
    const s = t.symbol || 'OTHER';
    if (!map[s]) map[s] = { n: 0, g: 0, tx: 0, w: 0, l: 0 };
    map[s].n++; map[s].g += (t.pnl || 0); map[s].tx += (t.tax || 0);
    t.pnl >= 0 ? map[s].w++ : map[s].l++;
  });
  const rows = Object.entries(map).sort((a, b) => a[1].g - b[1].g);
  document.getElementById('sym-count').textContent = rows.length + ' symbol' + (rows.length !== 1 ? 's' : '');
  document.getElementById('tbody-sym').innerHTML = !rows.length ? emptyRow(8) : rows.map(([sym, s]) => {
    const n = s.g - s.tx, wr = s.n > 0 ? Math.round(s.w / s.n * 100) : 0;
    return `<tr class="${n < 0 ? 'tr-loss' : ''}">
      <td><span class="sym-tag">${esc(sym)}</span></td>
      <td class="mono">${s.n}</td>
      <td class="${pc(s.g)}">${sig(s.g)}</td>
      <td class="mono">${inr(s.tx)}</td>
      <td class="${pc(n)}">${sig(n)}</td>
      <td class="mono" style="color:var(--green)">${s.w}</td>
      <td class="mono" style="color:var(--red)">${s.l}</td>
      <td><div class="wr-row"><span class="mono ${wr >= 50 ? 'vpos' : 'vneg'}">${wr}%</span><div class="wr-bar"><div class="wr-fill" style="width:${wr}%;background:${wr >= 50 ? 'var(--green)' : 'var(--red)'}"></div></div></div></td>
    </tr>`;
  }).join('');
}

// ── Strategies page ──────────────────────────────────────────────────────────
function strategyStats(s) {
  const arr = trades.filter(t => keyOf(t) === s.id).sort((a, b) => a.date.localeCompare(b.date));
  const dds = computeDD(arr);
  return {
    arr, dds, count: arr.length,
    net: arr.reduce((x, t) => x + net(t), 0),
    tax: arr.reduce((x, t) => x + (t.tax || 0), 0),
    maxDD: dds.length ? Math.min(...dds.map(d => d.dd)) : 0,
    alerts: dds.filter(d => isAlert(d, s.threshold)).length,
  };
}

function renderStrategies() {
  document.getElementById('migrate-btn').style.display = hasLegacy() ? '' : 'none';
  const list = Object.values(stratMap);
  const el = document.getElementById('strat-cards');
  if (!list.length) {
    el.innerHTML = `<div class="card" style="grid-column:1/-1;text-align:center;padding:40px"><div style="color:#888;margin-bottom:14px">No strategies yet.</div><button class="btn-primary" onclick="openStrategyModal()">Create your first strategy</button></div>`;
    return;
  }
  el.innerHTML = list.map(s => {
    const st = strategyStats(s);
    return `<div class="scard">
      <div class="scard-open" onclick="openStrategy('${s.id}')"></div>
      <div class="scard-top">
        <div class="scard-name"><span class="cdot" style="background:${s.color}"></span><span>${esc(s.name)}</span></div>
        <div class="scard-acts">
          ${s.virtual ? `<span class="badge-legacy">Legacy</span>` :
            `<button class="icon-btn" title="Edit" onclick="openStrategyModal('${s.id}')">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9 1.5l2.5 2.5L4 11.5 1.5 12l.5-2.5L9 1.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn danger" title="Delete" onclick="deleteStrategy('${s.id}')">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 3.5h8M5 3.5V2.3h3v1.2M3.5 3.5l.5 7.5h5l.5-7.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`}
        </div>
      </div>
      <div class="scard-net ${pc(st.net)}">${sig(st.net)}</div>
      <div class="scard-meta">${st.count} trade${st.count !== 1 ? 's' : ''} · threshold ₹${fmt(s.threshold)}/lot</div>
      <div class="scard-stats">
        <span class="spill ${st.maxDD < 0 ? 'red' : ''}">Max DD ${st.maxDD < 0 ? '−' + inr(Math.abs(st.maxDD)) : '₹0'}</span>
        <span class="spill ${st.alerts > 0 ? 'warn' : ''}">↑ ${st.alerts} alert${st.alerts !== 1 ? 's' : ''}</span>
      </div>
    </div>`;
  }).join('');
}

function renderStrategyDetail() {
  const s = stratMap[curStratId];
  if (!s) { goPage('strategies'); return; }
  document.getElementById('sd-title').innerHTML = `<span class="cdot" style="display:inline-block;background:${s.color};margin-right:9px"></span>${esc(s.name)}`;
  document.getElementById('sd-sub').textContent = `Delta threshold ₹${fmt(s.threshold)}/lot · Peak-based drawdown · never resets`;
  const st = strategyStats(s);
  renderKPIs('kpi-sd', [
    { label: 'Net P&L', value: sig(st.net), valCls: st.net >= 0 ? 'kpi-pos' : 'kpi-neg', sub: st.count + ' trades', dot: s.color },
    { label: 'Total Taxes', value: inr(st.tax), valCls: 'kpi-neu' },
    { label: 'Max Drawdown', value: st.maxDD < 0 ? '−' + inr(Math.abs(st.maxDD)) : '—', valCls: st.maxDD < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'From all-time peak' },
    { label: 'Delta Alerts', value: '×' + st.alerts, valCls: st.alerts > 0 ? 'kpi-warn' : 'kpi-neu', sub: '≥ ' + inr(s.threshold) + '/lot' },
  ]);

  const tb = document.getElementById('tbody-sd');
  tb.innerHTML = !st.arr.length ? emptyRow(12) : st.arr.map((t, i) => {
    const d = st.dds[i], n = net(t);
    return `<tr class="${isAlert(d, s.threshold) ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="text-align:center;color:#555">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="sym-tag">${esc(t.symbol || '—')}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax || 0)}</td>
      <td class="${pc(n)}">${sig(n)}</td>
      <td class="${pc(d.run)}">${sig(d.run)}</td>
      <td class="mono">${inr(d.peak)}</td>
      <td class="${pc(d.dd)}">${d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d, s.threshold)}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555;font-size:12px">${esc(t.notes) || '—'}</td>
    </tr>`;
  }).join('');

  killChart('sd');
  if (st.arr.length) {
    let cum = 0; const labels = [], data = [];
    st.arr.forEach(t => { cum += net(t); labels.push(t.date); data.push(cum); });
    charts['sd'] = new Chart(document.getElementById('ch-sd'), { type: 'line', data: { labels, datasets: [lineDS(data, s.color)] }, options: chartOpts() });
  }
}

// ── Portfolios page ──────────────────────────────────────────────────────────
function portfolioTrades(p) {
  const set = new Set(p.strategyIds || []);
  return trades.filter(t => set.has(t.strategyId)).sort((a, b) => a.date.localeCompare(b.date));
}

function renderPortfolios() {
  const el = document.getElementById('pf-cards');
  if (!portfolios.length) {
    el.innerHTML = `<div class="card" style="grid-column:1/-1;text-align:center;padding:40px"><div style="color:#888;margin-bottom:14px">No portfolios yet. A portfolio bundles strategies together.</div><button class="btn-primary" onclick="openPortfolioModal()">Create a portfolio</button></div>`;
    return;
  }
  el.innerHTML = portfolios.map(p => {
    const arr = portfolioTrades(p);
    const n = arr.reduce((s, t) => s + net(t), 0);
    const chips = (p.strategyIds || []).map(id => {
      const s = stratMap[id]; if (!s) return '';
      return `<span class="pf-chip"><span class="cdot" style="background:${s.color}"></span>${esc(s.name)}</span>`;
    }).join('');
    return `<div class="scard">
      <div class="scard-open" onclick="openPortfolio('${p.id}')"></div>
      <div class="scard-top">
        <div class="scard-name"><span>${esc(p.name)}</span></div>
        <div class="scard-acts">
          <button class="icon-btn" title="Edit" onclick="openPortfolioModal('${p.id}')">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9 1.5l2.5 2.5L4 11.5 1.5 12l.5-2.5L9 1.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn danger" title="Delete" onclick="deletePortfolio('${p.id}')">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 3.5h8M5 3.5V2.3h3v1.2M3.5 3.5l.5 7.5h5l.5-7.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="scard-net ${pc(n)}">${sig(n)}</div>
      <div class="scard-meta">${arr.length} trade${arr.length !== 1 ? 's' : ''} · ${(p.strategyIds || []).length} strateg${(p.strategyIds || []).length !== 1 ? 'ies' : 'y'}</div>
      <div class="pf-chips">${chips || '<span style="color:#555;font-size:11px">no strategies</span>'}</div>
      <div class="switch-wrap">
        <label class="switch">
          <input type="checkbox" ${p.active ? 'checked' : ''} onchange="togglePortfolio('${p.id}',this.checked)">
          <span class="track"></span><span class="knob"></span>
        </label>
        <span class="switch-lbl ${p.active ? 'on' : ''}">${p.active ? 'Running' : 'Off'}</span>
      </div>
    </div>`;
  }).join('');
}

function renderPortfolioDetail() {
  const p = portfolios.find(x => x.id === curPfId);
  if (!p) { goPage('portfolios'); return; }
  document.getElementById('pd-title').textContent = p.name;
  const arr = portfolioTrades(p);
  const n = arr.reduce((s, t) => s + net(t), 0);
  const gross = arr.reduce((s, t) => s + (t.pnl || 0), 0);
  const tax = arr.reduce((s, t) => s + (t.tax || 0), 0);
  document.getElementById('pd-sub').textContent = `${(p.strategyIds || []).length} strategies · ${p.active ? 'running' : 'not running'}`;
  renderKPIs('kpi-pd', [
    { label: 'Net P&L', value: sig(n), valCls: n >= 0 ? 'kpi-pos' : 'kpi-neg', sub: arr.length + ' trades' },
    { label: 'Gross P&L', value: sig(gross), valCls: gross >= 0 ? 'kpi-pos' : 'kpi-neg' },
    { label: 'Total Taxes', value: inr(tax), valCls: 'kpi-neu' },
    { label: 'Strategies', value: '' + (p.strategyIds || []).length, valCls: 'kpi-neu', sub: p.active ? 'Running' : 'Off' },
  ]);

  const tb = document.getElementById('tbody-pd');
  tb.innerHTML = !(p.strategyIds || []).length ? emptyRow(6, 'No strategies in this portfolio') : (p.strategyIds || []).map(id => {
    const s = stratMap[id]; if (!s) return '';
    const st = strategyStats(s);
    return `<tr><td>${stratTag(s)}</td><td class="mono">${st.count}</td>
      <td class="${pc(st.net + st.tax)}">${sig(st.net + st.tax)}</td>
      <td class="mono">${inr(st.tax)}</td>
      <td class="${pc(st.net)}">${sig(st.net)}</td>
      <td class="${pc(st.maxDD)}">${st.maxDD < 0 ? '−' + inr(Math.abs(st.maxDD)) : '—'}</td></tr>`;
  }).join('');

  killChart('pd');
  if (arr.length) {
    let cum = 0; const labels = [], data = [];
    arr.forEach(t => { cum += net(t); labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#16a34a' : '#dc2626';
    charts['pd'] = new Chart(document.getElementById('ch-pd'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: chartOpts() });
  }
}

// ── Adjustments page ─────────────────────────────────────────────────────────
function renderAdjustments() {
  const a = accountTotals();
  renderKPIs('kpi-adj', [
    { label: 'Account Net (actual)', value: sig(a.allTimeNet), valCls: a.allTimeNet >= 0 ? 'kpi-pos' : 'kpi-neg', sub: 'Reconciled' },
    { label: 'From Trades', value: sig(a.tradesNet), valCls: a.tradesNet >= 0 ? 'kpi-pos' : 'kpi-neg', sub: trades.length + ' trades' },
    { label: 'Total Adjustments', value: a.adjTotal === 0 ? '₹0' : sig(a.adjTotal), valCls: a.adjTotal === 0 ? 'kpi-neu' : a.adjTotal > 0 ? 'kpi-pos' : 'kpi-neg', sub: adjustments.length + ' records' },
    { label: 'Last Sync', value: adjustments.length ? adjustments[adjustments.length - 1].date : '—', valCls: 'kpi-neu' },
  ]);

  // Running account net after each adjustment (chronological)
  const ordered = [...adjustments].sort((x, y) => x.date.localeCompare(y.date));
  const tb = document.getElementById('tbody-adj');
  tb.innerHTML = !ordered.length ? emptyRow(7, 'No adjustments yet — use Sync P&L to reconcile') : ordered.map((adj, i) => {
    const amt = adj.amount || 0;
    return `<tr><td class="mono" style="text-align:center;color:#555">${i + 1}</td>
      <td class="mono">${adj.date}</td>
      <td class="mono">${sig(adj.actualPnl || 0)}</td>
      <td class="adj-amt ${pc(amt)}">${sig(amt)}</td>
      <td class="mono">${sig(adj.actualPnl || 0)}</td>
      <td style="color:#888;font-size:12px">${esc(adj.note) || '—'}</td>
      <td><button class="del-btn" onclick="deleteAdjustment('${adj.id}')">×</button></td></tr>`;
  }).join('');
}

// ── Charts ─────────────────────────────────────────────────────────────────
function killChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function lineDS(data, color) {
  return { data, borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 3, pointBackgroundColor: color, pointBorderColor: 'transparent', tension: .4, borderWidth: 2.5 };
}
function chartOpts(extra = {}) {
  return {
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ₹' + (c.parsed.y ?? 0).toLocaleString('en-IN') } }, ...extra.plugins },
    scales: {
      x: { grid: { color: 'rgba(160,160,210,.12)', lineWidth: .5 }, ticks: { font: { size: 10, family: "'DM Mono',monospace" }, color: '#a3a3a3', maxTicksLimit: 7 } },
      y: { grid: { color: 'rgba(160,160,210,.12)', lineWidth: .5 }, ticks: { font: { size: 10, family: "'DM Mono',monospace" }, color: '#a3a3a3', callback: v => '₹' + v.toLocaleString('en-IN') } }
    },
    animation: { duration: 400 }, responsive: true, maintainAspectRatio: false, ...extra
  };
}

function renderCharts() {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  killChart('cc');
  if (sorted.length) {
    let cum = 0; const labels = [], data = [];
    sorted.forEach(t => { cum += net(t); labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#16a34a' : '#dc2626';
    charts['cc'] = new Chart(document.getElementById('ch-combined'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: chartOpts() });
  }

  // P&L by strategy (multi-line, shared date axis)
  killChart('bs');
  const allDates = [...new Set(trades.map(t => t.date))].sort();
  if (allDates.length) {
    const dsets = Object.values(stratMap).map(s => {
      const arr = trades.filter(t => keyOf(t) === s.id).sort((a, b) => a.date.localeCompare(b.date));
      if (!arr.length) return null;
      const byDate = {}; let cum = 0;
      arr.forEach(t => { cum += net(t); byDate[t.date] = cum; });
      let last = 0; const data = allDates.map(d => { if (byDate[d] !== undefined) last = byDate[d]; return arr[0].date <= d ? last : null; });
      return { ...lineDS(data, s.color), label: s.name, fill: false, spanGaps: true, pointRadius: 0, borderWidth: 2 };
    }).filter(Boolean);
    if (dsets.length) charts['bs'] = new Chart(document.getElementById('ch-bystrat'), { type: 'line', data: { labels: allDates, datasets: dsets }, options: chartOpts({ plugins: { legend: { display: true, labels: { font: { size: 11 }, color: '#a3a3a3', boxWidth: 10 } } } }) });
  }

  // By symbol bar
  killChart('cs');
  const smap = {};
  trades.forEach(t => { const s = t.symbol || 'OTHER'; smap[s] = (smap[s] || 0) + net(t); });
  const se = Object.entries(smap).sort((a, b) => a[1] - b[1]);
  if (se.length) {
    charts['cs'] = new Chart(document.getElementById('ch-sym'), {
      type: 'bar',
      data: { labels: se.map(e => e[0]), datasets: [{ data: se.map(e => e[1]), backgroundColor: se.map(e => e[1] >= 0 ? 'rgba(22,163,74,.15)' : 'rgba(220,38,38,.15)'), borderColor: se.map(e => e[1] >= 0 ? '#16a34a' : '#dc2626'), borderWidth: 1.5, borderRadius: 6 }] },
      options: chartOpts()
    });
  }

  // DD timeline per strategy
  killChart('cd');
  if (allDates.length) {
    const dd = ddMapAll();
    const dsets = Object.values(stratMap).map(s => {
      const arr = trades.filter(t => keyOf(t) === s.id).sort((a, b) => a.date.localeCompare(b.date));
      if (!arr.length) return null;
      const byDate = {};
      arr.forEach(t => { byDate[t.date] = (dd[t.id] || {}).dd ?? 0; });
      const data = allDates.map(d => byDate[d] !== undefined ? byDate[d] : null);
      return { ...lineDS(data, s.color), label: s.name, fill: false, spanGaps: true, pointRadius: 0, borderWidth: 2 };
    }).filter(Boolean);
    if (dsets.length) charts['cd'] = new Chart(document.getElementById('ch-dd'), { type: 'line', data: { labels: allDates, datasets: dsets }, options: chartOpts({ plugins: { legend: { display: true, labels: { font: { size: 11 }, color: '#a3a3a3', boxWidth: 10 } } } }) });
  }
}

// ── Render dispatch ──────────────────────────────────────────────────────────
function renderAll() {
  buildStratMap();
  buildDates();
  renderDashboard();
  renderAllTrades();
  renderStrategies();
  renderPortfolios();
  renderAdjustments();
  if (curPage === 'strategy-detail') renderStrategyDetail();
  if (curPage === 'portfolio-detail') renderPortfolioDetail();
  if (curPage === 'charts') renderCharts();
}

// ── Navigation ───────────────────────────────────────────────────────────────
window.goPage = function (name) {
  curPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const navName = (name === 'strategy-detail') ? 'strategies' : (name === 'portfolio-detail') ? 'portfolios' : name;
  document.querySelectorAll('.sb-item,.bn').forEach(el => el.classList.toggle('active', el.dataset.page === navName));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');
  if (name === 'charts') setTimeout(renderCharts, 60);
  if (name === 'strategy-detail') renderStrategyDetail();
  if (name === 'portfolio-detail') renderPortfolioDetail();
  if (name === 'accounts') renderAccounts();
  closeDrawer();
  document.getElementById('content').scrollTop = 0;
};
window.openStrategy = function (id) { curStratId = id; goPage('strategy-detail'); };
window.openPortfolio = function (id) { curPfId = id; goPage('portfolio-detail'); };

// ── Drawer ───────────────────────────────────────────────────────────────────
window.openDrawer = function () { document.getElementById('sidebar').classList.add('open'); document.getElementById('drawer-bd').classList.add('show'); };
window.closeDrawer = function () { document.getElementById('sidebar').classList.remove('open'); document.getElementById('drawer-bd').classList.remove('show'); };

// ── Generic modal ────────────────────────────────────────────────────────────
function openModal(title, bodyHTML, footHTML) {
  document.getElementById('modal-title-text').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-foot').innerHTML = footHTML;
  document.getElementById('modal').classList.add('open');
  document.getElementById('modal-bd').classList.add('show');
}
window.closeModal = function () { document.getElementById('modal').classList.remove('open'); document.getElementById('modal-bd').classList.remove('show'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

const today = () => new Date().toISOString().split('T')[0];

// ── Add Trade modal ──────────────────────────────────────────────────────────
window.openTradeModal = function () {
  const opts = realStrategies();
  if (!opts.length) {
    openModal('Add Trade', `<div style="color:#888;font-size:14px;line-height:1.6">You need at least one strategy before adding a trade.</div>`,
      `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="closeModal();goPage('strategies');openStrategyModal()">Create Strategy</button>`);
    return;
  }
  openModal('New Trade', `
    <div class="mrow">
      <div class="mf"><label>Date</label><input type="date" id="f-date" value="${today()}"></div>
      <div class="mf"><label>Strategy</label><select id="f-strat">${opts.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    </div>
    <div class="mrow">
      <div class="mf"><label>Symbol</label><select id="f-symbol"><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option><option>MIDCPNIFTY</option><option>SENSEX</option><option>BANKEX</option><option>OTHER</option></select></div>
      <div class="mf"><label>Lots</label><input type="number" id="f-lots" placeholder="e.g. 2" min="0.1" step="0.1"></div>
    </div>
    <div class="mrow">
      <div class="mf"><label>Gross P&L (₹)</label><input type="number" id="f-pnl" placeholder="e.g. −1500"></div>
      <div class="mf"><label>Taxes (₹)</label><input type="number" id="f-tax" placeholder="e.g. 68" min="0"></div>
    </div>
    <div class="mf"><label>Notes <em>(optional)</em></label><input type="text" id="f-notes" placeholder="anything…"></div>`,
    `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="addTrade()">Add Trade</button>`);
};

window.addTrade = async function () {
  const date = document.getElementById('f-date').value;
  const strategyId = document.getElementById('f-strat').value;
  const symbol = document.getElementById('f-symbol').value;
  const lots = parseFloat(document.getElementById('f-lots').value);
  const pnl = parseFloat(document.getElementById('f-pnl').value);
  const tax = parseFloat(document.getElementById('f-tax').value) || 0;
  const notes = document.getElementById('f-notes').value.trim();
  if (!date) return showToast('Enter a date');
  if (!strategyId) return showToast('Pick a strategy');
  if (!lots || lots <= 0) return showToast('Enter valid lots');
  if (isNaN(pnl)) return showToast('Enter P&L');
  if (roGuard()) return;
  setSyncState('syncing');
  try { await addDoc(collection(db, 'trades'), { date, strategyId, symbol, lots, pnl, tax, notes, ownerId: me.uid }); closeModal(); showToast('Trade added ✓'); }
  catch (e) { setSyncState('error'); showToast('Error — check connection'); console.error(e); }
};

window.deleteTrade = async function (id) {
  if (roGuard()) return;
  if (!confirm('Delete this trade?')) return;
  setSyncState('syncing');
  try { await deleteDoc(doc(db, 'trades', id)); showToast('Trade removed'); }
  catch (e) { setSyncState('error'); showToast('Error'); }
};

// ── Strategy modal ───────────────────────────────────────────────────────────
let pickedColor = PALETTE[0];
window.openStrategyModal = function (id) {
  const editing = id ? strategies.find(s => s.id === id) : null;
  pickedColor = editing ? editing.color : PALETTE[strategies.length % PALETTE.length];
  openModal(editing ? 'Edit Strategy' : 'New Strategy', `
    <div class="mf"><label>Name</label><input type="text" id="s-name" placeholder="e.g. 200% Strategy" value="${editing ? esc(editing.name) : ''}"></div>
    <div class="mf"><label>Delta threshold (₹ per lot)</label><input type="number" id="s-thr" min="1" step="100" value="${editing ? editing.threshold : DEFAULT_THRESHOLD}"></div>
    <div class="mf"><label>Colour</label><div class="color-row" id="s-colors">${PALETTE.map(c => `<div class="color-sw${c === pickedColor ? ' sel' : ''}" style="background:${c}" onclick="pickColor('${c}')"></div>`).join('')}</div></div>`,
    `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="saveStrategy(${editing ? `'${id}'` : 'null'})">${editing ? 'Save' : 'Create'}</button>`);
};
window.pickColor = function (c) {
  pickedColor = c;
  document.querySelectorAll('#s-colors .color-sw').forEach(el => el.classList.toggle('sel', el.style.background === c || rgbHex(el.style.background) === c));
};
function rgbHex(rgb) { const m = rgb.match(/\d+/g); if (!m) return rgb; return '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join(''); }

window.saveStrategy = async function (id) {
  if (roGuard()) return;
  const name = document.getElementById('s-name').value.trim();
  const threshold = parseFloat(document.getElementById('s-thr').value);
  if (!name) return showToast('Enter a name');
  if (!threshold || threshold < 1) return showToast('Enter a valid threshold');
  setSyncState('syncing');
  try {
    if (id) await updateDoc(doc(db, 'strategies', id), { name, threshold, color: pickedColor });
    else await addDoc(collection(db, 'strategies'), { name, threshold, color: pickedColor, createdAt: Date.now(), ownerId: me.uid });
    closeModal(); showToast(id ? 'Strategy saved ✓' : 'Strategy created ✓');
  } catch (e) { setSyncState('error'); showToast('Error'); console.error(e); }
};

window.deleteStrategy = async function (id) {
  if (roGuard()) return;
  const used = trades.filter(t => t.strategyId === id).length;
  const inPf = portfolios.filter(p => (p.strategyIds || []).includes(id)).length;
  let msg = 'Delete this strategy?';
  if (used) msg += `\n\n${used} trade(s) use it — they will become Unassigned (not deleted).`;
  if (inPf) msg += `\n${inPf} portfolio(s) reference it.`;
  if (!confirm(msg)) return;
  setSyncState('syncing');
  try {
    await deleteDoc(doc(db, 'strategies', id));
    // strip from portfolios
    await Promise.all(portfolios.filter(p => (p.strategyIds || []).includes(id))
      .map(p => updateDoc(doc(db, 'portfolios', p.id), { strategyIds: p.strategyIds.filter(x => x !== id) })));
    showToast('Strategy deleted');
  } catch (e) { setSyncState('error'); showToast('Error'); }
};

// ── Portfolio modal ──────────────────────────────────────────────────────────
let pickedStrats = new Set();
window.openPortfolioModal = function (id) {
  const editing = id ? portfolios.find(p => p.id === id) : null;
  pickedStrats = new Set(editing ? (editing.strategyIds || []) : []);
  const opts = realStrategies();
  const list = opts.length ? opts.map(s => `
    <div class="ms-item${pickedStrats.has(s.id) ? ' sel' : ''}" data-id="${s.id}" onclick="toggleStrat('${s.id}')">
      <span class="ms-check"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polyline points="2,6 4.5,8.5 9,2.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="cdot" style="background:${s.color}"></span>
      <span class="ms-name">${esc(s.name)}</span>
    </div>`).join('') : `<div class="ms-empty">No strategies yet — create one first.</div>`;
  openModal(editing ? 'Edit Portfolio' : 'New Portfolio', `
    <div class="mf"><label>Portfolio name</label><input type="text" id="p-name" placeholder="e.g. Core combo" value="${editing ? esc(editing.name) : ''}"></div>
    <div class="mf"><label>Strategies in this portfolio</label><div class="ms-grid" id="p-strats">${list}</div></div>
    <div class="switch-wrap" style="margin-top:2px">
      <label class="switch"><input type="checkbox" id="p-active" ${editing ? (editing.active ? 'checked' : '') : 'checked'}><span class="track"></span><span class="knob"></span></label>
      <span class="switch-lbl on">Mark as running</span>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="savePortfolio(${editing ? `'${id}'` : 'null'})">${editing ? 'Save' : 'Create'}</button>`);
};
window.toggleStrat = function (id) {
  if (pickedStrats.has(id)) pickedStrats.delete(id); else pickedStrats.add(id);
  const el = document.querySelector(`#p-strats .ms-item[data-id="${id}"]`);
  if (el) el.classList.toggle('sel', pickedStrats.has(id));
};
window.savePortfolio = async function (id) {
  if (roGuard()) return;
  const name = document.getElementById('p-name').value.trim();
  const active = document.getElementById('p-active').checked;
  const strategyIds = [...pickedStrats];
  if (!name) return showToast('Enter a name');
  if (!strategyIds.length) return showToast('Pick at least one strategy');
  setSyncState('syncing');
  try {
    if (id) await updateDoc(doc(db, 'portfolios', id), { name, strategyIds, active });
    else await addDoc(collection(db, 'portfolios'), { name, strategyIds, active, createdAt: Date.now(), ownerId: me.uid });
    closeModal(); showToast(id ? 'Portfolio saved ✓' : 'Portfolio created ✓');
  } catch (e) { setSyncState('error'); showToast('Error'); console.error(e); }
};
window.togglePortfolio = async function (id, on) {
  if (roGuard()) return;
  try { await updateDoc(doc(db, 'portfolios', id), { active: on }); showToast(on ? 'Running' : 'Stopped'); }
  catch (e) { showToast('Error'); }
};
window.deletePortfolio = async function (id) {
  if (roGuard()) return;
  if (!confirm('Delete this portfolio? (Trades and strategies are not affected.)')) return;
  setSyncState('syncing');
  try { await deleteDoc(doc(db, 'portfolios', id)); showToast('Portfolio deleted'); }
  catch (e) { setSyncState('error'); showToast('Error'); }
};

// ── Sync P&L (adjustment) modal ──────────────────────────────────────────────
window.openSyncModal = function () {
  const a = accountTotals();
  openModal('Sync P&L', `
    <div style="font-size:13px;color:#888;line-height:1.6;margin-bottom:4px">Enter your <b style="color:#ccc">actual total account P&L</b> right now. The difference is logged as an adjustment so the account net matches your real number. It is not added under any strategy.</div>
    <div class="mrow">
      <div class="mf"><label>Date</label><input type="date" id="a-date" value="${today()}"></div>
      <div class="mf"><label>Actual total P&L (₹)</label><input type="number" id="a-actual" placeholder="e.g. 18500" oninput="syncPreview()"></div>
    </div>
    <div class="mf"><label>Note <em>(optional)</em></label><input type="text" id="a-note" placeholder="e.g. broker statement reconcile"></div>
    <div class="sync-box">
      <div class="sync-line"><span class="k">Computed now (trades + adjustments)</span><span class="v" id="sp-now">${sig(a.allTimeNet)}</span></div>
      <div class="sync-line"><span class="k">You're entering</span><span class="v" id="sp-actual">—</span></div>
      <div class="sync-line delta"><span class="k">Adjustment to log</span><span class="v" id="sp-delta">—</span></div>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="addAdjustment()">Log Adjustment</button>`);
  syncPreview();
};
window.syncPreview = function () {
  const a = accountTotals();
  const v = parseFloat(document.getElementById('a-actual').value);
  const actEl = document.getElementById('sp-actual'), dEl = document.getElementById('sp-delta');
  if (isNaN(v)) { actEl.textContent = '—'; dEl.textContent = '—'; dEl.className = 'v'; return; }
  const delta = v - a.allTimeNet;
  actEl.textContent = sig(v);
  dEl.textContent = sig(delta);
  dEl.className = 'v ' + (delta > 0 ? 'vpos' : delta < 0 ? 'vneg' : 'vneu');
};
window.addAdjustment = async function () {
  const date = document.getElementById('a-date').value;
  const actualPnl = parseFloat(document.getElementById('a-actual').value);
  const note = document.getElementById('a-note').value.trim();
  if (!date) return showToast('Enter a date');
  if (isNaN(actualPnl)) return showToast('Enter actual P&L');
  const a = accountTotals();
  const amount = actualPnl - a.allTimeNet;
  if (amount === 0) return showToast('Already in sync — no adjustment needed');
  if (roGuard()) return;
  setSyncState('syncing');
  try { await addDoc(collection(db, 'adjustments'), { date, actualPnl, amount, note, ownerId: me.uid }); closeModal(); showToast('Adjustment logged ✓'); }
  catch (e) { setSyncState('error'); showToast('Error'); console.error(e); }
};
window.deleteAdjustment = async function (id) {
  if (roGuard()) return;
  if (!confirm('Delete this adjustment?')) return;
  setSyncState('syncing');
  try { await deleteDoc(doc(db, 'adjustments', id)); showToast('Adjustment removed'); }
  catch (e) { setSyncState('error'); showToast('Error'); }
};

// ── Migrate legacy 200/300 trades to real strategies ─────────────────────────
window.migrateLegacy = async function () {
  if (roGuard()) return;
  const legacy = trades.filter(t => !t.strategyId && t.strat);
  if (!legacy.length) return showToast('Nothing to migrate');
  if (!confirm(`Migrate ${legacy.length} legacy trade(s) into real strategies? This creates strategies for 200/300 and links the trades.`)) return;
  setSyncState('syncing');
  try {
    const tags = [...new Set(legacy.map(t => t.strat))];
    const tagToId = {};
    for (const tag of tags) {
      let s = strategies.find(x => x.legacyTag === tag);
      if (!s) {
        const ref = await addDoc(collection(db, 'strategies'), {
          name: tag + '% Strategy', threshold: DEFAULT_THRESHOLD,
          color: tag === '200' ? '#f97316' : tag === '300' ? '#737373' : PALETTE[0],
          legacyTag: tag, createdAt: Date.now(), ownerId: me.uid,
        });
        tagToId[tag] = ref.id;
      } else tagToId[tag] = s.id;
    }
    await Promise.all(legacy.map(t => updateDoc(doc(db, 'trades', t.id), { strategyId: tagToId[t.strat] })));
    showToast('Migrated ✓');
  } catch (e) { setSyncState('error'); showToast('Migration error'); console.error(e); }
};

// ── Filters / sort / csv / toast ─────────────────────────────────────────────
window.setF = function (key, val) {
  if (key === 'result') { fResult = fResult === val ? '' : val; document.querySelectorAll('[data-key="result"]').forEach(b => b.classList.toggle('on', b.dataset.val === fResult)); }
  renderAllTrades();
};
window.clearFilters = function () {
  fResult = '';
  ['fil-strat', 'fil-symbol', 'fil-from', 'fil-to'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  document.querySelectorAll('[data-key="result"]').forEach(b => b.classList.remove('on'));
  renderAllTrades();
};
window.sortBy = function (key) {
  if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
  ['date', 'pnl', 'net', 'lots'].forEach(k => { const el = document.getElementById('th-' + k); if (el) el.className = 'th-sort' + (k === sortKey ? (sortDir === 1 ? ' s-asc' : ' s-desc') : ''); });
  renderAllTrades();
};

window.exportCSV = function () {
  if (!trades.length) return showToast('No trades');
  const dd = ddMapAll();
  const rows = [['#', 'Date', 'Strategy', 'Symbol', 'Lots', 'Gross P&L', 'Taxes', 'Net P&L', 'Drawdown', 'DD/Lot', 'Delta Alert', 'Notes']];
  [...trades].sort((a, b) => a.date.localeCompare(b.date)).forEach((t, i) => {
    const s = stratOf(t), d = dd[t.id];
    rows.push([i + 1, t.date, s.name, t.symbol || '', t.lots, t.pnl, t.tax || 0, net(t), d ? d.dd : 0, d ? d.ddpl : 0, (d && isAlert(d, s.threshold)) ? 'YES' : 'NO', t.notes || '']);
  });
  if (adjustments.length) {
    rows.push([]); rows.push(['ADJUSTMENTS']); rows.push(['#', 'Date', 'Actual P&L', 'Adjustment', 'Note']);
    [...adjustments].sort((a, b) => a.date.localeCompare(b.date)).forEach((a, i) => rows.push([i + 1, a.date, a.actualPnl, a.amount, a.note || '']));
  }
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = 'tradejournal_' + today() + '.csv';
  link.click(); showToast('CSV exported');
};

// ── CSV import (reads the app's own export format, old or new) ────────────────
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; if (cur !== '' || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; } }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

window.onCsvFile = async function (e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (roGuard()) return;
  let text; try { text = await file.text(); } catch (_) { return showToast('Could not read file'); }
  const rows = parseCSV(text);
  if (rows.length < 2) return showToast('Empty CSV');

  const hi = rows.findIndex(r => r.includes('Date') && (r.includes('Gross P&L') || r.includes('Lots')));
  if (hi < 0) return showToast('Unrecognised CSV format');
  const H = rows[hi], col = n => H.indexOf(n);
  const cD = col('Date'), cS = col('Strategy'), cSym = col('Symbol'), cL = col('Lots'), cG = col('Gross P&L'), cT = col('Taxes'), cN = col('Notes');
  if (cD < 0 || cL < 0 || cG < 0) return showToast('CSV missing required columns');

  const tRows = []; let adjStart = -1;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every(c => c === '')) continue;
    if (r[0] === 'ADJUSTMENTS') { adjStart = i; break; }
    if (!r[cD]) continue;
    tRows.push(r);
  }

  // resolve strategies (existing by name / legacy tag, else queue for creation)
  const nameToId = {}; strategies.forEach(s => nameToId[s.name.toLowerCase()] = s.id);
  const tagToStrat = {}; strategies.forEach(s => { if (s.legacyTag) tagToStrat[s.legacyTag] = s; });
  const toCreate = [], seen = {};
  function resolveStrat(raw) {
    const v = (raw || '').trim() || 'Imported';
    if (seen[v] !== undefined) return seen[v];
    if (nameToId[v.toLowerCase()]) return seen[v] = nameToId[v.toLowerCase()];
    const m = v.match(/^(\d+)\s*%/);
    if (m) {
      const tag = m[1], nm = tag + '% Strategy';
      if (tagToStrat[tag]) return seen[v] = tagToStrat[tag].id;
      if (nameToId[nm.toLowerCase()]) return seen[v] = nameToId[nm.toLowerCase()];
      toCreate.push({ tag, name: nm, color: tag === '200' ? '#f97316' : tag === '300' ? '#737373' : PALETTE[toCreate.length % PALETTE.length] });
      return seen[v] = '@' + toCreate.length;
    }
    toCreate.push({ name: v, color: PALETTE[(strategies.length + toCreate.length) % PALETTE.length] });
    return seen[v] = '@' + toCreate.length;
  }
  tRows.forEach(r => resolveStrat(r[cS]));

  // optional adjustments section (new-format exports round-trip)
  let aRows = [];
  if (adjStart >= 0) {
    const ah = rows[adjStart + 1] || [], ac = n => ah.indexOf(n);
    const aD = ac('Date'), aA = ah.findIndex(x => /Actual/i.test(x)), aAmt = ac('Adjustment'), aN = ac('Note');
    if (aD >= 0 && aAmt >= 0) for (let i = adjStart + 2; i < rows.length; i++) {
      const r = rows[i]; if (!r.length || !r[aD]) continue;
      aRows.push({ date: r[aD], actualPnl: aA >= 0 ? parseFloat(r[aA]) || 0 : 0, amount: parseFloat(r[aAmt]) || 0, note: aN >= 0 ? (r[aN] || '') : '' });
    }
  }

  // names for placeholders + existing ids
  const placeName = {}; toCreate.forEach((c, i) => placeName['@' + (i + 1)] = c.name);
  const nameForId = {}; strategies.forEach(s => nameForId[s.id] = s.name);
  const finalName = ref => (typeof ref === 'string' && ref[0] === '@') ? placeName[ref] : (nameForId[ref] || ref);

  // dedup vs existing trades (by resolved strategy name, so legacy + real both match)
  const sigOf = (d, name, sym, lots, pnl, tax) => [d, (name || '').toLowerCase(), sym || 'OTHER', (+lots).toFixed(3), (+pnl).toFixed(2), (+tax).toFixed(2)].join('|');
  const existing = new Set(trades.map(t => { const s = stratOf(t); return sigOf(t.date, s.name, t.symbol, t.lots, t.pnl, t.tax || 0); }));
  const adjExisting = new Set(adjustments.map(a => [a.date, (+a.amount).toFixed(2)].join('|')));

  let dup = 0; const plan = [];
  tRows.forEach(r => {
    const ref = resolveStrat(r[cS]), name = finalName(ref);
    const symbol = (r[cSym] || '').trim() || 'OTHER';
    const lots = parseFloat(r[cL]) || 0, pnl = parseFloat(r[cG]) || 0, tax = cT >= 0 ? (parseFloat(r[cT]) || 0) : 0;
    const sig = sigOf(r[cD], name, symbol, lots, pnl, tax);
    if (existing.has(sig)) { dup++; return; }
    existing.add(sig);
    plan.push({ date: r[cD], ref, symbol, lots, pnl, tax, notes: cN >= 0 ? (r[cN] || '') : '' });
  });
  const adjPlan = aRows.filter(a => { const k = [a.date, (+a.amount).toFixed(2)].join('|'); if (adjExisting.has(k)) return false; adjExisting.add(k); return true; });

  if (!plan.length && !adjPlan.length) return showToast(dup ? `All ${dup} rows already imported` : 'Nothing to import');

  let msg = `Import ${plan.length} trade(s)`;
  if (toCreate.length) msg += `, create ${toCreate.length} strateg${toCreate.length > 1 ? 'ies' : 'y'} (${toCreate.map(c => c.name).join(', ')})`;
  if (adjPlan.length) msg += `, ${adjPlan.length} adjustment(s)`;
  if (dup) msg += `. Skipping ${dup} duplicate(s)`;
  if (!confirm(msg + '?')) return;

  setSyncState('syncing');
  try {
    const idMap = {};
    for (let i = 0; i < toCreate.length; i++) {
      const c = toCreate[i];
      const ref = await addDoc(collection(db, 'strategies'), { name: c.name, threshold: DEFAULT_THRESHOLD, color: c.color, ...(c.tag ? { legacyTag: c.tag } : {}), createdAt: Date.now() + i, ownerId: me.uid });
      idMap['@' + (i + 1)] = ref.id;
    }
    await Promise.all(plan.map(p => addDoc(collection(db, 'trades'), {
      date: p.date, strategyId: (typeof p.ref === 'string' && p.ref[0] === '@') ? idMap[p.ref] : p.ref,
      symbol: p.symbol, lots: p.lots, pnl: p.pnl, tax: p.tax, notes: p.notes, ownerId: me.uid
    })));
    await Promise.all(adjPlan.map(a => addDoc(collection(db, 'adjustments'), { date: a.date, actualPnl: a.actualPnl, amount: a.amount, note: a.note, ownerId: me.uid })));
    showToast(`Imported ${plan.length} trade(s)${adjPlan.length ? ' + ' + adjPlan.length + ' adj' : ''} ✓`);
  } catch (err) { setSyncState('error'); showToast('Import error'); console.error(err); }
};

// ── Auth UI ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('splash').classList.add('out');
  document.getElementById('app').classList.add('hidden');
  const lg = document.getElementById('login'); if (lg) lg.classList.add('show');
  appReady = false;
}
function hideLogin() { const lg = document.getElementById('login'); if (lg) lg.classList.remove('show'); }
function authError(msg) {
  const el = document.getElementById('login-err'); if (el) { el.textContent = msg; el.style.display = 'block'; }
  showLogin();
}

window.doLogin = async function () {
  const email = document.getElementById('lg-email').value.trim();
  const pw = document.getElementById('lg-pw').value;
  const err = document.getElementById('login-err');
  if (!email || !pw) { err.textContent = 'Enter email and password'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  try { await signInWithEmailAndPassword(auth, email, pw); }
  catch (e) { err.textContent = loginErr(e); err.style.display = 'block'; }
};
window.doLogout = async function () { try { await signOut(auth); location.reload(); } catch (_) {} };

// superadmin setup has been disabled — the superadmin already exists.
function loginErr(e) {
  const c = (e && e.code) || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Wrong email or password';
  if (c.includes('email-already-in-use')) return 'That email already has an account — sign in instead';
  if (c.includes('permission')) return 'Setup blocked by security rules — check the superadmin email in your rules';
  return (e && e.message) ? e.message.replace('Firebase: ', '') : 'Something went wrong';
}
async function setDocProfile(uid, data) { await setDoc(doc(db, 'users', uid), data); }

// top-bar identity + view banner
function renderTopUser() {
  const el = document.getElementById('tb-user'); if (!el) return;
  el.innerHTML = `<div class="user-chip"><span class="user-name">${esc(me.displayName || me.email)}</span><span class="user-role">${me.role}</span></div>
    <button class="tb-logout" title="Sign out" onclick="doLogout()"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M6 2H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 10l3-2.5L10 5M13 7.5H6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  // show/hide manage-only nav
  document.querySelectorAll('[data-page="accounts"]').forEach(b => b.style.display = canManage() ? '' : 'none');
}
function renderViewBanner() {
  let b = document.getElementById('ro-banner');
  if (!b) return;
  if (isRO()) {
    b.style.display = 'flex';
    b.innerHTML = `<span>Viewing <b>${esc(viewing.displayName || viewing.email)}</b> — read-only</span>
      <button onclick="exitView()">Back to my account</button>`;
  } else { b.style.display = 'none'; b.innerHTML = ''; }
}

// ── Accounts page ─────────────────────────────────────────────────────────────
async function renderAccounts() {
  await loadChildren();
  const el = document.getElementById('acct-list');
  if (!el) return;
  if (!children.length) {
    el.innerHTML = `<div class="card" style="grid-column:1/-1;text-align:center;padding:40px"><div style="color:#888;margin-bottom:14px">No accounts yet. Create one to give someone their own isolated journal.</div><button class="btn-primary" onclick="openAccountModal()">Create account</button></div>`;
    return;
  }
  const nameById = { [me.uid]: (me.displayName || me.email) + ' (you)' };
  children.forEach(c => { nameById[c.uid] = c.displayName || c.email; });
  el.innerHTML = children.map(c => {
    const isDirect = c.parentId === me.uid;
    const creator = nameById[c.parentId] || '—';
    const canDel = me.role === 'superadmin' && c.role !== 'superadmin';
    return `
    <div class="scard">
      <div class="scard-top">
        <div class="scard-name"><span class="cdot" style="background:${c.role === 'manager' ? '#3b82f6' : '#10b981'}"></span><span>${esc(c.displayName || c.email)}</span></div>
        <div class="scard-acts">
          ${me.role === 'superadmin' && c.role !== 'superadmin' ? `<button class="icon-btn" title="${c.role === 'manager' ? 'Demote to user' : 'Make manager'}" onclick="toggleRole('${c.uid}','${c.role}')">${c.role === 'manager' ? 'M' : 'U'}</button>` : ''}
          ${canDel ? `<button class="icon-btn danger" title="Delete account" onclick="deleteAccount('${c.uid}')"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 3.5h8M5 3.5V2.3h3v1.2M3.5 3.5l.5 7.5h5l.5-7.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ''}
        </div>
      </div>
      <div class="scard-meta" style="margin-bottom:8px">${esc(c.email)}</div>
      <div class="scard-stats" style="margin-bottom:16px"><span class="spill">${c.role}</span>${me.role === 'superadmin' && !isDirect ? `<span class="spill">by ${esc(creator)}</span>` : ''}</div>
      <button class="f-btn" style="width:100%;height:36px" onclick="viewAccount('${c.uid}')">View P&amp;L (read-only)</button>
    </div>`;
  }).join('');
}

window.openAccountModal = function () {
  if (!canManage()) return showToast('Not allowed');
  const roleField = me.role === 'superadmin'
    ? `<div class="mf"><label>Role</label><select id="ac-role"><option value="user">User</option><option value="manager">Manager (can create their own accounts)</option></select></div>`
    : `<input type="hidden" id="ac-role" value="user">`;
  openModal('Create account', `
    <div style="font-size:13px;color:#888;line-height:1.6">Creates a fresh login with its own empty journal. You'll be able to view its P&L (read-only).</div>
    <div class="mf"><label>Display name</label><input type="text" id="ac-name" placeholder="e.g. Desk 2 / partner's client"></div>
    <div class="mrow">
      <div class="mf"><label>Email</label><input type="email" id="ac-email" placeholder="login@email.com"></div>
      <div class="mf"><label>Password</label><input type="text" id="ac-pw" placeholder="min 6 chars"></div>
    </div>
    ${roleField}`,
    `<button class="btn-ghost" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="createAccount()">Create</button>`);
};

window.createAccount = async function () {
  if (!canManage()) return showToast('Not allowed');
  if (!secondaryAuth) return showToast('Account creation unavailable');
  const name = document.getElementById('ac-name').value.trim();
  const email = document.getElementById('ac-email').value.trim();
  const pw = document.getElementById('ac-pw').value;
  const role = (document.getElementById('ac-role') || {}).value || 'user';
  if (!email || pw.length < 6) return showToast('Email + password (6+ chars) required');
  setSyncState('syncing');
  try {
    // create the auth user on the secondary app so our own session is untouched
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pw);
    const childUid = cred.user.uid;
    await signOut(secondaryAuth);
    // write its profile from OUR session (so parentId == me.uid passes the rules)
    await setDocProfile(childUid, { email, displayName: name || email, role: (me.role === 'superadmin' ? role : 'user'), parentId: me.uid, createdAt: Date.now() });
    closeModal(); showToast('Account created ✓');
    await loadChildren(); if (curPage === 'accounts') renderAccounts();
  } catch (e) { setSyncState('error'); showToast(loginErr(e)); console.error(e); }
};

window.toggleRole = async function (uid, cur) {
  if (me.role !== 'superadmin') return showToast('Only superadmin can change roles');
  const next = cur === 'manager' ? 'user' : 'manager';
  if (!confirm(`Change this account to "${next}"?`)) return;
  try { await updateDoc(doc(db, 'users', uid), { role: next }); showToast('Role updated'); await loadChildren(); renderAccounts(); }
  catch (e) { showToast('Error'); console.error(e); }
};

window.viewAccount = function (uid) {
  const c = children.find(x => x.uid === uid); if (!c) return;
  setContext(uid, c);
  goPage('dashboard');
};
window.exitView = function () { setContext(me.uid, null); goPage('dashboard'); };

window.deleteAccount = async function (uid) {
  if (me.role !== 'superadmin') return showToast('Only superadmin can delete accounts');
  const c = children.find(x => x.uid === uid); if (!c) return;
  if (c.role === 'superadmin') return showToast('Cannot delete a superadmin');
  if (!confirm(`Delete "${c.displayName || c.email}" and ALL of its trades, strategies, portfolios and adjustments?\n\nThis cannot be undone. The login is disabled (remove it fully under Authentication if you like).`)) return;
  setSyncState('syncing');
  try {
    if (viewing && viewing.uid === uid) setContext(me.uid, null);
    for (const coll of ['trades', 'strategies', 'portfolios', 'adjustments']) {
      const snap = await getDocs(query(collection(db, coll), where('ownerId', '==', uid)));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const b = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach(d => b.delete(doc(db, coll, d.id)));
        await b.commit();
      }
    }
    await deleteDoc(doc(db, 'users', uid));
    showToast('Account deleted');
    await loadChildren(); renderAccounts();
  } catch (e) { setSyncState('error'); showToast('Delete failed — check permissions'); console.error(e); }
};

let toastT;
window.showToast = function (msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2500);
};

// ── Init ─────────────────────────────────────────────────────────────────────
boot();
