// TradeJournal — Reports: on-screen reports + themed PDF export (desktop and mobile).
// Each report builds a plain model { kpis, sections, notes } that renders to HTML and to PDF.

let ctx = () => ({ trades: [], stratMap: {}, portfolios: [], adjustments: [], deltaInfo: () => null, owner: '' });
let current = null;
let filt = { from: '', to: '', sid: '', sym: '' };

export function initReports(getCtx) { ctx = getCtx; }

// ── Formatting ────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((n || 0) * 100) / 100;
const num = n => Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dow = d => new Date(d + 'T00:00:00').getDay();
const monthKey = d => d.slice(0, 7);
const monthLabel = k => MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);
const fyOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); const s = m >= 4 ? y : y - 1; return `FY ${s}-${String(s + 1).slice(2)}`; };
const iso = dt => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
function weekStart(d) { const dt = new Date(d + 'T00:00:00'); dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return iso(dt); }
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

// Cell types: 'money' (signed ₹), 'amt' (unsigned ₹), 'int', 'pct', 'ratio', 'text', 'date'
function fmtCell(v, type, pdf) {
  if (v === null || v === undefined || v === '') return '—';
  const rs = pdf ? 'Rs ' : '₹';
  switch (type) {
    case 'money': return (v > 0 ? '+' : v < 0 ? '-' : '') + rs + num(v);
    case 'amt': return rs + num(v);
    case 'int': return String(Math.round(v));
    case 'pct': return (Math.round(v * 10) / 10) + '%';
    case 'ratio': return v === Infinity ? (pdf ? 'inf' : '∞') : (Math.round(v * 100) / 100).toFixed(2);
    default: return String(v);
  }
}
const toneOf = (v, type) => type === 'money' && typeof v === 'number' ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';

// ── Data access ──────────────────────────────────────────────────────────────
const net = t => (t.pnl || 0) - (t.tax || 0);
const keyOf = t => t.strategyId || (t.strat ? 'L:' + t.strat : 'L:?');
const sOf = t => ctx().stratMap[keyOf(t)] || { name: '—', color: '#888' };

function filtered() {
  return ctx().trades.filter(t =>
    (!filt.from || t.date >= filt.from) && (!filt.to || t.date <= filt.to) &&
    (!filt.sid || keyOf(t) === filt.sid) && (!filt.sym || (t.symbol || 'OTHER') === filt.sym)
  ).sort((a, b) => a.date.localeCompare(b.date) || sOf(a).name.localeCompare(sOf(b).name));
}

