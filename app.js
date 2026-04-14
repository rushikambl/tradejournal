import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot, query, orderBy, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ── State ──────────────────────────────────────────────────────────────────
let trades = [], threshold = 1000, sortKey = 'date', sortDir = 1;
let fStrat = '', fResult = '';
let charts = {};
let appReady = false;

// ── Boot ───────────────────────────────────────────────────────────────────
function boot() {
  setSyncState('syncing');

  getDoc(doc(db, 'settings', 'threshold')).then(d => {
    if (d.exists()) threshold = d.data().value ?? 1000;
    document.getElementById('dd-threshold').value = threshold;
    document.getElementById('threshold-display').textContent = fmt(threshold);
  }).catch(() => {});

  onSnapshot(
    query(collection(db, 'trades'), orderBy('date')),
    snap => {
      trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setSyncState('live');
      if (!appReady) { appReady = true; showApp(); }
      renderAll();
    },
    err => {
      console.error(err);
      setSyncState('error');
      if (!appReady) { appReady = true; showApp(); }
    }
  );
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

// ── DD Engine ──────────────────────────────────────────────────────────────
function computeDD(arr) {
  let run = 0, peak = 0, wasDD = false;
  return arr.map(t => {
    run += t.pnl - t.tax;
    if (run > peak) peak = run;
    const dd = Math.min(0, run - peak);
    const normalize = wasDD && dd === 0;
    wasDD = dd < 0;
    const ddpl = dd < 0 && t.lots > 0 ? dd / t.lots : 0;
    return { run, peak, dd, ddpl, normalize };
  });
}
function isAlert(d) { return d && d.dd < 0 && d.ddpl <= -threshold; }

function getDDMaps() {
  const t2 = trades.filter(t => t.strat === '200').sort((a,b) => a.date.localeCompare(b.date));
  const t3 = trades.filter(t => t.strat === '300').sort((a,b) => a.date.localeCompare(b.date));
  const m2 = {}, m3 = {};
  computeDD(t2).forEach((d,i) => m2[t2[i].id] = d);
  computeDD(t3).forEach((d,i) => m3[t3[i].id] = d);
  return { m2, m3, t2, t3 };
}

function ddCell(d) {
  if (!d) return `<span style="color:var(--text3)">—</span>`;
  if (d.normalize) return `<span class="tag-norm">↓ normalize delta</span>`;
  if (d.dd >= 0) return `<span style="color:var(--text3)">—</span>`;
  const abs = Math.abs(d.ddpl);
  const pct = Math.min(100, abs / threshold * 100);
  const col = pct >= 100 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : pct >= 40 ? 'var(--amber)' : 'var(--green)';
  return `<div class="dd-wrap">
    <div class="dd-inner">
      <span class="val-neg">−${inr(abs)}</span>
      ${isAlert(d) ? `<span class="tag-delta">↑ delta</span>` : ''}
    </div>
    <div class="dd-bar"><div class="dd-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
  </div>`;
}

function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="empty-cell">No trades yet — tap Add Trade to begin</td></tr>`;
}

// ── KPI renderer ───────────────────────────────────────────────────────────
function renderKPIs(elId, items) {
  document.getElementById(elId).innerHTML = items.map(k =>
    `<div class="kpi ${k.cls}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${k.valCls}">${k.value}</div>
      ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''}
    </div>`
  ).join('');
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const { m2, m3, t2, t3 } = getDDMaps();
  const gross = trades.reduce((s,t) => s + t.pnl, 0);
  const tx = trades.reduce((s,t) => s + t.tax, 0);
  const net = gross - tx;
  const mdd2 = t2.length ? Math.min(...t2.map(t => m2[t.id].dd)) : 0;
  const mdd3 = t3.length ? Math.min(...t3.map(t => m3[t.id].dd)) : 0;

  // Hero title
  document.getElementById('dash-hero').textContent = (net >= 0 ? '+' : '−') + inr(Math.abs(net));

  renderKPIs('kpi-dash', [
    { label: 'Net P&L', value: sig(net), valCls: net >= 0 ? 'kpi-pos' : 'kpi-neg', sub: 'Gross ' + sig(gross), cls: net >= 0 ? 'k-green' : 'k-red' },
    { label: 'Total Taxes', value: inr(tx), valCls: 'kpi-neu', sub: trades.length + ' trade' + (trades.length !== 1 ? 's' : ''), cls: 'k-neutral' },
    { label: '200% Max DD', value: mdd2 < 0 ? '−' + inr(Math.abs(mdd2)) : '—', valCls: mdd2 < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'Peak-based', cls: mdd2 < 0 ? 'k-red' : 'k-neutral' },
    { label: '300% Max DD', value: mdd3 < 0 ? '−' + inr(Math.abs(mdd3)) : '—', valCls: mdd3 < 0 ? 'kpi-neg' : 'kpi-neu', sub: 'Peak-based', cls: mdd3 < 0 ? 'k-red' : 'k-neutral' },
  ]);

  // Recent trades
  const recent = [...trades].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 6);
  document.getElementById('recent-tag').textContent = recent.length + ' of ' + trades.length;
  document.getElementById('recent-list').innerHTML = recent.length
    ? recent.map(t => {
        const n = t.pnl - t.tax;
        return `<div class="recent-item">
          <div class="ri-badge ri-${t.strat}">${t.strat}%</div>
          <div class="ri-info">
            <div class="ri-sym">${t.symbol || '—'}</div>
            <div class="ri-date">${t.date} · ${t.lots} lots</div>
          </div>
          <div class="ri-pnl ${pc(n)}">${sig(n)}</div>
        </div>`;
      }).join('')
    : `<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">No trades yet</div>`;

  // Charts
  const sorted = [...trades].sort((a,b) => a.date.localeCompare(b.date));
  killChart('dm');
  if (sorted.length) {
    let cum = 0;
    const labels = [], data = [];
    sorted.forEach(t => { cum += t.pnl - t.tax; labels.push(t.date); data.push(cum); });
    const col = data[data.length-1] >= 0 ? '#16a34a' : '#dc2626';
    charts['dm'] = new Chart(document.getElementById('ch-dash'), { type: 'line', data: { labels, datasets: [lineDS(data, col)] }, options: chartOpts() });
  }

  killChart('ds');
  const smap = {};
  trades.forEach(t => { const s = t.symbol || 'OTHER'; smap[s] = (smap[s]||0) + (t.pnl-t.tax); });
  const se = Object.entries(smap).sort((a,b) => a[1]-b[1]);
  if (se.length) {
    charts['ds'] = new Chart(document.getElementById('ch-sym-dash'), {
      type: 'bar',
      data: { labels: se.map(e => e[0]), datasets: [{ data: se.map(e => e[1]), backgroundColor: se.map(e => e[1] >= 0 ? 'rgba(22,163,74,.15)' : 'rgba(220,38,38,.15)'), borderColor: se.map(e => e[1] >= 0 ? '#16a34a' : '#dc2626'), borderWidth: 1.5, borderRadius: 6 }] },
      options: chartOpts()
    });
  }
}

