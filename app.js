import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── PASTE YOUR FIREBASE CONFIG HERE ───────────────────────────────────────
import { firebaseConfig } from './firebase-config.js';
// ───────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── State ──────────────────────────────────────────────────────────────────
let trades    = [];
let threshold = 1000;
let sortKey   = 'date';
let sortDir   = 1;
let charts    = {};
let filterStrat  = '';
let filterResult = '';

// ── Firebase init ──────────────────────────────────────────────────────────
function initFirebase() {
  setSyncState('syncing');

  // Load threshold
  getDoc(doc(db, 'settings', 'threshold')).then(d => {
    if (d.exists()) threshold = d.data().value ?? 1000;
    document.getElementById('dd-threshold').value = threshold;
    document.getElementById('threshold-display').textContent = threshold.toLocaleString('en-IN');
  });

  // Live trades listener
  const q = query(collection(db, 'trades'), orderBy('date'));
  onSnapshot(q, snap => {
    trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSyncState('synced');
    hideSplash();
    renderAll();
  }, err => {
    console.error(err);
    setSyncState('error');
    hideSplash();
  });
}

function setSyncState(state) {
  const el = document.getElementById('sync-indicator');
  el.className = 'sync-dot ' + state;
}

let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  document.getElementById('splash').classList.add('out');
  document.getElementById('app').classList.remove('hidden');
  setTimeout(() => document.getElementById('splash').remove(), 500);
}

