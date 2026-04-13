import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot, query, orderBy, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ── State ──────────────────────────────────────────────────────────────────
let trades = [], threshold = 1000, sortKey = 'date', sortDir = 1;
let fStrat = '', fResult = '';
let charts = {};

// ── Firebase ───────────────────────────────────────────────────────────────
function boot() {
  setSync('loading');
  animateLoader();

  getDoc(doc(db, 'settings', 'threshold')).then(d => {
    if (d.exists()) { threshold = d.data().value ?? 1000; }
    document.getElementById('dd-threshold').value = threshold;
    document.getElementById('threshold-display').textContent = threshold.toLocaleString('en-IN');
  });

  onSnapshot(query(collection(db, 'trades'), orderBy('date')), snap => {
    trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync('live');
    showApp();
    renderAll();
  }, err => {
    console.error(err);
    setSync('error');
    document.getElementById('loader-status').textContent = 'Firebase error — check console';
    showApp();
  });
}

function animateLoader() {
  const bar = document.getElementById('loader-bar');
  if (bar) { bar.style.width = '0%'; setTimeout(() => bar.style.width = '60%', 100); }
}

let appShown = false;
function showApp() {
  if (appShown) return;
  appShown = true;
  const lb = document.getElementById('loader-bar');
  if (lb) lb.style.width = '100%';
  setTimeout(() => {
    document.getElementById('loader').classList.add('out');
    document.getElementById('app').classList.remove('hidden');
    setTimeout(() => { const l = document.getElementById('loader'); if (l) l.remove(); }, 600);
  }, 300);
}

function setSync(state) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (!dot) return;
  dot.className = 'sync-dot ' + state;
  lbl.textContent = state === 'live' ? 'Live' : state === 'loading' ? 'Syncing' : 'Error';
}