// ── All Trades ─────────────────────────────────────────────────────────────
function buildDates() {
  const dates = [...new Set(trades.map(t => t.date))].sort();
  ['fil-from','fil-to'].forEach(id => {
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = `<option value="">${id==='fil-from'?'From…':'To…'}</option>` + dates.map(d => `<option${d===cur?' selected':''}>${d}</option>`).join('');
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
  }).sort((a,b) => {
    const kv = t => ({date:t.date,pnl:t.pnl,net:t.pnl-t.tax,lots:t.lots}[sortKey] ?? 0);
    const av=kv(a), bv=kv(b);
    return av<bv?-sortDir:av>bv?sortDir:0;
  });

  document.getElementById('all-sub').textContent = `${list.length} of ${trades.length} trades`;
  const tb = document.getElementById('tbody-all');
  if (!list.length) { tb.innerHTML = emptyRow(12); renderSymTable(); return; }

  tb.innerHTML = list.map((t,i) => {
    const d = ddOf(t), net = t.pnl - t.tax, al = isAlert(d);
    return `<tr class="${al?'tr-alert':t.pnl<0?'tr-loss':''}">
      <td class="mono" style="text-align:center;color:var(--text3)">${i+1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="strat-tag st-${t.strat}">${t.strat}%</span></td>
      <td><span class="sym-tag">${t.symbol||'—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d?d.dd:0)}">${d&&d.dd<0?'−'+inr(Math.abs(d.dd)):'—'}</td>
      <td>${ddCell(d)}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3);font-size:12px" title="${t.notes||''}">${t.notes||'—'}</td>
      <td><button class="del-btn" onclick="deleteTrade('${t.id}')">×</button></td>
    </tr>`;
  }).join('');
  renderSymTable();
}

