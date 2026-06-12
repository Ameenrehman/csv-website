/* Trading Signals Dashboard - vanilla JS, no backend.
 * Reads CSV files live from the repository via the GitLab API (swappable to GitHub). */
(() => {
'use strict';

/* ================= Configuration ================= */
const CONFIG = {
  source: 'github', // 'gitlab' | 'github'
  gitlab: { baseUrl: 'https://gitlab.com', projectPath: 'devops26071-group/csv-website', ref: 'main' },
  github: { owner: 'Ameenrehman', repo: 'csv-website', branch: 'main' },
  concurrency: 8,
  cachePrefix: 'sigcache:v1:',
};

/* ================= Data source adapters ================= */
const GitLabSource = {
  enc: encodeURIComponent(CONFIG.gitlab.projectPath),
  api(path, params = {}) {
    const u = new URL(`${CONFIG.gitlab.baseUrl}/api/v4/projects/${this.enc}${path}`);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  },
  async listCsvFiles() {
    const files = [];
    let page = 1;
    while (true) {
      const res = await fetch(this.api('/repository/tree', { recursive: 'true', per_page: '100', page: String(page), ref: CONFIG.gitlab.ref }));
      if (!res.ok) throw new Error(`GitLab API error ${res.status} while listing files`);
      const items = await res.json();
      for (const it of items) {
        if (it.type === 'blob' && /\.csv$/i.test(it.name)) files.push({ path: it.path, name: it.name, id: it.id });
      }
      const next = res.headers.get('x-next-page');
      if (!next) break;
      page = parseInt(next, 10);
    }
    return files;
  },
  async fetchRaw(path) {
    const res = await fetch(this.api(`/repository/files/${encodeURIComponent(path)}/raw`, { ref: CONFIG.gitlab.ref }));
    if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
    return res.text();
  },
  async recentCommits(n = 10) {
    try {
      const res = await fetch(this.api('/repository/commits', { per_page: String(n), ref_name: CONFIG.gitlab.ref }));
      if (!res.ok) return [];
      return (await res.json()).map(c => ({ title: c.title, date: c.committed_date, url: c.web_url }));
    } catch { return []; }
  },
  repoUrl: () => `${CONFIG.gitlab.baseUrl}/${CONFIG.gitlab.projectPath}`,
  fileUrl: (path) => `${CONFIG.gitlab.baseUrl}/${CONFIG.gitlab.projectPath}/-/blob/${CONFIG.gitlab.ref}/${path}`,
};

const GitHubSource = {
  base() { const g = CONFIG.github; return `https://api.github.com/repos/${g.owner}/${g.repo}`; },
  async listCsvFiles() {
    const res = await fetch(`${this.base()}/git/trees/${CONFIG.github.branch}?recursive=1`);
    if (!res.ok) throw new Error(`GitHub API error ${res.status} while listing files`);
    const data = await res.json();
    return (data.tree || []).filter(it => it.type === 'blob' && /\.csv$/i.test(it.path))
      .map(it => ({ path: it.path, name: it.path.split('/').pop(), id: it.sha }));
  },
  async fetchRaw(path) {
    const g = CONFIG.github;
    const res = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/${path}`);
    if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
    return res.text();
  },
  async recentCommits(n = 10) {
    try {
      const res = await fetch(`${this.base()}/commits?per_page=${n}&sha=${CONFIG.github.branch}`);
      if (!res.ok) return [];
      return (await res.json()).map(c => ({ title: c.commit.message.split('\n')[0], date: c.commit.committer.date, url: c.html_url }));
    } catch { return []; }
  },
  repoUrl() { const g = CONFIG.github; return `https://github.com/${g.owner}/${g.repo}`; },
  fileUrl(path) { const g = CONFIG.github; return `https://github.com/${g.owner}/${g.repo}/blob/${g.branch}/${path}`; },
};

const DataSource = CONFIG.source === 'github' ? GitHubSource : GitLabSource;

/* ================= Cache (localStorage keyed by blob SHA) ================= */
const Cache = {
  get(path, blobId) {
    try {
      const raw = localStorage.getItem(CONFIG.cachePrefix + path);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj.id === blobId ? obj.text : null;
    } catch { return null; }
  },
  set(path, blobId, text) {
    try { localStorage.setItem(CONFIG.cachePrefix + path, JSON.stringify({ id: blobId, text })); }
    catch { /* quota exceeded: evict our keys and continue uncached */
      try { Object.keys(localStorage).filter(k => k.startsWith(CONFIG.cachePrefix)).forEach(k => localStorage.removeItem(k)); } catch {}
    }
  },
};

/* ================= Utilities ================= */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/[%,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const fmtNum = (n, d = 2) => n == null ? '\u2013' : n.toLocaleString(undefined, { maximumFractionDigits: d });
const fmtPct = (n, d = 2) => n == null ? '\u2013' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
const pctClass = (n) => n == null ? '' : (n >= 0 ? 'num-pos' : 'num-neg');
const dayMs = 86400000;
const parseDate = (s) => { if (!s) return null; const m = String(s).trim().match(/(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const daysBetween = (a, b) => (a && b) ? Math.max(0, Math.round((b - a) / dayMs)) : null;
const today = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

/* ================= CSV parsing ================= */
function parseCSV(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const DAILY_RE = /^(\d{4}-\d{2}-\d{2})[_ ]?Max[_ ]?(Profit|Loss)$/i;
const HEADER_ALIASES = {
  symbol: ['symbol', 'ticker', 'stock'],
  entry: ['entry', 'entry price', 'entryprice', 'entry_price'],
  sl: ['sl', 'stop loss', 'stoploss', 'stop_loss', 'stop'],
  tp: ['tp', 'target', 'target price', 'targetprice', 'target_price', 'tp price'],
  status: ['status', 'state'],
  exitPrice: ['exit price', 'exitprice', 'exit_price', 'exit'],
  exitDate: ['exit date', 'exitdate', 'exit_date'],
};

function normStatus(s) {
  const t = String(s || '').toLowerCase();
  if (t.includes('open') || t.includes('active') || t === '') return 'open';
  if (t.includes('tp') || t.includes('target')) return 'tp';
  if (t.includes('sl') || t.includes('stop')) return 'sl';
  return 'closed';
}
const STATUS_LABEL = { open: 'Open', tp: 'TP Hit', sl: 'SL Hit', closed: 'Closed' };
const STATUS_BADGE = { open: 'badge-open', tp: 'badge-tp', sl: 'badge-sl', closed: 'badge-closed' };

function buildTrades(file, text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  const lower = headers.map(h => h.toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    col[key] = lower.findIndex(h => aliases.includes(h));
  }
  // Dynamic daily columns: YYYY-MM-DD_MaxProfit / YYYY-MM-DD_MaxLoss
  const dailyCols = [];
  headers.forEach((h, i) => {
    const m = h.match(DAILY_RE);
    if (m) dailyCols.push({ idx: i, date: m[1], kind: m[2].toLowerCase() });
  });
  const signalDate = parseDate(file.name) || parseDate(file.path);
  const trades = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (k) => col[k] >= 0 ? (row[col[k]] || '').trim() : '';
    const symbol = get('symbol');
    if (!symbol) continue;
    const dailyMap = new Map();
    for (const dc of dailyCols) {
      const v = num(row[dc.idx]);
      if (v == null) continue;
      if (!dailyMap.has(dc.date)) dailyMap.set(dc.date, { date: dc.date, maxProfit: null, maxLoss: null });
      dailyMap.get(dc.date)[dc.kind === 'profit' ? 'maxProfit' : 'maxLoss'] = v;
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const statusNorm = normStatus(get('status'));
    const entry = num(get('entry'));
    const exitPrice = num(get('exitPrice'));
    const exitDate = parseDate(get('exitDate'));
    let returnPct = null;
    if (statusNorm !== 'open' && entry && exitPrice != null) returnPct = ((exitPrice - entry) / entry) * 100;
    const holdingDays = statusNorm !== 'open'
      ? (daysBetween(signalDate, exitDate) ?? (daily.length || null))
      : null;
    const daysOpen = statusNorm === 'open' ? daysBetween(signalDate, today()) : null;
    trades.push({
      id: `${file.path}#${r}`, file: file.path, fileName: file.name,
      symbol, entry, sl: num(get('sl')), tp: num(get('tp')),
      status: get('status') || 'Open', statusNorm,
      exitPrice, exitDateRaw: get('exitDate'), exitDate,
      signalDate, signalDateStr: signalDate ? signalDate.toISOString().slice(0, 10) : '\u2013',
      daily, returnPct, holdingDays, daysOpen,
    });
  }
  return trades;
}

/* ================= Global state ================= */
const State = { files: [], trades: [], tradeIndex: new Map(), loaded: false };
const chartRegistry = [];

function fileStats(trades) {
  const s = { total: trades.length, open: 0, closed: 0, tp: 0, sl: 0 };
  for (const t of trades) {
    if (t.statusNorm === 'open') s.open++; else s.closed++;
    if (t.statusNorm === 'tp') s.tp++;
    if (t.statusNorm === 'sl') s.sl++;
  }
  return s;
}

async function loadAll() {
  const progress = $('#load-progress');
  const list = await DataSource.listCsvFiles();
  list.sort((a, b) => (parseDate(b.name)?.getTime() || 0) - (parseDate(a.name)?.getTime() || 0));
  let done = 0;
  const results = await mapLimit(list, CONFIG.concurrency, async (f) => {
    let text = Cache.get(f.path, f.id);
    if (text == null) { text = await DataSource.fetchRaw(f.path); Cache.set(f.path, f.id, text); }
    done++;
    if (progress) progress.textContent = `Loading signal data\u2026 ${done}/${list.length} files`;
    const trades = buildTrades(f, text);
    return { ...f, date: parseDate(f.name), trades, stats: fileStats(trades) };
  });
  State.files = results;
  State.trades = results.flatMap(f => f.trades);
  State.trades.forEach(t => State.tradeIndex.set(t.id, t));
  State.loaded = true;
  if (progress) progress.classList.add('hidden');
}

/* ================= Analytics ================= */
function computeAnalytics() {
  const all = State.trades;
  const open = all.filter(t => t.statusNorm === 'open');
  const closed = all.filter(t => t.statusNorm !== 'open');
  const withReturn = closed.filter(t => t.returnPct != null);
  const wins = withReturn.filter(t => t.statusNorm === 'tp' || t.returnPct > 0);
  const losses = withReturn.filter(t => !(t.statusNorm === 'tp' || t.returnPct > 0));
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const returns = withReturn.map(t => t.returnPct);
  const holds = closed.map(t => t.holdingDays).filter(v => v != null);
  const tpCount = all.filter(t => t.statusNorm === 'tp').length;
  const slCount = all.filter(t => t.statusNorm === 'sl').length;
  // Per-symbol
  const bySymbol = new Map();
  for (const t of all) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { symbol: t.symbol, signals: 0, closed: 0, wins: 0, returns: [] });
    const s = bySymbol.get(t.symbol);
    s.signals++;
    if (t.statusNorm !== 'open') {
      s.closed++;
      if (t.returnPct != null) { s.returns.push(t.returnPct); if (t.statusNorm === 'tp' || t.returnPct > 0) s.wins++; }
    }
  }
  const symbolStats = [...bySymbol.values()].map(s => ({ ...s, winRate: s.closed ? (s.wins / s.closed) * 100 : null, avgReturn: avg(s.returns) }));
  // Risk from daily columns
  const maxDDs = [], maxMPs = [];
  for (const t of all) {
    const losses_ = t.daily.map(d => d.maxLoss).filter(v => v != null);
    const profits_ = t.daily.map(d => d.maxProfit).filter(v => v != null);
    if (losses_.length) maxDDs.push(Math.min(...losses_));
    if (profits_.length) maxMPs.push(Math.max(...profits_));
  }
  const best = withReturn.length ? withReturn.reduce((a, b) => b.returnPct > a.returnPct ? b : a) : null;
  const worst = withReturn.length ? withReturn.reduce((a, b) => b.returnPct < a.returnPct ? b : a) : null;
  // Monthly
  const monthly = new Map();
  for (const t of all) {
    if (!t.signalDate) continue;
    const key = t.signalDateStr.slice(0, 7);
    if (!monthly.has(key)) monthly.set(key, { count: 0, returns: [] });
    const m = monthly.get(key);
    m.count++;
    if (t.returnPct != null) m.returns.push(t.returnPct);
  }
  const months = [...monthly.keys()].sort();
  return {
    all, open, closed, withReturn, wins, losses, tpCount, slCount,
    winRate: withReturn.length ? (wins.length / withReturn.length) * 100 : null,
    lossRate: withReturn.length ? (losses.length / withReturn.length) * 100 : null,
    avgReturn: avg(returns), medianReturn: median(returns),
    avgHold: avg(holds),
    avgReturnPerSymbol: avg(symbolStats.map(s => s.avgReturn).filter(v => v != null)),
    avgMaxDD: avg(maxDDs), avgMaxProfit: avg(maxMPs), best, worst,
    symbolStats, months, monthly,
    latestSignalDate: State.files.length ? State.files[0].name.replace(/\.csv$/i, '') : null,
    ageBuckets: bucketAges(open),
  };
}
function bucketAges(open) {
  const b = { '0\u20135 days': 0, '6\u201310 days': 0, '11\u201320 days': 0, '21+ days': 0 };
  for (const t of open) {
    const d = t.daysOpen ?? 0;
    if (d <= 5) b['0\u20135 days']++; else if (d <= 10) b['6\u201310 days']++; else if (d <= 20) b['11\u201320 days']++; else b['21+ days']++;
  }
  return b;
}

/* ================= Shared rendering ================= */
function tradeRow(t, cols) {
  const cells = cols.map(c => {
    switch (c) {
      case 'symbol': return `<td><strong>${t.statusNorm === 'open' ? '<span class="dot dot-open"></span>' : ''}${esc(t.symbol)}</strong></td>`;
      case 'date': return `<td>${esc(t.signalDateStr)}</td>`;
      case 'entry': return `<td>${fmtNum(t.entry)}</td>`;
      case 'sl': return `<td>${fmtNum(t.sl)}</td>`;
      case 'tp': return `<td>${fmtNum(t.tp)}</td>`;
      case 'status': return `<td><span class="badge ${STATUS_BADGE[t.statusNorm]}">${esc(STATUS_LABEL[t.statusNorm])}</span></td>`;
      case 'exitPrice': return `<td>${fmtNum(t.exitPrice)}</td>`;
      case 'exitDate': return `<td>${esc(t.exitDateRaw || '\u2013')}</td>`;
      case 'return': return `<td class="${pctClass(t.returnPct)}">${fmtPct(t.returnPct)}</td>`;
      case 'daysOpen': return `<td>${t.daysOpen ?? '\u2013'}</td>`;
      case 'latestMP': { const d = t.daily[t.daily.length - 1]; return `<td class="${pctClass(d?.maxProfit)}">${fmtPct(d?.maxProfit)}</td>`; }
      case 'latestML': { const d = t.daily[t.daily.length - 1]; return `<td class="${pctClass(d?.maxLoss)}">${fmtPct(d?.maxLoss)}</td>`; }
      default: return '<td></td>';
    }
  }).join('');
  return `<tr class="${t.statusNorm === 'open' ? 'row-open' : ''}" data-trade="${esc(t.id)}">${cells}</tr>`;
}
const COL_HEAD = { symbol: 'Symbol', date: 'Signal Date', entry: 'Entry', sl: 'SL', tp: 'TP', status: 'Status', exitPrice: 'Exit Price', exitDate: 'Exit Date', return: 'Return', daysOpen: 'Days Open', latestMP: 'Latest Max Profit', latestML: 'Latest Max Loss' };
function tradesTable(trades, cols, sortable = false) {
  if (!trades.length) return `<div class="empty-state"><span class="empty-icon">\u{1F4ED}</span>No trades found</div>`;
  const head = cols.map(c => `<th ${sortable ? `class="sortable" data-sort="${c}"` : ''}>${COL_HEAD[c]}</th>`).join('');
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${trades.map(t => tradeRow(t, cols)).join('')}</tbody></table>`;
}
function sortOpenFirst(trades) {
  return [...trades].sort((a, b) => (a.statusNorm === 'open' ? 0 : 1) - (b.statusNorm === 'open' ? 0 : 1) || (b.signalDate?.getTime() || 0) - (a.signalDate?.getTime() || 0));
}
function attachTradeClicks(root) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('th')) return;
    const tr = e.target.closest('tr[data-trade]');
    if (tr) openTradeModal(tr.dataset.trade);
  });
}
function renderPagination(el, page, totalPages, onPage) {
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  const btn = (label, p, opts = '') => `<button data-page="${p}" ${opts}>${label}</button>`;
  let pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 2) pages.push(p);
  }
  let html = btn('\u2039', page - 1, page === 1 ? 'disabled' : ''), last = 0;
  for (const p of pages) {
    if (p - last > 1) html += `<button disabled>\u2026</button>`;
    html += btn(p, p, p === page ? 'class="current"' : '');
    last = p;
  }
  html += btn('\u203A', page + 1, page === totalPages ? 'disabled' : '');
  el.innerHTML = html;
  el.onclick = (e) => { const b = e.target.closest('button[data-page]'); if (b && !b.disabled) onPage(parseInt(b.dataset.page, 10)); };
}

/* ================= Trade detail modal ================= */
function openTradeModal(id) {
  const t = State.tradeIndex.get(id);
  if (!t) return;
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay'; overlay.id = 'trade-modal';
  const info = [
    ['Signal Date', esc(t.signalDateStr)], ['Entry', fmtNum(t.entry)], ['Stop Loss', fmtNum(t.sl)],
    ['Target', fmtNum(t.tp)], ['Exit Price', fmtNum(t.exitPrice)], ['Exit Date', esc(t.exitDateRaw || '\u2013')],
    ['Return', `<span class="${pctClass(t.returnPct)}">${fmtPct(t.returnPct)}</span>`],
    [t.statusNorm === 'open' ? 'Days Open' : 'Holding Days', t.statusNorm === 'open' ? (t.daysOpen ?? '\u2013') : (t.holdingDays ?? '\u2013')],
  ].map(([l, v]) => `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join('');
  const dailyRows = t.daily.length
    ? t.daily.map(d => `<tr><td>${esc(d.date)}</td><td class="${pctClass(d.maxProfit)}">${fmtPct(d.maxProfit)}</td><td class="${pctClass(d.maxLoss)}">${fmtPct(d.maxLoss)}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty-state">No daily performance data yet</td></tr>`;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${esc(t.symbol)} <span class="badge ${STATUS_BADGE[t.statusNorm]}">${esc(STATUS_LABEL[t.statusNorm])}</span></h3>
        <button class="modal-close" aria-label="Close">\u2715</button>
      </div>
      <div class="modal-body">
        <div class="trade-info-grid">${info}</div>
        <div class="card chart-card"><h4>Daily Max Profit / Max Loss Progression</h4><canvas id="trade-chart"></canvas></div>
        <h4 style="margin-top:1.2rem">Daily Performance</h4>
        <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Daily Max Profit %</th><th>Daily Max Loss %</th></tr></thead><tbody>${dailyRows}</tbody></table></div>
        <p class="muted" style="color:var(--text-2);font-size:.8rem">Source file: <a href="${esc(DataSource.fileUrl(t.file))}" target="_blank" rel="noopener">${esc(t.file)}</a></p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('.modal-close')) closeModal(); });
  document.addEventListener('keydown', escClose);
  if (t.daily.length) {
    makeChart($('#trade-chart'), {
      type: 'line',
      data: { labels: t.daily.map(d => d.date), datasets: [
        { label: 'Max Profit %', data: t.daily.map(d => d.maxProfit), borderColor: cssVar('--green'), backgroundColor: 'transparent', tension: .25, pointRadius: 3 },
        { label: 'Max Loss %', data: t.daily.map(d => d.maxLoss), borderColor: cssVar('--red'), backgroundColor: 'transparent', tension: .25, pointRadius: 3 },
      ]},
      options: baseChartOpts({ interaction: { mode: 'index', intersect: false } }),
    });
  }
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() { $('#trade-modal')?.remove(); document.removeEventListener('keydown', escClose); }

/* ================= Charts ================= */
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function baseChartOpts(extra = {}) {
  const text = cssVar('--text-2'), grid = cssVar('--border');
  return Object.assign({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: text } }, tooltip: { intersect: false } },
    scales: { x: { ticks: { color: text }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } },
  }, extra);
}
function makeChart(canvas, cfg) {
  if (!canvas || typeof Chart === 'undefined') return null;
  const c = new Chart(canvas.getContext('2d'), cfg);
  chartRegistry.push(c);
  return c;
}
function destroyCharts() { chartRegistry.forEach(c => c.destroy()); chartRegistry.length = 0; }

/* ================= Theme ================= */
function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  const btn = $('#theme-toggle');
  const setIcon = () => { btn.innerHTML = document.documentElement.dataset.theme === 'dark' ? '\u2600' : '\u263E'; };
  setIcon();
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setIcon();
    if (State.loaded && Pages.rerenderCharts) { destroyCharts(); Pages.rerenderCharts(); }
  });
}