// ── Formatters ─────────────────────────────────────────────────────────────
function inr(n) { return '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 }); }
function sig(n) { return (n >= 0 ? '+' : '−') + inr(Math.abs(n)); }
function pc(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; }

// ── DD Engine ──────────────────────────────────────────────────────────────
function computeDD(arr) {
  let run = 0, peak = 0, wasDD = false;
  return arr.map(t => {
    run += t.pnl - t.tax;
    if (run > peak) peak = run;
    const dd = Math.min(0, run - peak);
    const normalize = wasDD && dd === 0;
    wasDD = dd < 0;
    return { run, peak, dd, ddpl: dd < 0 && t.lots > 0 ? dd / t.lots : 0, normalize };
  });
}

function isAlert(d) { return d && d.dd < 0 && d.ddpl <= -threshold; }

function getDDMaps() {
  const t2 = trades.filter(t => t.strat === '200').sort((a, b) => a.date.localeCompare(b.date));
  const t3 = trades.filter(t => t.strat === '300').sort((a, b) => a.date.localeCompare(b.date));
  const m2 = {}, m3 = {};
  computeDD(t2).forEach((d, i) => m2[t2[i].id] = d);
  computeDD(t3).forEach((d, i) => m3[t3[i].id] = d);
  return { m2, m3, t2, t3 };
}

function ddCell(d) {
  if (!d) return `<span style="color:var(--text3)">—</span>`;
  if (d.normalize) return `<span class="delta-down">↓ normalize delta</span>`;
  if (d.dd >= 0) return `<span style="color:var(--text3)">—</span>`;
  const abs = Math.abs(d.ddpl);
  const pct = Math.min(100, abs / threshold * 100);
  const col = pct >= 100 ? 'var(--red)' : pct >= 70 ? '#f97316' : pct >= 40 ? 'var(--amber)' : 'var(--emerald)';
  return `<div class="dd-wrap"><div class="dd-row-inner"><span class="neg">−${inr(abs)}</span>${isAlert(d) ? `<span class="delta-up">↑ delta</span>` : ''}</div><div class="dd-bar-track"><div class="dd-bar-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div></div>`;
}

function empty(cols) { return `<tr><td colspan="${cols}" class="empty-row">No trades yet — tap Add Trade to begin</td></tr>`; }

// ── KPI grid ───────────────────────────────────────────────────────────────
function renderKPI(elId, items) {
  document.getElementById(elId).innerHTML = items.map(k => `
    <div class="kpi${k.accent ? ' kpi-accent-' + k.accent : ''}">
      <div class="kpi-label"><div class="kpi-label-dot" style="background:${k.dotColor || 'var(--text3)'}"></div>${k.label}</div>
      <div class="kpi-value ${k.cls}">${k.value}</div>
      ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''}
    </div>`).join('');
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const { m2, m3, t2, t3 } = getDDMaps();
  const tg = trades.reduce((s, t) => s + t.pnl, 0);
  const tx = trades.reduce((s, t) => s + t.tax, 0);
  const net = tg - tx;
  const maxDD2 = t2.length ? Math.min(...t2.map(t => m2[t.id].dd)) : 0;
  const maxDD3 = t3.length ? Math.min(...t3.map(t => m3[t.id].dd)) : 0;

  renderKPI('kpi-grid', [
    { label: 'Net P&L', value: sig(net), cls: pc(net) + ' kpi-' + pc(net), sub: 'Gross ' + sig(tg), accent: net >= 0 ? 'green' : 'red', dotColor: net >= 0 ? 'var(--emerald)' : 'var(--red)' },
    { label: 'Total Taxes', value: inr(tx), cls: 'kpi-neu', sub: trades.length + ' trade' + (trades.length !== 1 ? 's' : ''), dotColor: 'var(--text3)' },
    { label: '200% Max DD', value: maxDD2 < 0 ? '−' + inr(Math.abs(maxDD2)) : '—', cls: maxDD2 < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'Peak-based', accent: maxDD2 < 0 ? 'red' : '', dotColor: 'var(--blue)' },
    { label: '300% Max DD', value: maxDD3 < 0 ? '−' + inr(Math.abs(maxDD3)) : '—', cls: maxDD3 < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'Peak-based', accent: maxDD3 < 0 ? 'red' : '', dotColor: 'var(--teal)' },
  ]);

  // Recent trades
  const recent = [...trades].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  document.getElementById('recent-count').textContent = recent.length + ' of ' + trades.length;
  document.getElementById('recent-list').innerHTML = recent.length ? recent.map(t => {
    const net = t.pnl - t.tax;
    return `<div class="recent-item">
      <div class="recent-strat rs-${t.strat}">${t.strat}%</div>
      <div class="recent-info">
        <div class="recent-sym">${t.symbol || '—'}</div>
        <div class="recent-date">${t.date} · ${t.lots} lots</div>
      </div>
      <div class="recent-pnl ${pc(net)}">${sig(net)}</div>
    </div>`;
  }).join('') : '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">No trades yet</div>';

  // Dashboard combined chart
  killChart('dash');
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length) {
    let cum = 0;
    const labels = [], data = [];
    sorted.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#10b981' : '#ef4444';
    charts['dash'] = new Chart(document.getElementById('dash-chart'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: cOpts() });
  }

  // Sym chart
  killChart('dsym');
  const smap = {};
  trades.forEach(t => { const s = t.symbol || 'OTHER'; smap[s] = (smap[s] || 0) + (t.pnl - t.tax); });
  const se = Object.entries(smap).sort((a, b) => a[1] - b[1]);
  if (se.length) {
    charts['dsym'] = new Chart(document.getElementById('dash-sym-chart'), {
      type: 'bar',
      data: { labels: se.map(e => e[0]), datasets: [{ data: se.map(e => e[1]), backgroundColor: se.map(e => e[1] >= 0 ? 'rgba(16,185,129,.2)' : 'rgba(239,68,68,.2)'), borderColor: se.map(e => e[1] >= 0 ? '#10b981' : '#ef4444'), borderWidth: 1.5, borderRadius: 5 }] },
      options: cOpts()
    });
  }
}