function renderSymTable() {
  const map = {};
  trades.forEach(t => {
    const s = t.symbol||'OTHER';
    if (!map[s]) map[s] = {n:0,g:0,tx:0,w:0,l:0};
    map[s].n++; map[s].g+=t.pnl; map[s].tx+=t.tax;
    t.pnl>=0?map[s].w++:map[s].l++;
  });
  const rows = Object.entries(map).sort((a,b)=>a[1].g-b[1].g);
  document.getElementById('sym-count').textContent = rows.length + ' symbol' + (rows.length!==1?'s':'');
  if (!rows.length) { document.getElementById('tbody-sym').innerHTML = emptyRow(8); return; }
  document.getElementById('tbody-sym').innerHTML = rows.map(([sym,s]) => {
    const net=s.g-s.tx, wr=s.n>0?Math.round(s.w/s.n*100):0;
    return `<tr class="${net<0?'tr-loss':''}">
      <td><span class="sym-tag">${sym}</span></td>
      <td class="mono">${s.n}</td>
      <td class="${pc(s.g)}">${sig(s.g)}</td>
      <td class="mono">${inr(s.tx)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="mono" style="color:var(--green)">${s.w}</td>
      <td class="mono" style="color:var(--red)">${s.l}</td>
      <td><div class="wr-row"><span class="mono ${wr>=50?'val-pos':'val-neg'}">${wr}%</span><div class="wr-bar"><div class="wr-fill" style="width:${wr}%;background:${wr>=50?'var(--green)':'var(--red)'}"></div></div></div></td>
    </tr>`;
  }).join('');
}

// ── Strategy pages ─────────────────────────────────────────────────────────
function renderStrat(strat) {
  const arr = trades.filter(t => t.strat === strat).sort((a,b) => a.date.localeCompare(b.date));
  const dds = computeDD(arr);
  const tn = arr.reduce((s,t) => s+t.pnl-t.tax, 0);
  const tx = arr.reduce((s,t) => s+t.tax, 0);
  const mdd = dds.length ? Math.min(...dds.map(d=>d.dd)) : 0;
  const al = dds.filter(d=>isAlert(d)).length;

  renderKPIs('kpi-' + strat, [
    { label:'Net P&L', value:sig(tn), valCls:tn>=0?'kpi-pos':'kpi-neg', sub:arr.length+' trades', cls:tn>=0?'k-green':'k-red' },
    { label:'Total Taxes', value:inr(tx), valCls:'kpi-neu', cls:'k-neutral' },
    { label:'Max Drawdown', value:mdd<0?'−'+inr(Math.abs(mdd)):'—', valCls:mdd<0?'kpi-neg':'kpi-neu', sub:'From all-time peak', cls:mdd<0?'k-red':'k-neutral' },
    { label:'Delta Alerts', value:'×'+al, valCls:al>0?'kpi-warn':'kpi-neu', sub:'≥ '+inr(threshold)+'/lot', cls:al>0?'k-amber':'k-neutral' },
  ]);

  const tb = document.getElementById('tbody-' + strat);
  if (!arr.length) { tb.innerHTML = emptyRow(12); return; }
  tb.innerHTML = arr.map((t,i) => {
    const d=dds[i], net=t.pnl-t.tax;
    return `<tr class="${isAlert(d)?'tr-alert':t.pnl<0?'tr-loss':''}">
      <td class="mono" style="text-align:center;color:var(--text3)">${i+1}</td>
      <td class="mono">${t.date}</td>
      <td><span class="sym-tag">${t.symbol||'—'}</span></td>
      <td class="mono">${t.lots}</td>
      <td class="${pc(t.pnl)}">${sig(t.pnl)}</td>
      <td class="mono">${inr(t.tax)}</td>
      <td class="${pc(net)}">${sig(net)}</td>
      <td class="${pc(d.run)}">${sig(d.run)}</td>
      <td class="mono">${inr(d.peak)}</td>
      <td class="${pc(d.dd)}">${d.dd<0?'−'+inr(Math.abs(d.dd)):'—'}</td>
      <td>${ddCell(d)}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3);font-size:12px">${t.notes||'—'}</td>
    </tr>`;
  }).join('');
}