// ── Formatters ─────────────────────────────────────────────────────────────
function inr(n) {
  return '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}
function sig(n) { return (n >= 0 ? '+' : '−') + inr(Math.abs(n)); }
function pc(n)  { return n > 0 ? 'pnl-pos' : n < 0 ? 'pnl-neg' : 'pnl-zero'; }

// ── DD Engine (both strategies — identical: peak-based, never resets) ──────
function computeDD(arr) {
  let run = 0, peak = 0, wasInDD = false;
  return arr.map(t => {
    const net = t.pnl - t.tax;
    run += net;
    if (run > peak) peak = run;
    const dd = Math.min(0, run - peak);
    const normalize = wasInDD && dd === 0;
    wasInDD = dd < 0;
    const ddpl = dd < 0 && t.lots > 0 ? dd / t.lots : 0;
    return { run, peak, dd, ddpl, normalize };
  });
}

function isAlert(d) { return d && d.dd < 0 && d.ddpl <= -threshold; }

function getDDMaps() {
  const t2 = trades.filter(t => t.strat === '200').sort((a,b) => a.date.localeCompare(b.date));
  const t3 = trades.filter(t => t.strat === '300').sort((a,b) => a.date.localeCompare(b.date));
  const m2 = {}, m3 = {};
  computeDD(t2).forEach((d, i) => m2[t2[i].id] = d);
  computeDD(t3).forEach((d, i) => m3[t3[i].id] = d);
  return { m2, m3, t2, t3 };
}

// ── DD cell HTML ───────────────────────────────────────────────────────────
function ddCell(d) {
  if (!d) return `<span style="color:var(--text3)">—</span>`;
  if (d.normalize) return `<span class="delta-pill-green">↓ normalize delta</span>`;
  if (d.dd >= 0)   return `<span style="color:var(--text3)">—</span>`;
  const abs = Math.abs(d.ddpl);
  const pct = Math.min(100, abs / threshold * 100);
  const col = pct >= 100 ? 'var(--red)' : pct >= 70 ? '#f97316' : pct >= 40 ? 'var(--amber)' : 'var(--green)';
  return `<div class="dd-wrap">
    <div class="dd-amount">
      <span class="pnl-neg">−${inr(abs)}</span>
      ${isAlert(d) ? `<span class="delta-pill">↑ delta</span>` : ''}
    </div>
    <div class="dd-bar-track">
      <div class="dd-bar-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div>
    </div>
  </div>`;
}

function empty(cols) {
  return `<tr><td colspan="${cols}"><div class="empty-state">No trades yet — tap + to add one</div></td></tr>`;
}

// ── Render Stats Bar ───────────────────────────────────────────────────────
function renderStatsBar() {
  const tg = trades.reduce((s, t) => s + t.pnl, 0);
  const tx = trades.reduce((s, t) => s + t.tax, 0);
  const { m2, m3, t2, t3 } = getDDMaps();
  const maxDD2 = t2.length ? Math.min(...t2.map(t => m2[t.id].dd)) : 0;
  const maxDD3 = t3.length ? Math.min(...t3.map(t => m3[t.id].dd)) : 0;

  document.getElementById('stats-bar').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-value ${pc(tg-tx)}">${sig(tg-tx)}</div>
      <div class="stat-sub">Gross ${sig(tg)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Taxes</div>
      <div class="stat-value val-neutral">${inr(tx)}</div>
      <div class="stat-sub">${trades.length} trade${trades.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">200% Max DD</div>
      <div class="stat-value ${maxDD2 < 0 ? 'val-neg' : 'val-neutral'}">${maxDD2 < 0 ? '−' + inr(Math.abs(maxDD2)) : '—'}</div>
      <div class="stat-sub">Peak-based</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">300% Max DD</div>
      <div class="stat-value ${maxDD3 < 0 ? 'val-neg' : 'val-neutral'}">${maxDD3 < 0 ? '−' + inr(Math.abs(maxDD3)) : '—'}</div>
      <div class="stat-sub">Peak-based</div>
    </div>
  `;
}

// ── Render All Trades ──────────────────────────────────────────────────────
function buildDates() {
  const dates = [...new Set(trades.map(t => t.date))].sort();
  const fv = document.getElementById('fil-from').value;
  const tv = document.getElementById('fil-to').value;
  document.getElementById('fil-from').innerHTML = '<option value="">From…</option>' + dates.map(d => `<option${d === fv ? ' selected' : ''}>${d}</option>`).join('');
  document.getElementById('fil-to').innerHTML   = '<option value="">To…</option>'   + dates.map(d => `<option${d === tv ? ' selected' : ''}>${d}</option>`).join('');
}

function renderAllTrades() {
  const fy = document.getElementById('fil-symbol').value;
  const ff = document.getElementById('fil-from').value;
  const ft = document.getElementById('fil-to').value;
  const { m2, m3 } = getDDMaps();
  const ddOf = t => t.strat === '200' ? m2[t.id] : m3[t.id];

  let list = trades.filter(t => {
    if (filterStrat && t.strat !== filterStrat) return false;
    if (fy && t.symbol !== fy) return false;
    if (ff && t.date < ff) return false;
    if (ft && t.date > ft) return false;
    const d = ddOf(t);
    if (filterResult === 'loss'   && t.pnl >= 0) return false;
    if (filterResult === 'profit' && t.pnl <= 0) return false;
    if (filterResult === 'alert'  && !isAlert(d)) return false;
    return true;
  });

  list = [...list].sort((a, b) => {
    const kv = t => ({ date: t.date, pnl: t.pnl, net: t.pnl - t.tax, lots: t.lots, tax: t.tax }[sortKey] ?? 0);
    const av = kv(a), bv = kv(b);
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });

  const active = [filterStrat, fy, filterResult, ff, ft].filter(Boolean).length;
  document.getElementById('filter-status').textContent = active ? `${list.length} of ${trades.length}` : '';

  const tbody = document.getElementById('all-tbody');
  if (!list.length) { tbody.innerHTML = empty(12); renderSymbolTable(); return; }

  tbody.innerHTML = list.map((t, i) => {
    const d = ddOf(t), net = t.pnl - t.tax, al = isAlert(d);
    return `<tr class="${al ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="color:var(--text3);text-align:center">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="badge b${t.strat}">${t.strat}%</span></td>
      <td><span class="sym-tag">${t.symbol || '—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono" style="color:var(--text2)">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d ? d.dd : 0)}">${d && d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d)}</td>
      <td class="notes-cell" title="${t.notes || ''}">${t.notes || '—'}</td>
      <td><button class="del-btn" onclick="deleteTrade('${t.id}')">×</button></td>
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
  document.getElementById('sym-count').textContent = `${rows.length} symbol${rows.length !== 1 ? 's' : ''}`;
  if (!rows.length) { document.getElementById('symbol-tbody').innerHTML = empty(8); return; }
  document.getElementById('symbol-tbody').innerHTML = rows.map(([sym, s]) => {
    const net = s.g - s.tx, wr = s.n > 0 ? Math.round(s.w / s.n * 100) : 0;
    return `<tr class="${net < 0 ? 'tr-loss' : ''}">
      <td><span class="sym-tag">${sym}</span></td>
      <td class="mono">${s.n}</td>
      <td class="${pc(s.g)}">${sig(s.g)}</td>
      <td class="mono" style="color:var(--text2)">${inr(s.tx)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="mono" style="color:var(--green)">${s.w}</td>
      <td class="mono" style="color:var(--red)">${s.l}</td>
      <td>
        <div class="wr-wrap">
          <span class="mono ${wr >= 50 ? 'pnl-pos' : 'pnl-neg'}">${wr}%</span>
          <div class="wr-bar"><div class="wr-fill" style="width:${wr}%;background:${wr >= 50 ? 'var(--green)' : 'var(--red)'}"></div></div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Strategy pages ─────────────────────────────────────────────────────────
function renderStratPage(strat) {
  const arr = trades.filter(t => t.strat === strat).sort((a, b) => a.date.localeCompare(b.date));
  const dds = computeDD(arr);
  const tn  = arr.reduce((s, t) => s + t.pnl - t.tax, 0);
  const tx  = arr.reduce((s, t) => s + t.tax, 0);
  const mdd = dds.length ? Math.min(...dds.map(d => d.dd)) : 0;
  const al  = dds.filter(d => isAlert(d)).length;
  const isBlue = strat === '200';

  document.getElementById(`strat${strat}-stats`).innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Net P&amp;L</div>
      <div class="stat-value ${pc(tn)}">${sig(tn)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Taxes</div>
      <div class="stat-value val-neutral">${inr(tx)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Max Drawdown</div>
      <div class="stat-value ${mdd < 0 ? 'val-neg' : 'val-neutral'}">${mdd < 0 ? '−' + inr(Math.abs(mdd)) : '—'}</div>
      <div class="stat-sub">From peak</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Delta Alerts</div>
      <div class="stat-value ${al > 0 ? 'val-warn' : 'val-neutral'}">×${al}</div>
      <div class="stat-sub">${arr.length} trades</div>
    </div>
  `;

  const tb = document.getElementById(`strat${strat}-tbody`);
  if (!arr.length) { tb.innerHTML = empty(12); return; }

  tb.innerHTML = arr.map((t, i) => {
    const d = dds[i], net = t.pnl - t.tax;
    return `<tr class="${isAlert(d) ? 'tr-alert' : t.pnl < 0 ? 'tr-loss' : ''}">
      <td class="mono" style="color:var(--text3);text-align:center">${i + 1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="sym-tag">${t.symbol || '—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono" style="color:var(--text2)">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d.run)}">${sig(d.run)}</td>
      <td class="mono">${inr(d.peak)}</td>
      <td class="${pc(d.dd)}">${d.dd < 0 ? '−' + inr(Math.abs(d.dd)) : '—'}</td>
      <td>${ddCell(d)}</td>
      <td class="notes-cell" title="${t.notes || ''}">${t.notes || '—'}</td>
    </tr>`;
  }).join('');
}

// ── Charts ─────────────────────────────────────────────────────────────────
function killChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

const cOpts = {
  plugins: {
    legend: { display: false },
    tooltip: { callbacks: { label: c => ' ₹' + c.parsed.y?.toLocaleString('en-IN') } }
  },
  scales: {
    x: { grid: { color: '#2a2a2a', lineWidth: .5 }, ticks: { font: { size: 10, family: "'JetBrains Mono',monospace" }, color: '#555', maxTicksLimit: 7 } },
    y: { grid: { color: '#2a2a2a', lineWidth: .5 }, ticks: { font: { size: 10, family: "'JetBrains Mono',monospace" }, color: '#555', callback: v => '₹' + v.toLocaleString('en-IN') } }
  },
  animation: { duration: 400 },
  responsive: true,
  maintainAspectRatio: false,
};

function lineDS(data, color) {
  return { data, borderColor: color, backgroundColor: color + '18', fill: true, pointRadius: 3, pointBackgroundColor: color, tension: .35, borderWidth: 2 };
}

function renderCharts() {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const t2 = sorted.filter(t => t.strat === '200');
  const t3 = sorted.filter(t => t.strat === '300');

  // Combined
  killChart('c');
  if (sorted.length) {
    let cum = 0;
    const labels = [], data = [];
    sorted.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#22c55e' : '#ef4444';
    charts['c'] = new Chart(document.getElementById('chart-combined'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: { ...cOpts } });
  }

  // 200%
  killChart('2');
  if (t2.length) {
    let cum = 0; const labels = [], data = [];
    t2.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#22c55e' : '#ef4444';
    charts['2'] = new Chart(document.getElementById('chart-200'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: { ...cOpts } });
  }

  // 300%
  killChart('3');
  if (t3.length) {
    let cum = 0; const labels = [], data = [];
    t3.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length - 1] >= 0 ? '#22c55e' : '#ef4444';
    charts['3'] = new Chart(document.getElementById('chart-300'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: { ...cOpts } });
  }

  // Symbol bar
  killChart('s');
  const smap = {};
  trades.forEach(t => { const s = t.symbol || 'OTHER'; smap[s] = (smap[s] || 0) + (t.pnl - t.tax); });
  const se = Object.entries(smap).sort((a, b) => a[1] - b[1]);
  if (se.length) {
    charts['s'] = new Chart(document.getElementById('chart-symbol'), {
      type: 'bar',
      data: { labels: se.map(e => e[0]), datasets: [{ data: se.map(e => e[1]), backgroundColor: se.map(e => e[1] >= 0 ? '#22c55e28' : '#ef444428'), borderColor: se.map(e => e[1] >= 0 ? '#22c55e' : '#ef4444'), borderWidth: 1.5, borderRadius: 4 }] },
      options: { ...cOpts }
    });
  }

  // DD timeline
  killChart('d');
  if (sorted.length) {
    const { m2, m3 } = getDDMaps();
    const labels = [], d2 = [], d3 = [];
    sorted.forEach(t => {
      labels.push(t.date);
      if (t.strat === '200') { d2.push(m2[t.id]?.dd ?? 0); d3.push(null); }
      else { d3.push(m3[t.id]?.dd ?? 0); d2.push(null); }
    });
    charts['d'] = new Chart(document.getElementById('chart-dd'), {
      type: 'line',
      data: { labels, datasets: [{ ...lineDS(d2, '#3b82f6'), label: '200%', spanGaps: true }, { ...lineDS(d3, '#14b8a6'), label: '300%', spanGaps: true }] },
      options: { ...cOpts, plugins: { legend: { display: true, labels: { font: { size: 11 }, color: '#888' } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ₹${c.parsed.y?.toLocaleString('en-IN') || '—'}` } } } }
    });
  }
}

// ── Render all ─────────────────────────────────────────────────────────────
function renderAll() {
  buildDates();
  renderStatsBar();
  renderAllTrades();
  renderStratPage('200');
  renderStratPage('300');
}

// ── Filters ────────────────────────────────────────────────────────────────
window.setChip = function(btn, key, val) {
  if (key === 'strat') {
    filterStrat = filterStrat === val ? '' : val;
    document.querySelectorAll('[data-key="strat"]').forEach(b => b.classList.toggle('active', b.dataset.val === filterStrat));
  } else if (key === 'result') {
    filterResult = filterResult === val ? '' : val;
    document.querySelectorAll('[data-key="result"]').forEach(b => b.classList.toggle('active', b.dataset.val === filterResult));
  }
  renderAllTrades();
};

window.clearFilters = function() {
  filterStrat = ''; filterResult = '';
  document.getElementById('fil-symbol').value = '';
  document.getElementById('fil-from').value   = '';
  document.getElementById('fil-to').value     = '';
  document.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.val === ''));
  renderAllTrades();
};

// ── Sort ───────────────────────────────────────────────────────────────────
window.sortBy = function(key) {
  if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
  ['date','pnl','net','lots'].forEach(k => {
    const el = document.getElementById(`th-${k}`);
    if (el) el.className = k === sortKey ? (sortDir === 1 ? 's-asc' : 's-desc') : '';
  });
  renderAllTrades();
};

// ── Add Trade ──────────────────────────────────────────────────────────────
window.addTrade = async function() {
  const date   = document.getElementById('f-date').value;
  const strat  = document.getElementById('f-strat').value;
  const symbol = document.getElementById('f-symbol').value;
  const lots   = parseFloat(document.getElementById('f-lots').value);
  const pnl    = parseFloat(document.getElementById('f-pnl').value);
  const tax    = parseFloat(document.getElementById('f-tax').value) || 0;
  const notes  = document.getElementById('f-notes').value.trim();

  if (!date)              { showToast('Enter a date'); return; }
  if (!lots || lots <= 0) { showToast('Enter valid lots'); return; }
  if (isNaN(pnl))         { showToast('Enter P&L'); return; }

  setSyncState('syncing');
  try {
    await addDoc(collection(db, 'trades'), { date, strat, symbol, lots, pnl, tax, notes });
    closeSheet();
    clearForm();
    showToast('Trade added ✓');
  } catch (e) {
    setSyncState('error');
    showToast('Error — check connection');
    console.error(e);
  }
};

window.deleteTrade = async function(id) {
  if (!confirm('Delete this trade?')) return;
  setSyncState('syncing');
  try {
    await deleteDoc(doc(db, 'trades', id));
    showToast('Trade removed');
  } catch (e) {
    setSyncState('error');
    showToast('Error deleting trade');
  }
};

window.clearAllTrades = async function() {
  if (!trades.length) return;
  if (!confirm(`Delete all ${trades.length} trades? Cannot be undone.`)) return;
  setSyncState('syncing');
  try {
    await Promise.all(trades.map(t => deleteDoc(doc(db, 'trades', t.id))));
    showToast('All cleared');
  } catch (e) {
    setSyncState('error');
    showToast('Error clearing trades');
  }
};

window.clearForm = function() {
  ['f-lots', 'f-pnl', 'f-tax', 'f-notes'].forEach(id => document.getElementById(id).value = '');
};

// ── Threshold ──────────────────────────────────────────────────────────────
window.applyThreshold = async function() {
  const v = parseFloat(document.getElementById('dd-threshold').value);
  if (!v || v < 1) { showToast('Invalid threshold'); return; }
  threshold = v;
  document.getElementById('threshold-display').textContent = v.toLocaleString('en-IN');
  try {
    await setDoc(doc(db, 'settings', 'threshold'), { value: v });
    showToast('Threshold → ₹' + v.toLocaleString('en-IN'));
    renderAll();
  } catch (e) {
    showToast('Error saving threshold');
  }
};

// ── Page switching ─────────────────────────────────────────────────────────
window.switchPage = function(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link,.bnav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === name);
  });
  document.getElementById('page-' + name).classList.add('active');
  if (name === 'charts') setTimeout(renderCharts, 80);
};

// ── Sheet ──────────────────────────────────────────────────────────────────
window.openSheet = function() {
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheet-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
};

window.closeSheet = function() {
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('sheet-overlay').classList.remove('show');
  document.body.style.overflow = '';
};

// ── CSV Export ─────────────────────────────────────────────────────────────
window.exportCSV = function() {
  if (!trades.length) { showToast('No trades to export'); return; }
  const { m2, m3 } = getDDMaps();
  const rows = [['#','Date','Strategy','Symbol','Lots','Gross P&L','Taxes','Net P&L','Drawdown','DD/Lot','Delta Alert','Notes']];
  trades.forEach((t, i) => {
    const d = t.strat === '200' ? m2[t.id] : m3[t.id];
    rows.push([i+1, t.date, t.strat+'%', t.symbol||'', t.lots, t.pnl, t.tax, t.pnl-t.tax, d?d.dd:0, d?d.ddpl:0, (d&&isAlert(d))?'YES':'NO', t.notes||'']);
  });
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'trade_journal_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  showToast('CSV exported');
};

// ── Toast ──────────────────────────────────────────────────────────────────
let toastT;
window.showToast = function(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2400);
};

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
initFirebase();