/* ================= Page: index ================= */
const Pages = { rerenderCharts: null };

function renderIndex() {
  const A = computeAnalytics();
  // 1. KPI grid
  const kpi = (label, value, cls = '', sub = '') => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value ${cls}">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
  $('#kpi-grid').innerHTML = [
    kpi('Total Signals', A.all.length),
    kpi('Open Trades', A.open.length, A.open.length ? 'pos' : ''),
    kpi('Closed Trades', A.closed.length),
    kpi('TP Hits', A.tpCount, 'pos'),
    kpi('SL Hits', A.slCount, 'neg'),
    kpi('Win Rate', A.winRate == null ? '\u2013' : `${A.winRate.toFixed(1)}%`, A.winRate >= 50 ? 'pos' : 'neg'),
    kpi('Avg Return', fmtPct(A.avgReturn), pctClass(A.avgReturn) === 'num-pos' ? 'pos' : (A.avgReturn == null ? '' : 'neg')),
    kpi('Avg Holding Period', A.avgHold == null ? '\u2013' : `${A.avgHold.toFixed(1)} days`),
    kpi('Latest Signal Date', esc(A.latestSignalDate || '\u2013')),
  ].join('');
  // 2. Active summary
  const openSorted = [...A.open].sort((a, b) => (a.signalDate?.getTime() || 0) - (b.signalDate?.getTime() || 0));
  const avgAge = A.open.length ? A.open.reduce((s, t) => s + (t.daysOpen || 0), 0) / A.open.length : null;
  $('#active-summary').innerHTML = [
    kpi('Total Open Trades', A.open.length, 'pos'),
    kpi('Active Symbols', new Set(A.open.map(t => t.symbol)).size),
    kpi('Oldest Open Trade', openSorted.length ? `${esc(openSorted[0].symbol)}` : '\u2013', '', openSorted.length ? `${openSorted[0].signalDateStr} \u00B7 ${openSorted[0].daysOpen}d` : ''),
    kpi('Newest Open Trade', openSorted.length ? `${esc(openSorted[openSorted.length - 1].symbol)}` : '\u2013', '', openSorted.length ? openSorted[openSorted.length - 1].signalDateStr : ''),
    kpi('Avg Age of Open Trades', avgAge == null ? '\u2013' : `${avgAge.toFixed(1)} days`),
  ].join('');
  // 4. Latest trading days (incremental)
  let shownDays = 0;
  const daysEl = $('#latest-days'), moreBtn = $('#load-more-days');
  const renderMoreDays = () => {
    const slice = State.files.slice(shownDays, shownDays + 5);
    for (const f of slice) {
      const card = document.createElement('div');
      card.className = 'day-card';
      card.innerHTML = `
        <div class="day-head">
          <span class="day-date">${esc(f.name.replace(/\.csv$/i, ''))}</span>
          <div class="day-stats">
            <span class="day-stat"><b>${f.stats.total}</b>Signals</span>
            <span class="day-stat"><b class="num-pos">${f.stats.open}</b>Open</span>
            <span class="day-stat"><b>${f.stats.closed}</b>Closed</span>
            <span class="day-stat"><b class="num-pos">${f.stats.tp}</b>TP Hits</span>
            <span class="day-stat"><b class="num-neg">${f.stats.sl}</b>SL Hits</span>
          </div>
          <span class="day-caret">\u25B6</span>
        </div>
        <div class="day-body table-wrap"></div>`;
      card.querySelector('.day-head').addEventListener('click', () => {
        card.classList.toggle('expanded');
        const body = card.querySelector('.day-body');
        if (card.classList.contains('expanded') && !body.dataset.rendered) {
          body.innerHTML = tradesTable(sortOpenFirst(f.trades), ['symbol', 'entry', 'sl', 'tp', 'status', 'exitPrice', 'exitDate']);
          body.dataset.rendered = '1';
        }
      });
      daysEl.appendChild(card);
    }
    shownDays += slice.length;
    moreBtn.classList.toggle('hidden', shownDays >= State.files.length);
  };
  daysEl.innerHTML = '';
  renderMoreDays();
  moreBtn.onclick = renderMoreDays;
  attachTradeClicks(daysEl);
  // 6. Analytics
  const dl = (pairs) => pairs.map(([l, v, cls]) => `<div><dt>${l}</dt><dd class="${cls || ''}">${v}</dd></div>`).join('');
  $('#perf-metrics').innerHTML = dl([
    ['Win Rate', A.winRate == null ? '\u2013' : `${A.winRate.toFixed(1)}%`, 'num-pos'],
    ['Loss Rate', A.lossRate == null ? '\u2013' : `${A.lossRate.toFixed(1)}%`, 'num-neg'],
    ['Average Return', fmtPct(A.avgReturn), pctClass(A.avgReturn)],
    ['Median Return', fmtPct(A.medianReturn), pctClass(A.medianReturn)],
    ['Avg Holding Period', A.avgHold == null ? '\u2013' : `${A.avgHold.toFixed(1)} days`],
    ['Avg Return per Symbol', fmtPct(A.avgReturnPerSymbol), pctClass(A.avgReturnPerSymbol)],
  ]);
  $('#risk-metrics').innerHTML = dl([
    ['Avg Maximum Drawdown', fmtPct(A.avgMaxDD), 'num-neg'],
    ['Avg Maximum Profit', fmtPct(A.avgMaxProfit), 'num-pos'],
    ['Largest Winning Trade', A.best ? `${esc(A.best.symbol)} ${fmtPct(A.best.returnPct)}` : '\u2013', 'num-pos'],
    ['Largest Losing Trade', A.worst ? `${esc(A.worst.symbol)} ${fmtPct(A.worst.returnPct)}` : '\u2013', 'num-neg'],
  ]);
  $('#strategy-metrics').innerHTML = dl([
    ['Total Trades', A.all.length],
    ['Closed Trades', A.closed.length],
    ['Open Trades', A.open.length],
    ['TP Hit %', A.closed.length ? `${(A.tpCount / A.closed.length * 100).toFixed(1)}%` : '\u2013', 'num-pos'],
    ['SL Hit %', A.closed.length ? `${(A.slCount / A.closed.length * 100).toFixed(1)}%` : '\u2013', 'num-neg'],
  ]);
  // 7. Leaderboards
  const sorted = [...A.withReturn].sort((a, b) => b.returnPct - a.returnPct);
  $('#lb-best').innerHTML = tradesTable(sorted.slice(0, 20), ['symbol', 'date', 'return', 'status']);
  $('#lb-worst').innerHTML = tradesTable([...sorted].reverse().slice(0, 20), ['symbol', 'date', 'return', 'status']);
  const symRanked = A.symbolStats.filter(s => s.closed > 0).sort((a, b) => (b.winRate - a.winRate) || (b.avgReturn ?? -1e9) - (a.avgReturn ?? -1e9)).slice(0, 20);
  $('#lb-symbols').innerHTML = symRanked.length ? `<table class="data"><thead><tr><th>Symbol</th><th>Win Rate</th><th>Avg Return</th><th>Closed</th></tr></thead><tbody>${symRanked.map(s => `<tr><td><strong>${esc(s.symbol)}</strong></td><td class="num-pos">${s.winRate.toFixed(1)}%</td><td class="${pctClass(s.avgReturn)}">${fmtPct(s.avgReturn)}</td><td>${s.closed}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state">No closed trades yet</div>`;
  const active = [...A.symbolStats].sort((a, b) => b.signals - a.signals).slice(0, 20);
  $('#lb-active').innerHTML = active.length ? `<table class="data"><thead><tr><th>Symbol</th><th>Signals</th></tr></thead><tbody>${active.map(s => `<tr><td><strong>${esc(s.symbol)}</strong></td><td>${s.signals}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state">No data</div>`;
  attachTradeClicks($('#leaderboard-section'));
  // 8. Recent activity
  $('#act-latest-files').innerHTML = State.files.slice(0, 6).map(f => `<li><a href="${esc(DataSource.fileUrl(f.path))}" target="_blank" rel="noopener">${esc(f.name)}</a><span class="muted">${f.stats.total} signals \u00B7 ${f.stats.open} open</span></li>`).join('') || '<li class="empty-state">No CSV files found</li>';
  DataSource.recentCommits(8).then(commits => {
    $('#act-commits').innerHTML = commits.length
      ? commits.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a><span class="muted">${esc((c.date || '').slice(0, 10))}</span></li>`).join('')
      : '<li class="empty-state">Commit history unavailable</li>';
  });
  const recentClosed = A.closed.filter(t => t.exitDate).sort((a, b) => b.exitDate - a.exitDate).slice(0, 6);
  $('#act-closed').innerHTML = recentClosed.length
    ? recentClosed.map(t => `<li><span><strong>${esc(t.symbol)}</strong> <span class="badge ${STATUS_BADGE[t.statusNorm]}">${esc(STATUS_LABEL[t.statusNorm])}</span></span><span class="muted ${pctClass(t.returnPct)}">${fmtPct(t.returnPct)} \u00B7 ${esc(t.exitDateRaw)}</span></li>`).join('')
    : '<li class="empty-state">No closed trades yet</li>';
  // 3 + 5. Charts
  const renderCharts = () => {
    const green = cssVar('--green'), red = cssVar('--red'), accent = cssVar('--accent'), amber = cssVar('--amber');
    makeChart($('#chart-age'), { type: 'bar', data: { labels: Object.keys(A.ageBuckets), datasets: [{ label: 'Open trades', data: Object.values(A.ageBuckets), backgroundColor: accent, borderRadius: 6 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    makeChart($('#chart-winloss'), { type: 'doughnut', data: { labels: ['Wins', 'Losses'], datasets: [{ data: [A.wins.length, A.losses.length], backgroundColor: [green, red], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: cssVar('--text-2') } } } } });
    const mTotals = A.months.map(m => A.monthly.get(m).returns.reduce((a, b) => a + b, 0));
    const mCounts = A.months.map(m => A.monthly.get(m).count);
    const mAvgs = A.months.map(m => { const r = A.monthly.get(m).returns; return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0; });
    makeChart($('#chart-monthly'), { type: 'bar', data: { labels: A.months, datasets: [{ label: 'Total return %', data: mTotals, backgroundColor: mTotals.map(v => v >= 0 ? green : red), borderRadius: 6 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    makeChart($('#chart-count-month'), { type: 'bar', data: { labels: A.months, datasets: [{ label: 'Signals', data: mCounts, backgroundColor: accent, borderRadius: 6 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    makeChart($('#chart-avg-month'), { type: 'line', data: { labels: A.months, datasets: [{ label: 'Avg return %', data: mAvgs, borderColor: amber, backgroundColor: 'transparent', tension: .25 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    makeChart($('#chart-duration'), { type: 'bar', data: { labels: Object.keys(A.ageBuckets), datasets: [{ label: 'Open trades', data: Object.values(A.ageBuckets), backgroundColor: amber, borderRadius: 6 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    // Avg daily drawdown / max profit across open trades by calendar date
    const byDate = new Map();
    for (const t of A.open) for (const d of t.daily) {
      if (!byDate.has(d.date)) byDate.set(d.date, { losses: [], profits: [] });
      if (d.maxLoss != null) byDate.get(d.date).losses.push(d.maxLoss);
      if (d.maxProfit != null) byDate.get(d.date).profits.push(d.maxProfit);
    }
    const dates = [...byDate.keys()].sort().slice(-30);
    const avgOf = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    makeChart($('#chart-daily-loss'), { type: 'line', data: { labels: dates, datasets: [{ label: 'Avg Max Loss %', data: dates.map(d => avgOf(byDate.get(d).losses)), borderColor: red, backgroundColor: 'transparent', tension: .25 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
    makeChart($('#chart-daily-profit'), { type: 'line', data: { labels: dates, datasets: [{ label: 'Avg Max Profit %', data: dates.map(d => avgOf(byDate.get(d).profits)), borderColor: green, backgroundColor: 'transparent', tension: .25 }] }, options: baseChartOpts({ plugins: { legend: { display: false } } }) });
  };
  renderCharts();
  Pages.rerenderCharts = renderCharts;
}

/* ================= Page: active signals ================= */
function renderActive() {
  const all = sortOpenFirst(State.trades.filter(t => t.statusNorm === 'open'));
  $('#active-count-badge').textContent = `${all.length} open`;
  const cols = ['symbol', 'date', 'entry', 'sl', 'tp', 'daysOpen', 'latestMP', 'latestML'];
  const sortKeys = {
    symbol: t => t.symbol, date: t => t.signalDate?.getTime() || 0, entry: t => t.entry ?? -1e18,
    sl: t => t.sl ?? -1e18, tp: t => t.tp ?? -1e18, daysOpen: t => t.daysOpen ?? -1,
    latestMP: t => t.daily[t.daily.length - 1]?.maxProfit ?? -1e18, latestML: t => t.daily[t.daily.length - 1]?.maxLoss ?? -1e18,
  };
  let state = { q: '', page: 1, pageSize: 25, sort: null, dir: 1 };
  const tableEl = $('#active-table'), pagEl = $('#active-pagination');
  const filtered = () => {
    let rows = all;
    if (state.q) {
      const q = state.q.toLowerCase();
      rows = rows.filter(t => t.symbol.toLowerCase().includes(q) || t.signalDateStr.includes(q) || STATUS_LABEL[t.statusNorm].toLowerCase().includes(q));
    }
    if (state.sort) {
      const k = sortKeys[state.sort];
      rows = [...rows].sort((a, b) => { const x = k(a), y = k(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    }
    return rows;
  };
  const render = () => {
    const rows = filtered();
    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(state.page, totalPages);
    const slice = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    tableEl.innerHTML = tradesTable(slice, cols, true);
    renderPagination(pagEl, state.page, totalPages, p => { state.page = p; render(); });
  };
  $('#active-search').addEventListener('input', e => { state.q = e.target.value.trim(); state.page = 1; render(); });
  $('#active-page-size').addEventListener('change', e => { state.pageSize = parseInt(e.target.value, 10); state.page = 1; render(); });
  tableEl.addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = 1; }
    render();
  });
  $('#active-export').addEventListener('click', () => {
    const rows = filtered();
    const header = ['Symbol', 'Signal Date', 'Entry', 'SL', 'TP', 'Days Open', 'Latest Max Profit', 'Latest Max Loss'];
    const csv = [header.join(',')].concat(rows.map(t => {
      const d = t.daily[t.daily.length - 1];
      return [t.symbol, t.signalDateStr, t.entry ?? '', t.sl ?? '', t.tp ?? '', t.daysOpen ?? '', d?.maxProfit ?? '', d?.maxLoss ?? '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    })).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `active-signals-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  attachTradeClicks(tableEl);
  render();
}

/* ================= Page: signals browser ================= */
function renderSignals() {
  let state = { q: '', sort: 'desc', openOnly: false, page: 1, pageSize: 10 };
  const listEl = $('#signals-list'), pagEl = $('#signals-pagination');
  const filtered = () => {
    let files = State.files;
    if (state.q) files = files.filter(f => f.name.includes(state.q));
    if (state.openOnly) files = files.filter(f => f.stats.open > 0);
    files = [...files].sort((a, b) => state.sort === 'desc'
      ? (b.date?.getTime() || 0) - (a.date?.getTime() || 0)
      : (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
    return files;
  };
  const render = () => {
    const files = filtered();
    const totalPages = Math.max(1, Math.ceil(files.length / state.pageSize));
    state.page = Math.min(state.page, totalPages);
    const slice = files.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    listEl.innerHTML = '';
    if (!slice.length) {
      listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">\u{1F4ED}</span>No signal files match your filters</div>`;
    }
    for (const f of slice) {
      const card = document.createElement('div');
      card.className = 'day-card';
      card.innerHTML = `
        <div class="day-head">
          <span class="day-date">${esc(f.name.replace(/\.csv$/i, ''))}</span>
          <div class="day-stats">
            <span class="day-stat"><b>${f.stats.total}</b>Trades</span>
            <span class="day-stat"><b class="num-pos">${f.stats.open}</b>Open</span>
            <span class="day-stat"><b>${f.stats.closed}</b>Closed</span>
            <span class="day-stat"><b class="num-pos">${f.stats.tp}</b>TP Hits</span>
            <span class="day-stat"><b class="num-neg">${f.stats.sl}</b>SL Hits</span>
          </div>
          ${f.stats.open ? '<span class="badge badge-open">live</span>' : ''}
          <span class="day-caret">\u25B6</span>
        </div>
        <div class="day-body table-wrap"></div>`;
      card.querySelector('.day-head').addEventListener('click', () => {
        card.classList.toggle('expanded');
        const body = card.querySelector('.day-body');
        if (card.classList.contains('expanded') && !body.dataset.rendered) {
          body.innerHTML = tradesTable(sortOpenFirst(f.trades), ['symbol', 'entry', 'sl', 'tp', 'status', 'exitPrice', 'exitDate']);
          body.dataset.rendered = '1';
        }
      });
      listEl.appendChild(card);
    }
    renderPagination(pagEl, state.page, totalPages, p => { state.page = p; render(); });
  };
  $('#signals-search').addEventListener('input', e => { state.q = e.target.value.trim(); state.page = 1; render(); });
  $('#signals-sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
  $('#signals-open-only').addEventListener('change', e => { state.openOnly = e.target.checked; state.page = 1; render(); });
  attachTradeClicks(listEl);
  render();
}

/* ================= Boot ================= */
async function boot() {
  initTheme();
  const repoLink = $('#repo-link');
  if (repoLink) repoLink.href = DataSource.repoUrl();
  try {
    await loadAll();
    const refresh = $('#last-refresh');
    if (refresh) refresh.textContent = `Last refresh: ${new Date().toLocaleString()}`;
    if (!State.files.length) {
      const err = $('#app-error');
      err.textContent = 'No CSV signal files found in the repository yet. Add files named YYYY-MM-DD.csv to get started.';
      err.classList.remove('hidden');
      document.querySelectorAll('.skeleton').forEach(el => el.remove());
      return;
    }
    const page = document.body.dataset.page;
    if (page === 'index') renderIndex();
    else if (page === 'active') renderActive();
    else if (page === 'signals') renderSignals();
  } catch (e) {
    console.error(e);
    const err = $('#app-error');
    err.textContent = `Failed to load signal data: ${e.message}. Check that the repository is public and the CONFIG settings in app.js are correct.`;
    err.classList.remove('hidden');
    $('#load-progress')?.classList.add('hidden');
  }
}
document.addEventListener('DOMContentLoaded', boot);
})();