// ── Charts ─────────────────────────────────────────────────────────────────
function killChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function chartOpts(extra={}) {
  return {
    plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>' ₹'+(c.parsed.y??0).toLocaleString('en-IN')}}, ...extra.plugins },
    scales:{
      x:{ grid:{color:'rgba(160,160,210,.12)',lineWidth:.5}, ticks:{font:{size:10,family:"'JetBrains Mono',monospace"},color:'#a3a3a3',maxTicksLimit:7} },
      y:{ grid:{color:'rgba(160,160,210,.12)',lineWidth:.5}, ticks:{font:{size:10,family:"'JetBrains Mono',monospace"},color:'#a3a3a3',callback:v=>'₹'+v.toLocaleString('en-IN')} }
    },
    animation:{duration:400}, responsive:true, maintainAspectRatio:false, ...extra
  };
}

function lineDS(data, color) {
  return { data, borderColor:color, backgroundColor:color+'22', fill:true, pointRadius:3, pointBackgroundColor:color, pointBorderColor:'transparent', tension:.4, borderWidth:2.5 };
}

function renderCharts() {
  const sorted = [...trades].sort((a,b)=>a.date.localeCompare(b.date));
  const t2=sorted.filter(t=>t.strat==='200'), t3=sorted.filter(t=>t.strat==='300');

  const mkLine = (arr, canvasId, key) => {
    killChart(key);
    if (!arr.length) return;
    let cum=0; const labels=[], data=[];
    arr.forEach(t=>{cum+=t.pnl-t.tax;labels.push(t.date);data.push(cum);});
    const col = data[data.length-1]>=0?'#16a34a':'#dc2626';
    charts[key] = new Chart(document.getElementById(canvasId),{type:'line',data:{labels,datasets:[lineDS(data,col)]},options:chartOpts()});
  };

  mkLine(sorted,'ch-combined','cc');
  mkLine(t2,'ch-200','c2');
  mkLine(t3,'ch-300','c3');

  killChart('cs');
  const smap={};
  trades.forEach(t=>{const s=t.symbol||'OTHER';smap[s]=(smap[s]||0)+(t.pnl-t.tax);});
  const se=Object.entries(smap).sort((a,b)=>a[1]-b[1]);
  if (se.length) {
    charts['cs']=new Chart(document.getElementById('ch-sym'),{type:'bar',data:{labels:se.map(e=>e[0]),datasets:[{data:se.map(e=>e[1]),backgroundColor:se.map(e=>e[1]>=0?'rgba(22,163,74,.15)':'rgba(220,38,38,.15)'),borderColor:se.map(e=>e[1]>=0?'#16a34a':'#dc2626'),borderWidth:1.5,borderRadius:6}]},options:chartOpts()});
  }

  killChart('cd');
  if (sorted.length) {
    const {m2,m3}=getDDMaps();
    const labels=[],d2=[],d3=[];
    sorted.forEach(t=>{labels.push(t.date);if(t.strat==='200'){d2.push(m2[t.id]?.dd??0);d3.push(null);}else{d3.push(m3[t.id]?.dd??0);d2.push(null);}});
    charts['cd']=new Chart(document.getElementById('ch-dd'),{type:'line',data:{labels,datasets:[{...lineDS(d2,'#f97316'),label:'200%',spanGaps:true},{...lineDS(d3,'#737373'),label:'300%',spanGaps:true}]},options:chartOpts({plugins:{legend:{display:true,labels:{font:{size:11},color:'#a3a3a3'}}}})});
  }
}

// ── Render all ─────────────────────────────────────────────────────────────
function renderAll() {
  buildDates();
  renderDashboard();
  renderAllTrades();
  renderStrat('200');
  renderStrat('300');
}

// ── Navigation ─────────────────────────────────────────────────────────────
window.goPage = function(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item,.bnav').forEach(el => el.classList.toggle('active', el.dataset.page === name));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');
  if (name === 'charts') setTimeout(renderCharts, 80);
  closeDrawer();
};

// ── Drawer ─────────────────────────────────────────────────────────────────
window.openDrawer = function() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('drawer-bd').classList.add('show');
};
window.closeDrawer = function() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('drawer-bd').classList.remove('show');
};

// ── Modal (Add Trade) ──────────────────────────────────────────────────────
window.openModal = function() {
  document.getElementById('modal').classList.add('open');
  document.getElementById('modal-bd').classList.add('show');
};
window.closeModal = function() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modal-bd').classList.remove('show');
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