// ── All Trades ─────────────────────────────────────────────────────────────
function buildDates() {
  const dates = [...new Set(trades.map(t => t.date))].sort();
  ['fil-from', 'fil-to'].forEach(id => {
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = `<option value="">${id === 'fil-from' ? 'From…' : 'To…'}</option>` + dates.map(d => `<option${d === cur ? ' selected' : ''}>${d}</option>`).join('');
  });
}

function renderAllTrades() {
  const fy = document.getElementById('fil-symbol').value;
  const ff = document.getElementById('fil-from').value;
  const ft = document.getElementById('fil-to').value;
  const { m2, m3 } = getDDMaps();
  const ddOf = t => t.strat === '200' ? m2[t.id] : m3[t.id];

  let list = trades.filter(t => {
    if (fStrat && t.strat !== fStrat) return false;
    if (fy && t.symbol !== fy) return false;
    if (ff && t.date < ff) return false;
    if (ft && t.date > ft) return false;
    const d = ddOf(t);
    if (fResult === 'loss' && t.pnl >= 0) return false;
    if (fResult === 'profit' && t.pnl <= 0) return false;
    if (fResult === 'alert' && !isAlert(d)) return false;
    return true;
  }).sort((a, b) => {
    const kv = t => ({ date: t.date, pnl: t.pnl, net: t.pnl - t.tax, lots: t.lots }[sortKey] ?? 0);
    const av = kv(a), bv = kv(b);
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });

  document.getElementById('all-subtitle').textContent = list.length + ' of ' + trades.length + ' trades shown';

  const tbody = document.getElementById('all-tbody');
  if (!list.length) { tbody.innerHTML = empty(12); renderSymbolTable(); return; }

  tbody.innerHTML = list.map((t, i) => {
    const d = ddOf(t), net = t.pnl - t.tax, al = isAlert(d);
    return `<tr class="${al ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="text-align:center;color:var(--text3)">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="strat-badge sb-${t.strat}">${t.strat}%</span></td>
      <td><span class="sym-tag">${t.symbol || '—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d ? d.dd : 0)}">${d && d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d)}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text3)" title="${t.notes || ''}">${t.notes || '—'}</td>
      <td><button onclick="deleteTrade('${t.id}')" style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--text3);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s" onmouseover="this.style.background='var(--red-dim)';this.style.color='var(--red)';this.style.borderColor='rgba(248,113,113,.3)'" onmouseout="this.style.background='transparent';this.style.color='var(--text3)';this.style.borderColor='var(--border)'">×</button></td>
    </tr>`;
  }).join('');
  renderSymbolTable();
}

function renderSymbolTable() {
  const map = {};
  trades.forEach(t => {
    const s = t.symbol || 'OTHER';
    if (!map[s]) map[s] = { n: 0, g: 0, tx: 0, w: 0, l: 0 };
    map[s].n++; map[s].g += t.pnl; map[s].tx += t.tax;
    t.pnl >= 0 ? map[s].w++ : map[s].l++;
  });
  const rows = Object.entries(map).sort((a, b) => a[1].g - b[1].g);
  document.getElementById('sym-count').textContent = rows.length + ' symbol' + (rows.length !== 1 ? 's' : '');
  if (!rows.length) { document.getElementById('symbol-tbody').innerHTML = empty(8); return; }
  document.getElementById('symbol-tbody').innerHTML = rows.map(([sym, s]) => {
    const net = s.g - s.tx, wr = s.n > 0 ? Math.round(s.w / s.n * 100) : 0;
    return `<tr class="${net < 0 ? 'tr-loss' : ''}">
      <td><span class="sym-tag">${sym}</span></td>
      <td class="mono">${s.n}</td>
      <td class="${pc(s.g)}">${sig(s.g)}</td>
      <td class="mono">${inr(s.tx)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="mono" style="color:var(--emerald)">${s.w}</td>
      <td class="mono" style="color:var(--red)">${s.l}</td>
      <td><div class="wr-wrap"><span class="mono ${wr >= 50 ? 'pos' : 'neg'}">${wr}%</span><div class="wr-bar"><div class="wr-fill" style="width:${wr}%;background:${wr >= 50 ? 'var(--emerald)' : 'var(--red)'}"></div></div></div></td>
    </tr>`;
  }).join('');
}