function groupBy(list, fn) {
  const m = new Map();
  list.forEach(x => { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
  return m;
}

// Aggregate stats over a list of trades (each trade row = one strategy-day)
function agg(list) {
  const nets = list.map(net);
  const wins = nets.filter(x => x > 0), losses = nets.filter(x => x < 0);
  const gross = list.reduce((s, t) => s + (t.pnl || 0), 0);
  const tax = list.reduce((s, t) => s + (t.tax || 0), 0);
  const total = gross - tax;
  const lots = list.reduce((s, t) => s + (t.lots || 0), 0);
  const sumW = wins.reduce((a, b) => a + b, 0), sumL = -losses.reduce((a, b) => a + b, 0);
  return {
    n: list.length, gross, tax, net: total, lots,
    wins: wins.length, losses: losses.length,
    winRate: list.length ? wins.length / list.length * 100 : 0,
    avgWin: wins.length ? sumW / wins.length : 0,
    avgLoss: losses.length ? -sumL / losses.length : 0,
    pf: sumL ? sumW / sumL : (sumW ? Infinity : 0),
    expectancy: list.length ? total / list.length : 0,
    best: nets.length ? Math.max(...nets) : 0,
    worst: nets.length ? Math.min(...nets) : 0,
  };
}

// Combine all trades of a date into one day row
function dailyRows(list) {
  return [...groupBy(list, t => t.date)].map(([date, arr]) => {
    const a = agg(arr);
    return { date, n: arr.length, gross: a.gross, tax: a.tax, net: a.net, lots: arr.reduce((s, t) => s + (t.lots || 0), 0) };
  });
}

// Drawdown over a chronological list of {date, net, lots?}: returns per-point dd and episodes
function ddSeries(points) {
  let run = 0, peak = 0, peakDate = points.length ? points[0].date : '';
  let ep = null; const episodes = [], series = [];
  points.forEach(p => {
    run += p.net;
    if (run >= peak) {
      if (ep) { ep.recovered = p.date; episodes.push(ep); ep = null; }
      peak = run; peakDate = p.date;
    }
    const dd = Math.min(0, run - peak);
    if (dd < 0) {
      if (!ep) ep = { start: peakDate, trough: p.date, depth: dd, depthLots: p.lots ? dd / p.lots : 0, recovered: null };
      if (dd < ep.depth) { ep.depth = dd; ep.trough = p.date; ep.depthLots = p.lots ? dd / p.lots : 0; }
    }
    series.push({ date: p.date, run, dd, ddpl: p.lots ? dd / p.lots : 0 });
  });
  if (ep) episodes.push(ep);
  return { series, episodes, maxDD: series.reduce((m, s) => Math.min(m, s.dd), 0), final: run };
}

function streaksOf(nets) {
  let bestW = 0, bestL = 0, cur = 0, curType = 0;
  nets.forEach(x => {
    const t = x > 0 ? 1 : x < 0 ? -1 : 0;
    if (t !== 0 && t === curType) cur++; else { cur = t ? 1 : 0; curType = t; }
    if (curType === 1) bestW = Math.max(bestW, cur);
    if (curType === -1) bestL = Math.max(bestL, cur);
  });
  return { bestW, bestL, cur: curType === 1 ? `${cur} win${cur > 1 ? 's' : ''}` : curType === -1 ? `${cur} loss${cur > 1 ? 'es' : ''}` : '—' };
}

function byStrategy(list) {
  return [...groupBy(list, keyOf)].map(([k, arr]) => ({ s: ctx().stratMap[k] || { name: '—' }, arr }))
    .sort((a, b) => a.s.name.localeCompare(b.s.name));
}

const col = (h, k, type = 'text') => ({ h, k, type });
const kpi = (label, v, type = 'money', sub = '') => ({ label, v, type, sub });

// ── Report catalogue ─────────────────────────────────────────────────────────
const REPORTS = [
  { id: 'summary', group: 'Overview', title: 'Performance Summary', desc: 'Net, win rate, profit factor, expectancy, best/worst day and max drawdown.', build: rSummary },
  { id: 'daily', group: 'Time', title: 'Daily P&L', desc: 'Every trading day with charges, net, cumulative P&L and drawdown.', build: rDaily },
  { id: 'weekly', group: 'Time', title: 'Weekly P&L', desc: 'Week-by-week results (Monday start) with winning days.', build: rWeekly },
  { id: 'monthly', group: 'Time', title: 'Monthly P&L', desc: 'Month-by-month net, win rate, best and worst day.', build: rMonthly },
  { id: 'month-strat', group: 'Time', title: 'Month × Strategy', desc: 'Net P&L per month split by strategy.', build: rMonthStrat },
  { id: 'fy', group: 'Time', title: 'Financial Year Statement', desc: 'April–March totals: profit, loss, charges and net per FY.', build: rFY },
  { id: 'calendar', group: 'Time', title: 'P&L Calendar', desc: 'Month calendars with each day’s net.', build: rCalendar },
  { id: 'strategy', group: 'Breakdown', title: 'Strategy Comparison', desc: 'Side-by-side stats for every strategy.', build: rStrategy },
  { id: 'symbol', group: 'Breakdown', title: 'Index / Symbol Report', desc: 'NIFTY vs SENSEX (and others) performance.', build: rSymbol },
  { id: 'weekday', group: 'Breakdown', title: 'Weekday Report', desc: 'How each day of the week performs.', build: rWeekday },
  { id: 'portfolio', group: 'Breakdown', title: 'Portfolio Report', desc: 'Results for each portfolio and its strategies.', build: rPortfolio },
  { id: 'drawdown', group: 'Risk', title: 'Drawdown Report', desc: 'Every drawdown: start, trough, depth per lot, recovery time.', build: rDrawdown },
  { id: 'delta', group: 'Risk', title: 'Delta Status', desc: 'Current DD per lot, delta targets and what is set in AlgoTest.', build: rDelta },
  { id: 'streaks', group: 'Risk', title: 'Win / Loss Streaks', desc: 'Longest winning and losing runs per strategy.', build: rStreaks },
  { id: 'distribution', group: 'Risk', title: 'P&L Distribution', desc: 'How often trades land in each profit / loss band per lot.', build: rDistribution },
  { id: 'bestworst', group: 'Risk', title: 'Best & Worst', desc: 'Top 10 best and worst trades and days.', build: rBestWorst },
  { id: 'charges', group: 'Costs', title: 'Charges & Taxes', desc: 'Charges by month and strategy, and as a share of gross profit.', build: rCharges },
  { id: 'adjustments', group: 'Costs', title: 'Adjustments / Reconciliation', desc: 'Every P&L sync with the broker and the running account net.', build: rAdjustments },
  { id: 'ledger', group: 'Records', title: 'Trade Ledger', desc: 'Every trade with gross, charges, net and running drawdown.', build: rLedger },
  { id: 'notes', group: 'Records', title: 'Journal Notes', desc: 'All trades that have notes attached.', build: rNotes },
];

function rSummary(list) {
  const a = agg(list), days = dailyRows(list), d = agg(days.map(x => ({ pnl: x.gross, tax: x.tax, lots: x.lots })));
  const dd = ddSeries(days);
  const st = streaksOf(days.map(x => x.net));
  const bestDay = days.reduce((m, x) => (!m || x.net > m.net ? x : m), null);
  const worstDay = days.reduce((m, x) => (!m || x.net < m.net ? x : m), null);
  return {
    kpis: [
      kpi('Net P&L', a.net, 'money', 'after charges'), kpi('Gross P&L', a.gross), kpi('Charges', a.tax, 'amt'),
      kpi('Trading days', days.length, 'int', `${list.length} trades`),
      kpi('Day win rate', d.winRate, 'pct', `${d.wins}W / ${d.losses}L`), kpi('Trade win rate', a.winRate, 'pct', `${a.wins}W / ${a.losses}L`),
      kpi('Profit factor', a.pf, 'ratio', 'gross wins ÷ gross losses'), kpi('Expectancy', a.expectancy, 'money', 'avg net per trade'),
      kpi('Avg win', a.avgWin), kpi('Avg loss', a.avgLoss),
      kpi('Best day', bestDay ? bestDay.net : 0, 'money', bestDay ? bestDay.date : ''), kpi('Worst day', worstDay ? worstDay.net : 0, 'money', worstDay ? worstDay.date : ''),
      kpi('Max drawdown', dd.maxDD, 'money', 'combined, by day'), kpi('Longest win streak', st.bestW, 'int', 'days'), kpi('Longest loss streak', st.bestL, 'int', 'days'),
    ],
    sections: [{
      title: 'By strategy',
      cols: [col('Strategy', 'name'), col('Trades', 'n', 'int'), col('Win %', 'wr', 'pct'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Profit factor', 'pf', 'ratio')],
      rows: byStrategy(list).map(({ s, arr }) => { const x = agg(arr); return { name: s.name, n: x.n, wr: x.winRate, gross: x.gross, tax: x.tax, net: x.net, pf: x.pf }; }),
      total: { name: 'Total', n: a.n, wr: a.winRate, gross: a.gross, tax: a.tax, net: a.net, pf: a.pf },
    }],
  };
}

function rDaily(list) {
  const days = dailyRows(list), dd = ddSeries(days);
  let cum = 0;
  const rows = days.map((x, i) => { cum += x.net; return { date: x.date, day: DAYS[dow(x.date)], n: x.n, gross: x.gross, tax: x.tax, net: x.net, cum, dd: dd.series[i].dd }; });
  const a = agg(list);
  return {
    kpis: [kpi('Net P&L', a.net), kpi('Trading days', days.length, 'int'), kpi('Green days', days.filter(x => x.net > 0).length, 'int'), kpi('Red days', days.filter(x => x.net < 0).length, 'int')],
    sections: [{ title: 'Day by day', cols: [col('Date', 'date'), col('Day', 'day'), col('Trades', 'n', 'int'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Cumulative', 'cum', 'money'), col('Drawdown', 'dd', 'money')], rows,
      total: { date: 'Total', n: a.n, gross: a.gross, tax: a.tax, net: a.net } }],
  };
}

function rWeekly(list) {
  const days = dailyRows(list); let cum = 0;
  const rows = [...groupBy(days, x => weekStart(x.date))].map(([wk, arr]) => {
    const n = arr.reduce((s, x) => s + x.net, 0); cum += n;
    return { wk, days: arr.length, green: arr.filter(x => x.net > 0).length, gross: arr.reduce((s, x) => s + x.gross, 0), tax: arr.reduce((s, x) => s + x.tax, 0), net: n, cum };
  });
  const greenWeeks = rows.filter(r => r.net > 0).length;
  return {
    kpis: [kpi('Weeks', rows.length, 'int'), kpi('Green weeks', greenWeeks, 'int', rows.length ? Math.round(greenWeeks / rows.length * 100) + '%' : ''),
      kpi('Best week', rows.length ? Math.max(...rows.map(r => r.net)) : 0), kpi('Worst week', rows.length ? Math.min(...rows.map(r => r.net)) : 0)],
    sections: [{ title: 'Week by week', cols: [col('Week of', 'wk'), col('Days', 'days', 'int'), col('Green days', 'green', 'int'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Cumulative', 'cum', 'money')], rows }],
  };
}

function rMonthly(list) {
  const days = dailyRows(list); let cum = 0;
  const rows = [...groupBy(days, x => monthKey(x.date))].map(([m, arr]) => {
    const n = arr.reduce((s, x) => s + x.net, 0); cum += n; const g = arr.filter(x => x.net > 0).length;
    return { m: monthLabel(m), days: arr.length, wr: g / arr.length * 100, gross: arr.reduce((s, x) => s + x.gross, 0), tax: arr.reduce((s, x) => s + x.tax, 0), net: n, best: Math.max(...arr.map(x => x.net)), worst: Math.min(...arr.map(x => x.net)), cum };
  });
  const green = rows.filter(r => r.net > 0).length;
  return {
    kpis: [kpi('Months', rows.length, 'int'), kpi('Green months', green, 'int', rows.length ? Math.round(green / rows.length * 100) + '%' : ''),
      kpi('Avg month', rows.length ? rows.reduce((s, r) => s + r.net, 0) / rows.length : 0), kpi('Best month', rows.length ? Math.max(...rows.map(r => r.net)) : 0)],
    sections: [{ title: 'Month by month', cols: [col('Month', 'm'), col('Days', 'days', 'int'), col('Day win %', 'wr', 'pct'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Best day', 'best', 'money'), col('Worst day', 'worst', 'money'), col('Cumulative', 'cum', 'money')], rows }],
  };
}

function rMonthStrat(list) {
  const strats = byStrategy(list).map(x => x.s);
  const rows = [...groupBy(list, t => monthKey(t.date))].map(([m, arr]) => {
    const r = { m: monthLabel(m), total: arr.reduce((s, t) => s + net(t), 0) };
    strats.forEach((s, i) => { r['s' + i] = arr.filter(t => keyOf(t) === s.id).reduce((x, t) => x + net(t), 0); });
    return r;
  });
  const total = { m: 'Total', total: list.reduce((s, t) => s + net(t), 0) };
  strats.forEach((s, i) => { total['s' + i] = list.filter(t => keyOf(t) === s.id).reduce((x, t) => x + net(t), 0); });
  return { kpis: [], sections: [{ title: 'Net per month by strategy', cols: [col('Month', 'm'), ...strats.map((s, i) => col(s.name, 's' + i, 'money')), col('Total', 'total', 'money')], rows, total }] };
}

function rFY(list) {
  const rows = [...groupBy(list, t => fyOf(t.date))].map(([fy, arr]) => {
    const a = agg(arr); const nets = arr.map(net);
    return { fy, days: new Set(arr.map(t => t.date)).size, n: a.n, profit: nets.filter(x => x > 0).reduce((s, x) => s + x, 0), loss: nets.filter(x => x < 0).reduce((s, x) => s + x, 0), gross: a.gross, tax: a.tax, net: a.net };
  });
  return {
    kpis: rows.map(r => kpi(r.fy, r.net, 'money', `${r.days} days · charges ₹${num(r.tax)}`)),
    sections: [{ title: 'Financial years (April – March)', cols: [col('Financial year', 'fy'), col('Days', 'days', 'int'), col('Trades', 'n', 'int'), col('Profit trades', 'profit', 'money'), col('Loss trades', 'loss', 'money'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money')], rows }],
    notes: ['Figures come from your journal entries. Check them against your broker’s tax P&L before filing.'],
  };
}

function rCalendar(list) {
  const days = new Map(dailyRows(list).map(x => [x.date, x.net]));
  const months = [...new Set([...days.keys()].map(monthKey))];
  const sections = months.map(m => {
    const first = new Date(m + '-01T00:00:00'), rows = [];
    const cur = new Date(first); cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
    while (iso(cur) <= m + '-31') {
      const r = {}; let total = 0, any = false;
      for (let i = 0; i < 7; i++) {
        const d = iso(cur), inMonth = monthKey(d) === m;
        r['d' + i] = !inMonth ? null : days.has(d) ? days.get(d) : '';
        r['n' + i] = inMonth ? +d.slice(8) : '';
        if (inMonth && days.has(d)) { total += days.get(d); any = true; }
        cur.setDate(cur.getDate() + 1);
      }
      r.total = any ? total : null;
      rows.push(r);
    }
    const mt = [...days].filter(([d]) => monthKey(d) === m).reduce((s, [, v]) => s + v, 0);
    return {
      title: monthLabel(m) + ' · ' + fmtCell(mt, 'money'), calendar: true,
      cols: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((h, i) => ({ h, k: 'd' + i, type: 'money', dayKey: 'n' + i })).concat([col('Week', 'total', 'money')]),
      rows,
    };
  });
  return { kpis: [], sections };
}

function statRow(name, arr) {
  const x = agg(arr), days = dailyRows(arr), dd = ddSeries(arr.map(t => ({ date: t.date, net: net(t), lots: t.lots })));
  const lots = arr.length ? arr[arr.length - 1].lots || 0 : 0;
  return { name, n: x.n, days: days.length, wr: x.winRate, gross: x.gross, tax: x.tax, net: x.net, avg: x.expectancy, best: x.best, worst: x.worst, pf: x.pf, maxdd: dd.maxDD, maxddl: lots ? dd.maxDD / lots : null, curddl: dd.series.length && lots ? dd.series[dd.series.length - 1].dd / lots : null };
}
const STAT_COLS = [col('Trades', 'n', 'int'), col('Win %', 'wr', 'pct'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Avg / trade', 'avg', 'money'), col('Best', 'best', 'money'), col('Worst', 'worst', 'money'), col('Profit factor', 'pf', 'ratio'), col('Max DD', 'maxdd', 'money')];

function rStrategy(list) {
  const rows = byStrategy(list).map(({ s, arr }) => statRow(s.name, arr));
  return { kpis: [], sections: [{ title: 'Strategies', cols: [col('Strategy', 'name'), ...STAT_COLS, col('Max DD / lot', 'maxddl', 'money'), col('DD / lot now', 'curddl', 'money')], rows }] };
}

function rSymbol(list) {
  const rows = [...groupBy(list, t => t.symbol || 'OTHER')].map(([sym, arr]) => statRow(sym, arr)).sort((a, b) => b.net - a.net);
  const cross = [];
  byStrategy(list).forEach(({ s, arr }) => [...groupBy(arr, t => t.symbol || 'OTHER')].forEach(([sym, a2]) => { const x = agg(a2); cross.push({ name: s.name, sym, n: x.n, wr: x.winRate, net: x.net, avg: x.expectancy }); }));
  return { kpis: [], sections: [
    { title: 'By index / symbol', cols: [col('Symbol', 'name'), ...STAT_COLS], rows },
    { title: 'Strategy × symbol', cols: [col('Strategy', 'name'), col('Symbol', 'sym'), col('Trades', 'n', 'int'), col('Win %', 'wr', 'pct'), col('Net', 'net', 'money'), col('Avg / trade', 'avg', 'money')], rows: cross },
  ] };
}

function rWeekday(list) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const g = groupBy(list, t => dow(t.date));
  const rows = order.filter(d => g.has(d)).map(d => { const r = statRow(DAYS[d], g.get(d)); r.dayCount = new Set(g.get(d).map(t => t.date)).size; return r; });
  return { kpis: [], sections: [{ title: 'By weekday', cols: [col('Day', 'name'), col('Days', 'dayCount', 'int'), ...STAT_COLS.slice(0, 8)], rows }] };
}

function rPortfolio(list) {
  const { portfolios, stratMap } = ctx();
  const rows = portfolios.map(p => {
    const ids = new Set(p.strategyIds || []);
    const arr = list.filter(t => ids.has(t.strategyId));
    const r = statRow(p.name, arr); r.status = p.active ? 'Running' : 'Stopped'; r.strats = [...ids].map(id => (stratMap[id] || {}).name).filter(Boolean).join(', ');
    return r;
  });
  return { kpis: [], sections: [{ title: 'Portfolios', cols: [col('Portfolio', 'name'), col('Status', 'status'), col('Strategies', 'strats'), col('Trades', 'n', 'int'), col('Win %', 'wr', 'pct'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('Max DD', 'maxdd', 'money')], rows }] };
}

function rDrawdown(list) {
  const sections = [];
  const days = dailyRows(list);
  const all = ddSeries(days);
  const epRow = (e, lots) => ({ start: e.start, trough: e.trough, depth: e.depth, depthl: lots ? e.depth / lots : (e.depthLots || null), rec: e.recovered || 'Not yet', toTrough: daysBetween(e.start, e.trough), toRec: e.recovered ? daysBetween(e.trough, e.recovered) : null });
  const EP_COLS = [col('Peak date', 'start'), col('Lowest date', 'trough'), col('Depth', 'depth', 'money'), col('Depth / lot', 'depthl', 'money'), col('Recovered', 'rec'), col('Days to low', 'toTrough', 'int'), col('Days to recover', 'toRec', 'int')];
  const kpis = [kpi('Max drawdown (combined)', all.maxDD), kpi('Drawdowns (combined)', all.episodes.length, 'int')];
  byStrategy(list).forEach(({ s, arr }) => {
    const lots = arr.length ? arr[arr.length - 1].lots : 0;
    const d = ddSeries(arr.map(t => ({ date: t.date, net: net(t), lots: t.lots })));
    const cur = d.series.length ? d.series[d.series.length - 1] : null;
    kpis.push(kpi(s.name + ' max DD / lot', lots ? d.maxDD / lots : 0, 'money', 'now ' + fmtCell(cur && lots ? cur.dd / lots : 0, 'money')));
    sections.push({ title: s.name + ' — drawdowns', cols: EP_COLS, rows: d.episodes.filter(e => e.depth < 0).sort((a, b) => a.depth - b.depth).map(e => epRow(e, lots)) });
  });
  sections.push({ title: 'Combined account — drawdowns', cols: EP_COLS.filter(c => c.k !== 'depthl'), rows: all.episodes.sort((a, b) => a.depth - b.depth).map(e => epRow(e, 0)) });
  return { kpis, sections, notes: ['Sorted deepest first. "Not yet" means the drawdown is still open.'] };
}

function rDelta() {
  const { stratMap, deltaInfo } = ctx();
  const rows = Object.values(stratMap).filter(s => !s.virtual).map(s => {
    const d = deltaInfo(s) || {};
    return { name: s.name, rule: s.deltaBase != null ? `${s.deltaBase} to cap ${s.deltaCap}, +1 per ₹${num(d.step || s.threshold || 1000)}` : 'Not set', ddpl: d.ddpl ?? null, target: d.target ?? null, set: d.set ?? null, setOn: d.setOn || '—', status: d.target == null ? '—' : d.need ? 'Change needed' : 'In sync', last: d.lastDate || '—' };
  });
  return { kpis: [], sections: [{ title: 'Delta per strategy', cols: [col('Strategy', 'name'), col('Rule', 'rule'), col('DD / lot now', 'ddpl', 'money'), col('Target delta', 'target', 'int'), col('Set in AlgoTest', 'set', 'int'), col('Set on', 'setOn'), col('Status', 'status'), col('Last trade', 'last')], rows }], notes: ['Uses all trades (filters do not apply), because the delta depends on the full drawdown history.'] };
}

function rStreaks(list) {
  const rows = byStrategy(list).map(({ s, arr }) => { const st = streaksOf(arr.map(net)); return { name: s.name, w: st.bestW, l: st.bestL, cur: st.cur }; });
  const days = dailyRows(list), sd = streaksOf(days.map(x => x.net));
  rows.push({ name: 'Combined (by day)', w: sd.bestW, l: sd.bestL, cur: sd.cur });
  // Runs of 3+ in the combined day series
  const runs = []; let start = 0;
  for (let i = 1; i <= days.length; i++) {
    const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    if (i === days.length || sign(days[i].net) !== sign(days[start].net)) {
      const len = i - start;
      if (len >= 3 && sign(days[start].net) !== 0) runs.push({ type: days[start].net > 0 ? 'Winning' : 'Losing', from: days[start].date, to: days[i - 1].date, len, net: days.slice(start, i).reduce((s, x) => s + x.net, 0) });
      start = i;
    }
  }
  return { kpis: [], sections: [
    { title: 'Longest streaks', cols: [col('Strategy', 'name'), col('Longest win streak', 'w', 'int'), col('Longest loss streak', 'l', 'int'), col('Current', 'cur')], rows },
    { title: 'Runs of 3 or more days (combined)', cols: [col('Type', 'type'), col('From', 'from'), col('To', 'to'), col('Days', 'len', 'int'), col('Net', 'net', 'money')], rows: runs },
  ] };
}

function rDistribution(list) {
  const bands = [[-Infinity, -3000], [-3000, -2000], [-2000, -1000], [-1000, -500], [-500, 0], [0, 500], [500, 1000], [1000, 2000], [2000, 3000], [3000, Infinity]];
  const label = ([a, b]) => a === -Infinity ? `Below -${num(-b)}` : b === Infinity ? `${num(a)} and above` : `${a < 0 ? '-' : ''}${num(a)} to ${b < 0 ? '-' : ''}${num(b)}`;
  const sections = byStrategy(list).map(({ s, arr }) => {
    const per = arr.map(t => net(t) / (t.lots || 1));
    return { title: s.name + ' — net per lot per trade', cols: [col('Band (₹ per lot)', 'band'), col('Trades', 'n', 'int'), col('Share', 'pct', 'pct'), col('Total net', 'net', 'money')],
      rows: bands.map(b => { const inB = arr.filter((t, i) => per[i] >= b[0] && per[i] < b[1]); return { band: label(b), n: inB.length, pct: arr.length ? inB.length / arr.length * 100 : 0, net: inB.reduce((x, t) => x + net(t), 0) }; }) };
  });
  return { kpis: [], sections };
}

function rBestWorst(list) {
  const tr = list.map(t => ({ date: t.date, name: sOf(t).name, sym: t.symbol || 'OTHER', net: net(t), perlot: net(t) / (t.lots || 1) }));
  const days = dailyRows(list).map(x => ({ date: x.date, day: DAYS[dow(x.date)], n: x.n, net: x.net }));
  const TC = [col('Date', 'date'), col('Strategy', 'name'), col('Symbol', 'sym'), col('Net', 'net', 'money'), col('Net / lot', 'perlot', 'money')];
  const DC = [col('Date', 'date'), col('Day', 'day'), col('Trades', 'n', 'int'), col('Net', 'net', 'money')];
  return { kpis: [], sections: [
    { title: 'Best 10 trades', cols: TC, rows: [...tr].sort((a, b) => b.net - a.net).slice(0, 10) },
    { title: 'Worst 10 trades', cols: TC, rows: [...tr].sort((a, b) => a.net - b.net).slice(0, 10) },
    { title: 'Best 10 days', cols: DC, rows: [...days].sort((a, b) => b.net - a.net).slice(0, 10) },
    { title: 'Worst 10 days', cols: DC, rows: [...days].sort((a, b) => a.net - b.net).slice(0, 10) },
  ] };
}

function rCharges(list) {
  const a = agg(list);
  const byM = [...groupBy(list, t => monthKey(t.date))].map(([m, arr]) => { const x = agg(arr); return { m: monthLabel(m), n: x.n, gross: x.gross, tax: x.tax, avg: x.n ? x.tax / x.n : 0, share: x.gross > 0 ? x.tax / x.gross * 100 : null }; });
  const byS = byStrategy(list).map(({ s, arr }) => { const x = agg(arr); return { m: s.name, n: x.n, gross: x.gross, tax: x.tax, avg: x.n ? x.tax / x.n : 0, share: x.gross > 0 ? x.tax / x.gross * 100 : null }; });
  const C = [col('', 'm'), col('Trades', 'n', 'int'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Avg / trade', 'avg', 'amt'), col('% of gross', 'share', 'pct')];
  const zero = list.filter(t => !(t.tax > 0)).length;
  return {
    kpis: [kpi('Total charges', a.tax, 'amt'), kpi('Avg per trade', a.n ? a.tax / a.n : 0, 'amt'), kpi('Share of gross', a.gross > 0 ? a.tax / a.gross * 100 : 0, 'pct'), kpi('Trades with ₹0 charges', zero, 'int', zero ? 'check these' : 'all have charges')],
    sections: [{ title: 'By month', cols: [{ ...C[0], h: 'Month' }, ...C.slice(1)], rows: byM }, { title: 'By strategy', cols: [{ ...C[0], h: 'Strategy' }, ...C.slice(1)], rows: byS }],
  };
}

function rAdjustments() {
  const { adjustments, trades } = ctx();
  const ordered = [...adjustments].sort((x, y) => x.date.localeCompare(y.date));
  const tradesNet = trades.reduce((s, t) => s + net(t), 0), adj = ordered.reduce((s, x) => s + (x.amount || 0), 0);
  return {
    kpis: [kpi('From trades', tradesNet), kpi('Adjustments', adj), kpi('Account net', tradesNet + adj), kpi('Syncs', ordered.length, 'int')],
    sections: [{ title: 'Syncs', cols: [col('Date', 'date'), col('Actual P&L entered', 'actual', 'money'), col('Adjustment', 'amount', 'money'), col('Note', 'note')], rows: ordered.map(x => ({ date: x.date, actual: x.actualPnl || 0, amount: x.amount || 0, note: x.note || '' })) }],
    notes: ['Uses all records (filters do not apply).'],
  };
}

function rLedger(list) {
  const runs = {};
  const rows = list.map(t => {
    const k = keyOf(t); const r = runs[k] || (runs[k] = { run: 0, peak: 0 });
    r.run += net(t); r.peak = Math.max(r.peak, r.run); const dd = Math.min(0, r.run - r.peak);
    return { date: t.date, name: sOf(t).name, sym: t.symbol || 'OTHER', lots: t.lots, gross: t.pnl || 0, tax: t.tax || 0, net: net(t), ddl: t.lots ? dd / t.lots : 0 };
  });
  const a = agg(list);
  return { kpis: [kpi('Trades', a.n, 'int'), kpi('Net P&L', a.net), kpi('Charges', a.tax, 'amt'), kpi('Win rate', a.winRate, 'pct')],
    sections: [{ title: 'All trades', cols: [col('Date', 'date'), col('Strategy', 'name'), col('Symbol', 'sym'), col('Lots', 'lots', 'int'), col('Gross', 'gross', 'money'), col('Charges', 'tax', 'amt'), col('Net', 'net', 'money'), col('DD / lot', 'ddl', 'money')], rows,
      total: { date: 'Total', gross: a.gross, tax: a.tax, net: a.net } }] };
}

function rNotes(list) {
  const rows = list.filter(t => (t.notes || '').trim()).map(t => ({ date: t.date, name: sOf(t).name, net: net(t), notes: t.notes.trim() }));
  return { kpis: [kpi('Trades with notes', rows.length, 'int')], sections: [{ title: 'Notes', cols: [col('Date', 'date'), col('Strategy', 'name'), col('Net', 'net', 'money'), col('Note', 'notes')], rows }] };
}

// ── Filters UI ───────────────────────────────────────────────────────────────
function filterLabel() {
  const { stratMap } = ctx();
  const parts = [];
  parts.push(filt.from || filt.to ? `${filt.from || 'start'} to ${filt.to || 'today'}` : 'All dates');
  parts.push(filt.sid ? (stratMap[filt.sid] || {}).name : 'All strategies');
  parts.push(filt.sym || 'All symbols');
  return parts.join(' · ');
}

function preset(p) {
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
  const fyStart = m >= 3 ? y : y - 1;
  const P = {
    all: ['', ''],
    mtd: [iso(new Date(y, m, 1)), ''],
    last: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
    m3: [iso(new Date(y, m - 2, 1)), ''],
    fy: [`${fyStart}-04-01`, ''],
    lfy: [`${fyStart - 1}-04-01`, `${fyStart}-03-31`],
  }[p];
  if (!P) return;
  [filt.from, filt.to] = P;
  document.getElementById('rp-from').value = filt.from;
  document.getElementById('rp-to').value = filt.to;
  document.querySelectorAll('#rp-presets button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  refresh();
}

function readFilters() {
  filt.from = document.getElementById('rp-from').value;
  filt.to = document.getElementById('rp-to').value;
  filt.sid = document.getElementById('rp-strat').value;
  filt.sym = document.getElementById('rp-sym').value;
}

function refresh() {
  const n = filtered().length;
  const sub = document.getElementById('rp-sub');
  if (sub) sub.textContent = `${n} trade${n === 1 ? '' : 's'} in range · ${filterLabel()}`;
  if (current) openReport(current, true);
}

export function renderReports() {
  const { stratMap, trades } = ctx();
  const ss = document.getElementById('rp-strat');
  if (ss) {
    const keep = ss.value;
    ss.innerHTML = '<option value="">All strategies</option>' + Object.values(stratMap).filter(s => trades.some(t => keyOf(t) === s.id)).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    ss.value = keep;
  }
  const sy = document.getElementById('rp-sym');
  if (sy) {
    const keep = sy.value;
    sy.innerHTML = '<option value="">All symbols</option>' + [...new Set(trades.map(t => t.symbol || 'OTHER'))].sort().map(s => `<option>${esc(s)}</option>`).join('');
    sy.value = keep;
  }
  const grid = document.getElementById('rp-grid');
  if (grid && !grid.childElementCount) {
    const groups = [...new Set(REPORTS.map(r => r.group))];
    grid.innerHTML = groups.map(g => `<div class="rp-group">${esc(g)}</div>` + REPORTS.filter(r => r.group === g).map(r => `
      <div class="rp-card" onclick="rpOpen('${r.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')rpOpen('${r.id}')">
        <div class="rp-card-t">${esc(r.title)}</div>
        <div class="rp-card-d">${esc(r.desc)}</div>
        <div class="rp-card-a"><span class="rp-view">View</span><button class="rp-pdf-btn" onclick="event.stopPropagation();rpPdf('${r.id}')">PDF</button></div>
      </div>`).join('')).join('');
  }
  refresh();
}

// ── HTML rendering ───────────────────────────────────────────────────────────
function cellHTML(row, c) {
  const v = row[c.k];
  if (c.dayKey) {
    if (v === null) return '<td class="rp-cal-off"></td>';
    const dn = row[c.dayKey];
    return `<td class="rp-cal ${toneOf(v, 'money')}"><span class="rp-cal-n">${dn}</span>${v === '' ? '' : fmtCell(v, 'money')}</td>`;
  }
  const num = c.type !== 'text';
  return `<td class="${num ? 'mono rp-num' : ''} ${toneOf(v, c.type) === 'pos' ? 'vpos' : toneOf(v, c.type) === 'neg' ? 'vneg' : ''}">${esc(fmtCell(v, c.type))}</td>`;
}

function modelFor(id) {
  const r = REPORTS.find(x => x.id === id);
  return r ? { ...r, ...r.build(filtered()) } : null;
}

function openReport(id, quiet) {
  const m = modelFor(id); if (!m) return;
  current = id;
  const box = document.getElementById('rp-view');
  document.getElementById('rp-grid').style.display = 'none';
  box.style.display = '';
  box.innerHTML = `
    <div class="rp-view-hd">
      <button class="f-btn" onclick="rpClose()">← All reports</button>
      <div class="rp-view-t"><div class="pg-title" style="font-size:19px;margin:0">${esc(m.title)}</div><div class="pg-sub">${esc(filterLabel())}</div></div>
      <button class="btn-primary rp-dl" onclick="rpPdf('${id}')">Download PDF</button>
    </div>
    ${m.kpis.length ? `<div class="kpi-grid rp-kpis">${m.kpis.map(k => `<div class="kpi"><div class="kpi-top"><span class="kpi-lbl">${esc(k.label)}</span></div>
      <div class="kpi-val ${toneOf(k.v, k.type) === 'pos' ? 'kpi-pos' : toneOf(k.v, k.type) === 'neg' ? 'kpi-neg' : 'kpi-neu'}">${esc(fmtCell(k.v, k.type))}</div>
      ${k.sub ? `<div class="kpi-sub">${esc(k.sub)}</div>` : ''}</div>`).join('')}</div>` : ''}
    ${m.sections.map(s => `
      <div class="card-lbl rp-sec-t">${esc(s.title)}</div>
      <div class="tbl-card"><table class="${s.calendar ? 'rp-cal-tbl' : ''}">
        <thead><tr>${s.cols.map(c => `<th class="${c.type !== 'text' ? 'rp-num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.length ? s.rows.map(r => `<tr>${s.cols.map(c => cellHTML(r, c)).join('')}</tr>`).join('') : `<tr><td colspan="${s.cols.length}" class="empty-cell">No data for these filters</td></tr>`}
        ${s.total ? `<tr class="rp-total">${s.cols.map(c => cellHTML(s.total, c)).join('')}</tr>` : ''}</tbody>
      </table></div>`).join('')}
    ${(m.notes || []).map(n => `<div class="rp-note">${esc(n)}</div>`).join('')}`;
  if (!quiet) document.getElementById('content').scrollTop = 0;
}

function closeReport() {
  current = null;
  document.getElementById('rp-view').style.display = 'none';
  document.getElementById('rp-grid').style.display = '';
}

// ── PDF export ───────────────────────────────────────────────────────────────
// Built-in PDF fonts only cover Latin-1: swap the rupee sign and drop anything else they cannot print
const pt = v => String(v ?? '').replace(/₹/g, 'Rs ').replace(/[→⟶]/g, '->').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u00D7]/g, '');
const PDF_C = { bg: [17, 17, 17], panel: [24, 24, 24], panel2: [30, 30, 30], line: [44, 44, 46], t1: [217, 217, 217], t2: [187, 187, 187], t3: [140, 140, 140], accent: [212, 96, 59], pos: [91, 154, 93], neg: [226, 95, 91] };
let libP = null;
function loadPdfLib() {
  if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
  if (libP) return libP;
  const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  libP = add('vendor/jspdf.umd.min.js').then(() => add('vendor/jspdf.plugin.autotable.min.js')).catch(e => { libP = null; throw e; });
  return libP;
}

export function buildPdf(m, label, owner, jsPDF) {
  const doc = new jsPDF({ orientation: m.sections.some(s => s.cols.length > 8) ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 32;
  const paint = () => { doc.setFillColor(...PDF_C.bg); doc.rect(0, 0, W, H, 'F'); };
  const footer = () => {
    doc.setFontSize(8); doc.setTextColor(...PDF_C.t3);
    doc.text(pt('TradeJournal · ' + m.title), M, H - 16);
    doc.text('Page ' + doc.internal.getCurrentPageInfo().pageNumber, W - M, H - 16, { align: 'right' });
  };
  paint();
  // Header band
  doc.setFillColor(...PDF_C.panel); doc.rect(0, 0, W, 78, 'F');
  doc.setFillColor(...PDF_C.accent); doc.rect(0, 76, W, 2, 'F');
  doc.setTextColor(...PDF_C.accent); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('TRADEJOURNAL REPORT', M, 26);
  doc.setTextColor(...PDF_C.t1); doc.setFontSize(18); doc.text(pt(m.title), M, 48);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PDF_C.t3);
  const gen = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  doc.text(pt(label), M, 64);
  doc.text(pt((owner ? owner + ' · ' : '') + 'Generated ' + gen), W - M, 64, { align: 'right' });
  let y = 96;

  // KPI tiles
  if (m.kpis.length) {
    const perRow = doc.internal.pageSize.getWidth() > 700 ? 5 : 4, gap = 8, tw = (W - 2 * M - gap * (perRow - 1)) / perRow, th = 46;
    m.kpis.forEach((k, i) => {
      const cx = M + (i % perRow) * (tw + gap), cy = y + Math.floor(i / perRow) * (th + gap);
      doc.setFillColor(...PDF_C.panel); doc.setDrawColor(...PDF_C.line); doc.roundedRect(cx, cy, tw, th, 3, 3, 'FD');
      doc.setFontSize(6.8); doc.setTextColor(...PDF_C.t3); doc.setFont('helvetica', 'bold');
      doc.text(pt(k.label).toUpperCase().slice(0, 34), cx + 8, cy + 14);
      const tone = toneOf(k.v, k.type);
      doc.setTextColor(...(tone === 'pos' ? PDF_C.pos : tone === 'neg' ? PDF_C.neg : PDF_C.t1));
      doc.setFont('helvetica', 'normal'); doc.setFontSize(12.5); doc.text(fmtCell(k.v, k.type, true), cx + 8, cy + 31);
      if (k.sub) { doc.setFontSize(6.8); doc.setTextColor(...PDF_C.t3); doc.text(pt(k.sub).slice(0, 40), cx + 8, cy + 41); }
    });
    y += Math.ceil(m.kpis.length / perRow) * (th + gap) + 10;
  }

  m.sections.forEach(s => {
    if (y > H - 90) { doc.addPage(); paint(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...PDF_C.t2);
    doc.text(pt(s.title), M, y + 4);
    const body = s.rows.map(r => s.cols.map(c => {
      if (c.dayKey) return r[c.k] === null ? '' : `${r[c.dayKey]}${r[c.k] === '' ? '' : '\n' + fmtCell(r[c.k], 'money', true)}`;
      return pt(fmtCell(r[c.k], c.type, true));
    }));
    const foot = s.total ? [s.cols.map(c => (s.total[c.k] === undefined ? '' : fmtCell(s.total[c.k], c.type, true)))] : undefined;
    doc.autoTable({
      startY: y + 10, margin: { left: M, right: M, top: M, bottom: 34 },
      head: [s.cols.map(c => pt(c.h))], body: body.length ? body : [[{ content: 'No data for these filters', colSpan: s.cols.length }]], foot,
      theme: 'plain', styles: { font: 'helvetica', fontSize: s.cols.length > 9 ? 7 : 8, textColor: PDF_C.t1, cellPadding: 4.5, lineColor: PDF_C.line, lineWidth: { bottom: 0.4 }, fillColor: PDF_C.bg },
      headStyles: { fillColor: PDF_C.panel2, textColor: PDF_C.t3, fontStyle: 'bold', fontSize: 7 },
      footStyles: { fillColor: PDF_C.panel, textColor: PDF_C.t1, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [21, 21, 21] },
      columnStyles: Object.fromEntries(s.cols.map((c, i) => [i, { halign: c.type === 'text' ? 'left' : c.dayKey ? 'center' : 'right', ...(s.calendar ? { cellWidth: (W - 2 * M) / s.cols.length } : {}) }])),
      willDrawPage: d => { if (d.pageNumber > 1) paint(); },
      didParseCell: d => {
        const hc = s.cols[d.column.index];
        if (d.section === 'head' || d.section === 'foot') d.cell.styles.halign = !hc || hc.type === 'text' ? 'left' : hc.dayKey ? 'center' : 'right';
        if (d.section === 'head') return;
        const c = s.cols[d.column.index]; if (!c) return;
        const src = d.section === 'foot' ? s.total : s.rows[d.row.index]; if (!src) return;
        const tone = toneOf(src[c.k], c.dayKey ? 'money' : c.type);
        if (tone) d.cell.styles.textColor = tone === 'pos' ? PDF_C.pos : PDF_C.neg;
      },
      didDrawPage: footer,
    });
    y = doc.lastAutoTable.finalY + 22;
  });

  (m.notes || []).forEach(n => {
    if (y > H - 50) { doc.addPage(); paint(); footer(); y = M; }
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(...PDF_C.t3);
    doc.text(doc.splitTextToSize(pt(n), W - 2 * M), M, y); y += 14;
  });
  return doc;
}

async function downloadPdf(id) {
  const m = modelFor(id); if (!m) return;
  const btns = document.querySelectorAll('.rp-dl, .rp-pdf-btn');
  btns.forEach(b => { b.disabled = true; });
  try {
    await loadPdfLib();
    const doc = buildPdf(m, filterLabel(), ctx().owner, window.jspdf.jsPDF);
    const name = `TradeJournal-${m.title.replace(/[^a-z0-9]+/gi, '-')}-${iso(new Date())}.pdf`;
    const blob = doc.output('blob');
    const file = typeof File === 'function' ? new File([blob], name, { type: 'application/pdf' }) : null;
    const touch = window.matchMedia('(hover:none),(pointer:coarse)').matches;
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: m.title }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    console.error(e);
    window.showToast && window.showToast('PDF failed — check your connection and try again');
  } finally { btns.forEach(b => { b.disabled = false; }); }
}

Object.assign(window, {
  rpOpen: id => openReport(id),
  rpClose: closeReport,
  rpPdf: downloadPdf,
  rpPreset: preset,
  rpFilter: () => { readFilters(); document.querySelectorAll('#rp-presets button').forEach(b => b.classList.remove('on')); refresh(); },
});

export const _test = { REPORTS, modelFor, setCtx: c => { ctx = () => c; }, setFilt: f => { filt = { ...filt, ...f }; } };