// ── Filters ────────────────────────────────────────────────────────────────
window.setF = function(key, val) {
  if (key === 'strat') { fStrat = fStrat===val?'':val; document.querySelectorAll('[data-key="strat"]').forEach(b=>b.classList.toggle('active',b.dataset.val===fStrat)); }
  if (key === 'result') { fResult = fResult===val?'':val; document.querySelectorAll('[data-key="result"]').forEach(b=>b.classList.toggle('active',b.dataset.val===fResult)); }
  renderAllTrades();
};
window.clearFilters = function() {
  fStrat=''; fResult='';
  ['fil-symbol','fil-from','fil-to'].forEach(id=>document.getElementById(id).value='');
  document.querySelectorAll('[data-key]').forEach(b=>b.classList.toggle('active',b.dataset.val===''));
  renderAllTrades();
};

// ── Sort ───────────────────────────────────────────────────────────────────
window.sortBy = function(key) {
  if (sortKey===key) sortDir*=-1; else {sortKey=key;sortDir=1;}
  ['date','pnl','net','lots'].forEach(k=>{const el=document.getElementById('th-'+k);if(el)el.className=k===sortKey?'sort '+(sortDir===1?'s-asc':'s-desc'):'sort';});
  renderAllTrades();
};

// ── Add trade ──────────────────────────────────────────────────────────────
window.addTrade = async function() {
  const date=document.getElementById('f-date').value;
  const strat=document.getElementById('f-strat').value;
  const symbol=document.getElementById('f-symbol').value;
  const lots=parseFloat(document.getElementById('f-lots').value);
  const pnl=parseFloat(document.getElementById('f-pnl').value);
  const tax=parseFloat(document.getElementById('f-tax').value)||0;
  const notes=document.getElementById('f-notes').value.trim();

  if (!date){showToast('Enter a date');return;}
  if (!lots||lots<=0){showToast('Enter valid lots');return;}
  if (isNaN(pnl)){showToast('Enter P&L');return;}

  setSyncState('syncing');
  try {
    await addDoc(collection(db,'trades'),{date,strat,symbol,lots,pnl,tax,notes});
    closeModal(); clearForm(); showToast('Trade added ✓');
  } catch(e) { setSyncState('error'); showToast('Error — check connection'); console.error(e); }
};

window.deleteTrade = async function(id) {
  if (!confirm('Delete this trade?')) return;
  setSyncState('syncing');
  try { await deleteDoc(doc(db,'trades',id)); showToast('Trade removed'); }
  catch(e) { setSyncState('error'); showToast('Error'); }
};

window.clearAllTrades = async function() {
  if (!trades.length) return;
  if (!confirm('Delete ALL '+trades.length+' trades? Cannot be undone.')) return;
  setSyncState('syncing');
  try { await Promise.all(trades.map(t=>deleteDoc(doc(db,'trades',t.id)))); showToast('All cleared'); }
  catch(e) { setSyncState('error'); showToast('Error'); }
};

window.clearForm = function() {
  ['f-lots','f-pnl','f-tax','f-notes'].forEach(id=>document.getElementById(id).value='');
};

// ── Threshold ──────────────────────────────────────────────────────────────
window.applyThreshold = async function() {
  const v = parseFloat(document.getElementById('dd-threshold').value);
  if (!v||v<1){showToast('Invalid value');return;}
  threshold=v;
  document.getElementById('threshold-display').textContent = fmt(v);
  try { await setDoc(doc(db,'settings','threshold'),{value:v}); showToast('Threshold → ₹'+fmt(v)+'/lot'); renderAll(); }
  catch(e){ showToast('Error saving'); }
};

// ── CSV ────────────────────────────────────────────────────────────────────
window.exportCSV = function() {
  if (!trades.length){showToast('No trades');return;}
  const {m2,m3}=getDDMaps();
  const rows=[['#','Date','Strategy','Symbol','Lots','Gross P&L','Taxes','Net P&L','Drawdown','DD/Lot','Delta Alert','Notes']];
  trades.forEach((t,i)=>{const d=t.strat==='200'?m2[t.id]:m3[t.id];rows.push([i+1,t.date,t.strat+'%',t.symbol||'',t.lots,t.pnl,t.tax,t.pnl-t.tax,d?d.dd:0,d?d.ddpl:0,(d&&isAlert(d))?'YES':'NO',t.notes||'']);});
  const csv=rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='tradejournal_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click(); showToast('CSV exported');
};

// ── Toast ──────────────────────────────────────────────────────────────────
let toastT;
window.showToast = function(msg) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),2500);
};

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
boot();