// ── Strategy pages ─────────────────────────────────────────────────────────
function renderStratPage(strat) {
  const arr = trades.filter(t => t.strat === strat).sort((a, b) => a.date.localeCompare(b.date));
  const dds = computeDD(arr);
  const tn = arr.reduce((s, t) => s + t.pnl - t.tax, 0);
  const tx = arr.reduce((s, t) => s + t.tax, 0);
  const mdd = dds.length ? Math.min(...dds.map(d => d.dd)) : 0;
  const al = dds.filter(d => isAlert(d)).length;
  const dot = strat === '200' ? 'var(--blue)' : 'var(--teal)';

  renderKPI('kpi-' + strat, [
    { label: 'Net P&L', value: sig(tn), cls: 'kpi-' + pc(tn), sub: arr.length + ' trades', accent: tn >= 0 ? 'green' : 'red', dotColor: tn >= 0 ? 'var(--emerald)' : 'var(--red)' },
    { label: 'Total Taxes', value: inr(tx), cls: 'kpi-neu', dotColor: 'var(--text3)' },
    { label: 'Max Drawdown', value: mdd < 0 ? '−' + inr(Math.abs(mdd)) : '—', cls: mdd < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'From all-time peak', accent: mdd < 0 ? 'red' : '', dotColor: dot },
    { label: 'Delta Alerts', value: '×' + al, cls: al > 0 ? 'kpi-warn' : 'kpi-neu', sub: '≥ ' + inr(threshold) + '/lot', accent: al > 0 ? 'amber' : '', dotColor: al > 0 ? 'var(--amber)' : 'var(--text3)' },
  ]);

  const tb = document.getElementById('tbody-' + strat);
  if (!arr.length) { tb.innerHTML = empty(12); return; }
  tb.innerHTML = arr.map((t, i) => {
    const d = dds[i], net = t.pnl - t.tax;
    return `<tr class="${isAlert(d) ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="text-align:center;color:var(--text3)">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="sym-tag">${t.symbol || '—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d.run)}">${sig(d.run)}</td>
      <td class="mono">${inr(d.peak)}</td>
      <td class="${pc(d.dd)}">${d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d)}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text3)">${t.notes || '—'}</td>
    </tr>`;
  }).join('');
}

// ── Charts ─────────────────────────────────────────────────────────────────
function killChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function cOpts(extra = {}) {
  return {
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ₹' + (c.parsed.y ?? 0).toLocaleString('en-IN') } }, ...extra.plugins },
    scales: {
      x: { grid: { color: '#1e2a42', lineWidth: .5 }, ticks: { font: { size: 10, family: "'JetBrains Mono',monospace" }, color: '#3d4f70', maxTicksLimit: 7 } },
      y: { grid: { color: '#1e2a42', lineWidth: .5 }, ticks: { font: { size: 10, family: "'JetBrains Mono',monospace" }, color: '#3d4f70', callback: v => '₹' + v.toLocaleString('en-IN') } }
    },
    animation: { duration: 500 }, responsive: true, maintainAspectRatio: false, ...extra
  };
}

function lineDS(data, color) {
  return { data, borderColor: color, backgroundColor: color + '18', fill: true, pointRadius: 3, pointBackgroundColor: color, pointBorderColor: 'transparent', tension: .4, borderWidth: 2 };
}

function renderCharts() {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const t2 = sorted.filter(t => t.strat === '200');
  const t3 = sorted.filter(t => t.strat === '300');

  const buildLine = (arr, id, key) => {
    killChart(key);
    if (!arr.length) return;
    let cum = 0;
    const labels = [], data = [];
    arr.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#10b981' : '#ef4444';
    charts[key] = new Chart(document.getElementById(id), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: cOpts() });
  };

  buildLine(sorted, 'chart-combined', 'cc');
  buildLine(t2, 'chart-200', 'c2');
  buildLine(t3, 'chart-300', 'c3');

  killChart('cs');
  const smap = {};
  trades.forEach(t => { const s = t.symbol || 'OTHER'; smap[s] = (smap[s] || 0) + (t.pnl - t.tax); });
  const se = Object.entries(smap).sort((a, b) => a[1] - b[1]);
  if (se.length) {
    charts['cs'] = new Chart(document.getElementById('chart-symbol'), {
      type: 'bar',
      data: { labels: se.map(e => e[0]), datasets: [{ data: se.map(e => e[1]), backgroundColor: se.map(e => e[1] >= 0 ? 'rgba(16,185,129,.2)' : 'rgba(239,68,68,.2)'), borderColor: se.map(e => e[1] >= 0 ? '#10b981' : '#ef4444'), borderWidth: 1.5, borderRadius: 5 }] },
      options: cOpts()
    });
  }

  killChart('cd');
  if (sorted.length) {
    const { m2, m3 } = getDDMaps();
    const labels = [], d2 = [], d3 = [];
    sorted.forEach(t => {
      labels.push(t.date);
      if (t.strat === '200') { d2.push(m2[t.id]?.dd ?? 0); d3.push(null); }
      else { d3.push(m3[t.id]?.dd ?? 0); d2.push(null); }
    });
    charts['cd'] = new Chart(document.getElementById('chart-dd'), {
      type: 'line',
      data: { labels, datasets: [{ ...lineDS(d2, '#60a5fa'), label: '200%', spanGaps: true }, { ...lineDS(d3, '#2dd4bf'), label: '300%', spanGaps: true }] },
      options: cOpts({ plugins: { legend: { display: true, labels: { font: { size: 11 }, color: '#7a8aaa' } } } })
    });
  }
}

// ── Render All ─────────────────────────────────────────────────────────────
function renderAll() {
  buildDates();
  renderDashboard();
  renderAllTrades();
  renderStratPage('200');
  renderStratPage('300');
}

// ── Page switching ─────────────────────────────────────────────────────────
window.switchPage = function(name) {
  const titles = { dashboard:'Dashboard', all:'All Trades', s200:'200% Strategy', s300:'300% Strategy', charts:'Analytics' };
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-link,.bn').forEach(el => el.classList.toggle('active', el.dataset.page === name));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');
  const tt = document.getElementById('topbar-title');
  if (tt) tt.textContent = titles[name] || '';
  if (name === 'charts') setTimeout(renderCharts, 80);
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mob-sb-overlay').classList.remove('show');
};

// ── Filters ────────────────────────────────────────────────────────────────
window.setFilter = function(key, val) {
  if (key === 'strat') { fStrat = fStrat === val ? '' : val; document.querySelectorAll('[data-key="strat"]').forEach(b => b.classList.toggle('active', b.dataset.val === fStrat)); }
  if (key === 'result') { fResult = fResult === val ? '' : val; document.querySelectorAll('[data-key="result"]').forEach(b => b.classList.toggle('active', b.dataset.val === fResult)); }
  renderAllTrades();
};

window.clearFilters = function() {
  fStrat = ''; fResult = '';
  ['fil-symbol', 'fil-from', 'fil-to'].forEach(id => document.getElementById(id).value = '');
  document.querySelectorAll('[data-key]').forEach(b => b.classList.toggle('active', b.dataset.val === ''));
  renderAllTrades();
};

// ── Sort ───────────────────────────────────────────────────────────────────
window.sortBy = function(key) {
  if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
  ['date', 'pnl', 'net', 'lots'].forEach(k => { const el = document.getElementById('th-' + k); if (el) el.className = k === sortKey ? 'sortable ' + (sortDir === 1 ? 's-asc' : 's-desc') : 'sortable'; });
  renderAllTrades();
};

// ── Add / Delete ───────────────────────────────────────────────────────────
window.addTrade = async function() {
  const date = document.getElementById('f-date').value;
  const strat = document.getElementById('f-strat').value;
  const symbol = document.getElementById('f-symbol').value;
  const lots = parseFloat(document.getElementById('f-lots').value);
  const pnl = parseFloat(document.getElementById('f-pnl').value);
  const tax = parseFloat(document.getElementById('f-tax').value) || 0;
  const notes = document.getElementById('f-notes').value.trim();

  if (!date) { showToast('Enter a date'); return; }
  if (!lots || lots <= 0) { showToast('Enter valid lots'); return; }
  if (isNaN(pnl)) { showToast('Enter P&L'); return; }

  setSync('loading');
  try {
    await addDoc(collection(db, 'trades'), { date, strat, symbol, lots, pnl, tax, notes });
    closeSheet(); clearForm();
    showToast('Trade added ✓');
  } catch (e) { setSync('error'); showToast('Error — check connection'); console.error(e); }
};

window.deleteTrade = async function(id) {
  if (!confirm('Delete this trade?')) return;
  setSync('loading');
  try { await deleteDoc(doc(db, 'trades', id)); showToast('Trade removed'); }
  catch (e) { setSync('error'); showToast('Error deleting trade'); }
};

window.clearAllTrades = async function() {
  if (!trades.length) return;
  if (!confirm('Delete ALL ' + trades.length + ' trades? This cannot be undone.')) return;
  setSync('loading');
  try { await Promise.all(trades.map(t => deleteDoc(doc(db, 'trades', t.id)))); showToast('All trades cleared'); }
  catch (e) { setSync('error'); showToast('Error'); }
};

window.clearForm = function() { ['f-lots', 'f-pnl', 'f-tax', 'f-notes'].forEach(id => document.getElementById(id).value = ''); };

// ── Threshold ──────────────────────────────────────────────────────────────
window.applyThreshold = async function() {
  const v = parseFloat(document.getElementById('dd-threshold').value);
  if (!v || v < 1) { showToast('Invalid threshold'); return; }
  threshold = v;
  document.getElementById('threshold-display').textContent = v.toLocaleString('en-IN');
  try { await setDoc(doc(db, 'settings', 'threshold'), { value: v }); showToast('Threshold → ₹' + v.toLocaleString('en-IN')); renderAll(); }
  catch (e) { showToast('Error saving'); }
};

// ── Sheet / Sidebar ────────────────────────────────────────────────────────
window.openSheet = function() { document.getElementById('sheet').classList.add('open'); document.getElementById('overlay').classList.add('show'); };
window.closeSheet = function() { document.getElementById('sheet').classList.remove('open'); document.getElementById('overlay').classList.remove('show'); };
window.toggleSidebar = function() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('mob-sb-overlay').classList.toggle('show'); };

// ── CSV ────────────────────────────────────────────────────────────────────
window.exportCSV = function() {
  if (!trades.length) { showToast('No trades'); return; }
  const { m2, m3 } = getDDMaps();
  const rows = [['#', 'Date', 'Strategy', 'Symbol', 'Lots', 'Gross P&L', 'Taxes', 'Net P&L', 'Drawdown', 'DD/Lot', 'Delta Alert', 'Notes']];
  trades.forEach((t, i) => { const d = t.strat === '200' ? m2[t.id] : m3[t.id]; rows.push([i + 1, t.date, t.strat + '%', t.symbol || '', t.lots, t.pnl, t.tax, t.pnl - t.tax, d ? d.dd : 0, d ? d.ddpl : 0, (d && isAlert(d)) ? 'YES' : 'NO', t.notes || '']); });
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'tradejournal_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click(); showToast('CSV exported');
};

// ── Toast ──────────────────────────────────────────────────────────────────
let toastT;
window.showToast = function(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2500);
};

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
boot();
