/* Pulse analytics dashboard. Vanilla JS, no build step, no external requests. */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const SVG_NS = 'http://www.w3.org/2000/svg';

const RANGES = ['24h', '7d', '30d', '90d'];

const numberFmt = new Intl.NumberFormat();
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const hourTickFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });
const dayTickFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hourFullFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const dayFullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const savedFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const DEVICE_COLORS = ['#3ce3a4', '#7b93ff', '#f2b866', '#e879f9'];

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch (err) {
    return null;
  }
})();

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* ignore */ }
  },
};

const state = {
  sites: [],
  site: null,
  range: RANGES.includes(storage.get('pulse.range')) ? storage.get('pulse.range') : '30d',
  theme: storage.get('pulse.theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  stats: null,
  live: null,
  auth: false,
  loading: false,
  loginVisible: false,
  timers: [],
  lastLoad: 0,
  editorEnabled: false,
};

const editor = {
  open: false,
  loaded: false,
  pages: [],
  filter: '',
  root: '',
  current: null,
  meta: null,
  dirty: false,
  source: false,
  saving: false,
  ready: false,
};

/* ---------------- helpers ---------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function num(value) {
  return numberFmt.format(Math.round(Number(value) || 0));
}

function compact(value) {
  return compactFmt.format(Number(value) || 0);
}

function pct(value) {
  return pctFmt.format(Number(value) || 0);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function countryName(code) {
  if (!code) return 'Unknown';
  try {
    return regionNames?.of(code) || code;
  } catch (err) {
    return code;
  }
}

function hueFor(text) {
  let hue = 0;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) hue = (hue * 31 + value.charCodeAt(i)) % 360;
  return hue;
}

function pctChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

function deltaHtml(value, { invert = false, points = false } = {}) {
  if (value === null || !Number.isFinite(value)) {
    return '<span class="delta flat" title="No data for the previous period">—</span>';
  }
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const good = invert ? rounded < 0 : rounded > 0;
  const cls = rounded === 0 ? 'flat' : good ? 'good' : 'bad';
  const arrow = rounded > 0 ? '↑' : rounded < 0 ? '↓' : '→';
  const amount = points ? `${Math.abs(rounded).toFixed(1)} pp` : `${Math.abs(rounded).toFixed(1)}%`;
  return `<span class="delta ${cls}">${arrow} ${amount}</span>`;
}

function emptyRow(message) {
  return `<div class="empty-row">${message}</div>`;
}

function sparkline(values, className) {
  if (!values || values.length < 2) return '';
  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(26 - (value / max) * 23).toFixed(1)}`).join(' ');
  return `<svg class="spark ${className}" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

function toast(message, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setStatus(text) {
  const el = $('#updated');
  if (el) el.textContent = text;
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  storage.set('pulse.theme', state.theme);
}

/* ---------------- API ---------------- */

async function api(pathname, options = {}) {
  const response = await fetch(pathname, { credentials: 'same-origin', ...options });
  if (response.status === 401) {
    showLogin();
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (err) { /* not JSON */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/* ---------------- boot ---------------- */

async function boot() {
  stopPolling();
  setStatus('Connecting…');
  try {
    const meta = await api('/api/v1/sites');
    state.sites = meta.sites || [];
    state.auth = Boolean(meta.auth);
    state.editorEnabled = Boolean(meta.editor);
    hideLogin();

    const editorButton = $('#editor-btn');
    if (editorButton) editorButton.classList.toggle('hidden', !state.editorEnabled);
    if (!state.editorEnabled) editor.loaded = false;

    const versionLabel = $('#version-label');
    if (versionLabel) versionLabel.textContent = `Pulse v${meta.version || ''}`.trim();
    const logout = $('#logout-link');
    if (logout) logout.classList.toggle('hidden', !state.auth);
    const openNote = $('#open-mode-note');
    if (openNote) {
      openNote.textContent = state.auth ? '' : 'Open mode — set ADMIN_TOKEN before exposing this server.';
    }

    if (state.sites.length === 0) {
      setStatus('No sites configured');
      toast('Add a site to sites.json to start collecting.', true);
      return;
    }

    const saved = storage.get('pulse.site');
    state.site = state.sites.some((site) => site.id === saved) ? saved : state.sites[0].id;
    renderSiteOptions();
    syncRangeButtons();
    startPolling();
    await loadAll();
  } catch (err) {
    if (err.status !== 401) {
      setStatus('Offline');
      toast(err.message || 'Could not reach the server', true);
    }
  }
}

function renderSiteOptions() {
  const select = $('#site-select');
  if (!select) return;
  select.innerHTML = state.sites
    .map((site) => `<option value="${esc(site.id)}"${site.id === state.site ? ' selected' : ''}>${esc(site.name)}</option>`)
    .join('');
  select.disabled = state.sites.length < 2;
}

function syncRangeButtons() {
  $$('#range-control button').forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function loadAll() {
  if (!state.site || state.loading) return;
  state.loading = true;
  $('#refresh-btn')?.classList.add('loading');
  try {
    const query = `site=${encodeURIComponent(state.site)}&range=${encodeURIComponent(state.range)}`;
    const [stats, live] = await Promise.all([
      api(`/api/v1/stats?${query}`),
      api(`/api/v1/live?site=${encodeURIComponent(state.site)}`),
    ]);
    state.stats = stats;
    state.live = live;
    state.lastLoad = Date.now();
    renderAll();
    setStatus(`Updated ${clockFmt.format(new Date(stats.generatedAt))}`);
    hideEmptyError();
  } catch (err) {
    if (err.status !== 401) {
      setStatus('Update failed');
      toast(err.message || 'Could not load statistics', true);
    }
  } finally {
    state.loading = false;
    $('#refresh-btn')?.classList.remove('loading');
  }
}

async function refreshLive() {
  if (!state.site || document.hidden) return;
  try {
    state.live = await api(`/api/v1/live?site=${encodeURIComponent(state.site)}`);
    renderLive();
    renderLivePill();
  } catch (err) {
    if (err.status === 401) stopPolling();
  }
}

function startPolling() {
  stopPolling();
  state.timers.push(setInterval(() => { if (!document.hidden) refreshLive(); }, 5000));
  state.timers.push(setInterval(() => { if (!document.hidden) loadAll(); }, 20000));
}

function stopPolling() {
  state.timers.forEach((timer) => clearInterval(timer));
  state.timers = [];
}

/* ---------------- rendering ---------------- */

function renderAll() {
  if (!state.stats) return;
  const stats = state.stats;
  $('#site-name').textContent = stats.site.name;
  document.title = `${stats.site.name} · Pulse`;

  const domain = $('#site-domain');
  if (domain) {
    if (stats.site.domain) {
      domain.textContent = stats.site.domain;
      domain.href = `https://${stats.site.domain}`;
      domain.classList.remove('hidden');
    } else {
      domain.classList.add('hidden');
    }
  }

  const exportLink = $('#export-btn');
  if (exportLink) {
    exportLink.href = `/api/v1/export?site=${encodeURIComponent(state.site)}&range=${encodeURIComponent(state.range)}&dataset=pages`;
  }

  const empty = stats.totals.pageviews === 0;
  $('#empty-state').classList.toggle('hidden', !empty);
  if (empty) {
    const snippet = `<script defer src="${location.origin}/t.js" data-site="${stats.site.id}"></script>`;
    const code = $('#snippet-code');
    if (code) code.textContent = snippet;
  }

  renderRangeNote();
  renderKpis();
  renderChart();
  renderPages();
  renderSources();
  renderDevices();
  renderCountries();
  renderEvents();
  renderBrowsers();
  renderLivePill();
  renderLive();
}

function renderRangeNote() {
  const stats = state.stats;
  const range = stats.range;
  const note = $('#range-note');
  if (!note) return;
  const fmt = range.interval === 'hour' ? hourFullFmt : dayFullFmt;
  const from = fmt.format(new Date(range.from));
  const to = fmt.format(new Date(range.to - 1));
  const previous = `${shortDateFmt.format(new Date(range.previous.from))} – ${shortDateFmt.format(new Date(range.previous.to - 1))}`;
  note.textContent = `${from} → ${to} UTC · vs ${previous}`;
  const sub = $('#chart-sub');
  if (sub) {
    sub.textContent = `Visitors and pageviews · ${range.interval === 'hour' ? 'hourly' : 'daily'} UTC buckets`;
  }
}

function renderKpis() {
  const container = $('#kpis');
  if (!container) return;
  const { totals, previousTotals, series } = state.stats;

  const visitorsSpark = sparkline(series.map((row) => row.visitors), 'spark-visitors');
  const viewsSpark = sparkline(series.map((row) => row.pageviews), 'spark-views');

  const cards = [
    {
      label: 'Unique visitors',
      value: num(totals.visitors),
      delta: deltaHtml(pctChange(totals.visitors, previousTotals.visitors)),
      hint: `${num(totals.sessions)} sessions`,
      spark: visitorsSpark,
    },
    {
      label: 'Pageviews',
      value: num(totals.pageviews),
      delta: deltaHtml(pctChange(totals.pageviews, previousTotals.pageviews)),
      hint: `${num(totals.visitors)} visitors`,
      spark: viewsSpark,
    },
    {
      label: 'Bounce rate',
      value: pct(totals.bounceRate),
      delta: deltaHtml((totals.bounceRate - previousTotals.bounceRate) * 100, { invert: true, points: true }),
      hint: `${num(Math.round(totals.bounceRate * totals.sessions))} bounces`,
    },
    {
      label: 'Avg. visit',
      value: formatDuration(totals.visitDuration),
      delta: deltaHtml(pctChange(totals.visitDuration, previousTotals.visitDuration)),
      hint: 'session duration',
    },
    {
      label: 'Views / visit',
      value: (Number(totals.viewsPerVisit) || 0).toFixed(1),
      delta: deltaHtml(pctChange(totals.viewsPerVisit, previousTotals.viewsPerVisit)),
      hint: 'pages per session',
    },
  ];

  container.innerHTML = cards
    .map(
      (card) => `
      <article class="kpi">
        ${card.spark || ''}
        <div class="kpi-label">${esc(card.label)}</div>
        <div class="kpi-value">${esc(card.value)}</div>
        <div class="kpi-foot">
          ${card.delta}
          <span>vs previous</span>
          <span class="kpi-hint">${esc(card.hint)}</span>
        </div>
      </article>`,
    )
    .join('');
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 4;
  const rough = value / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return step * 4;
}

function linePath(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
}

function renderChart() {
  const wrap = $('#chart');
  if (!wrap || !state.stats) return;
  const series = state.stats.series || [];
  const totalViews = series.reduce((sum, row) => sum + row.pageviews, 0);

  if (series.length === 0 || totalViews === 0) {
    wrap.innerHTML = '<div class="chart-empty">No traffic recorded in this range yet.<br>Stats appear as soon as your first page is viewed.</div>';
    return;
  }

  const width = Math.max(260, wrap.clientWidth || 640);
  const height = Math.max(200, wrap.clientHeight || 288);
  const pad = { top: 14, right: 14, bottom: 26, left: 42 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const step = series.length > 1 ? innerW / (series.length - 1) : innerW;
  const maxValue = niceMax(Math.max(1, ...series.map((row) => Math.max(row.visitors, row.pageviews))));
  const x = (index) => pad.left + (series.length === 1 ? innerW / 2 : index * step);
  const y = (value) => pad.top + innerH - (Math.min(value, maxValue) / maxValue) * innerH;
  const baseline = pad.top + innerH;

  const viewsPoints = series.map((row, index) => [x(index), y(row.pageviews)]);
  const visitorPoints = series.map((row, index) => [x(index), y(row.visitors)]);
  const areaPath = `${linePath(viewsPoints)} L${x(series.length - 1).toFixed(1)},${baseline.toFixed(1)} L${x(0).toFixed(1)},${baseline.toFixed(1)} Z`;

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="Visitors and pageviews over time">`);
  parts.push(
    '<defs><linearGradient id="pulseViewsGradient" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--accent-2)" stop-opacity="0.32"/>' +
      '<stop offset="100%" stop-color="var(--accent-2)" stop-opacity="0"/>' +
      '</linearGradient></defs>',
  );

  for (let i = 0; i <= 4; i += 1) {
    const value = (maxValue / 4) * i;
    const lineY = y(value);
    parts.push(`<line x1="${pad.left}" y1="${lineY.toFixed(1)}" x2="${(pad.left + innerW).toFixed(1)}" y2="${lineY.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"${i === 0 ? '' : ' stroke-dasharray="3 5"'} />`);
    parts.push(`<text x="${pad.left - 8}" y="${(lineY + 3.5).toFixed(1)}" text-anchor="end" fill="var(--dim)" font-size="10.5" font-family="inherit">${esc(compact(value))}</text>`);
  }

  const tickCount = Math.min(6, series.length);
  const indices = [];
  for (let i = 0; i < tickCount; i += 1) {
    const index = Math.round((i * (series.length - 1)) / Math.max(1, tickCount - 1));
    if (!indices.includes(index)) indices.push(index);
  }
  const tickFmt = state.stats.range.interval === 'hour' ? hourTickFmt : dayTickFmt;
  indices.forEach((index, position) => {
    const anchor = position === 0 ? 'start' : position === indices.length - 1 ? 'end' : 'middle';
    const label = tickFmt.format(new Date(series[index].t));
    parts.push(`<text x="${x(index).toFixed(1)}" y="${(height - 7).toFixed(1)}" text-anchor="${anchor}" fill="var(--dim)" font-size="10.5" font-family="inherit">${esc(label)}</text>`);
  });

  parts.push(`<path d="${areaPath}" fill="url(#pulseViewsGradient)" />`);
  parts.push(`<path d="${linePath(viewsPoints)}" fill="none" stroke="var(--accent-2)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />`);
  parts.push(`<path d="${linePath(visitorPoints)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`);

  parts.push(`<line id="chart-guide" x1="0" y1="${pad.top}" x2="0" y2="${baseline}" stroke="var(--line)" stroke-width="1" opacity="0" />`);
  parts.push(`<circle id="chart-dot-views" r="3.5" fill="var(--panel)" stroke="var(--accent-2)" stroke-width="2" opacity="0" />`);
  parts.push(`<circle id="chart-dot-visitors" r="3.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="2" opacity="0" />`);
  parts.push(`<rect id="chart-hover" x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor:crosshair" />`);
  parts.push('</svg>');

  wrap.innerHTML = parts.join('');

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  wrap.appendChild(tip);

  const svg = wrap.querySelector('svg');
  const hover = wrap.querySelector('#chart-hover');
  const guide = wrap.querySelector('#chart-guide');
  const dotViews = wrap.querySelector('#chart-dot-views');
  const dotVisitors = wrap.querySelector('#chart-dot-visitors');
  if (!svg || !hover) return;

  const fullFmt = state.stats.range.interval === 'hour' ? hourFullFmt : dayFullFmt;

  function hide() {
    guide?.setAttribute('opacity', '0');
    dotViews?.setAttribute('opacity', '0');
    dotVisitors?.setAttribute('opacity', '0');
    tip.classList.remove('visible');
  }

  function move(event) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const scale = width / rect.width;
    const localX = (event.clientX - rect.left) * scale;
    let index = Math.round((localX - pad.left) / (step || 1));
    index = Math.max(0, Math.min(series.length - 1, index));
    const px = x(index);
    const row = series[index];

    guide?.setAttribute('x1', px.toFixed(1));
    guide?.setAttribute('x2', px.toFixed(1));
    guide?.setAttribute('opacity', '1');
    dotViews?.setAttribute('cx', px.toFixed(1));
    dotViews?.setAttribute('cy', y(row.pageviews).toFixed(1));
    dotViews?.setAttribute('opacity', '1');
    dotVisitors?.setAttribute('cx', px.toFixed(1));
    dotVisitors?.setAttribute('cy', y(row.visitors).toFixed(1));
    dotVisitors?.setAttribute('opacity', '1');

    tip.innerHTML =
      `<div class="tip-date">${esc(fullFmt.format(new Date(row.t)))}</div>` +
      `<div class="tip-row"><i class="tip-dot" style="background:var(--accent)"></i>Visitors<b>${num(row.visitors)}</b></div>` +
      `<div class="tip-row"><i class="tip-dot" style="background:var(--accent-2)"></i>Pageviews<b>${num(row.pageviews)}</b></div>`;
    tip.classList.add('visible');

    const cssX = px / scale;
    const tooltipWidth = tip.offsetWidth || 140;
    const left = Math.min(Math.max(8, cssX + 12), wrap.clientWidth - tooltipWidth - 8);
    tip.style.left = `${left}px`;
  }

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', hide);
}

function renderPages() {
  const body = $('#pages-body');
  if (!body) return;
  const rows = state.stats.topPages.slice(0, 8);
  const tag = $('#pages-tag');
  if (tag) tag.textContent = `${num(state.stats.totals.pageviews)} views`;

  if (rows.length === 0) {
    body.innerHTML = emptyRow('No pageviews yet. Once the tracker is live, your top pages show up here.');
    return;
  }

  const max = rows[0].share || 1;
  body.innerHTML =
    '<div class="table-head"><span>Page</span><span>Views</span><span>Visitors</span></div>' +
    rows
      .map(
        (row) => `
        <div class="table-row">
          <span class="name" title="${esc(row.path)}"><span>${esc(row.path === '/' ? 'Home' : row.path)}</span></span>
          <span class="num strong">${num(row.pageviews)}</span>
          <span class="num">${num(row.visitors)}</span>
          <span class="row-bar" style="--w:${Math.max(2, (row.share / max) * 100).toFixed(1)}%"></span>
        </div>`,
      )
      .join('');
}

function renderSources() {
  const body = $('#sources-body');
  if (!body) return;
  const rows = state.stats.sources.slice(0, 8);
  const tag = $('#sources-tag');
  if (tag) tag.textContent = `${num(state.stats.totals.visitors)} visitors`;

  if (rows.length === 0) {
    body.innerHTML = emptyRow('No referrers recorded yet.');
    return;
  }

  const max = rows[0].visitors || 1;
  body.innerHTML =
    '<div class="table-head cols-2"><span>Source</span><span>Visitors</span></div>' +
    rows
      .map((row) => {
        const color = `hsl(${hueFor(row.name)} 68% 62%)`;
        return `
        <div class="table-row cols-2">
          <span class="name" title="${esc(row.name)}">
            <i class="source-dot" style="--c:${color}"></i>
            <span>${esc(row.name)}</span>
          </span>
          <span class="num strong">${num(row.visitors)}</span>
          <span class="row-bar" style="--w:${Math.max(2, (row.visitors / max) * 100).toFixed(1)}%"></span>
        </div>`;
      })
      .join('');
}

function renderDevices() {
  const body = $('#devices-body');
  if (!body) return;
  const rows = state.stats.devices;
  if (!rows.length) {
    body.innerHTML = emptyRow('No device data yet.');
    return;
  }

  let angle = 0;
  const stops = [];
  rows.forEach((row, index) => {
    const start = angle;
    angle += row.share * 360;
    stops.push(`${DEVICE_COLORS[index % DEVICE_COLORS.length]} ${start.toFixed(2)}deg ${angle.toFixed(2)}deg`);
  });
  const background = `conic-gradient(${stops.join(', ')})`;
  const top = rows[0];

  body.innerHTML = `
    <div class="donut-wrap">
      <div class="donut" style="background:${background}" role="img" aria-label="Device share">
        <div class="donut-center"><strong>${esc(pct(top.share))}</strong><span>${esc(top.name)}</span></div>
      </div>
      <ul class="legend-list">
        ${rows
          .map(
            (row, index) => `
          <li>
            <i class="swatch" style="background:${DEVICE_COLORS[index % DEVICE_COLORS.length]}"></i>
            <span class="lg-name">${esc(row.name)}</span>
            <span class="lg-val">${esc(pct(row.share))}</span>
            <span class="lg-pct">${num(row.visitors)}</span>
          </li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

function renderCountries() {
  const body = $('#countries-body');
  if (!body) return;
  const rows = state.stats.countries.slice(0, 7);
  if (!rows.length) {
    body.innerHTML = emptyRow(
      'No location data.<br>Forward a geo header such as <code>CF-IPCountry</code> and set <code>TRUST_PROXY=1</code>.',
    );
    return;
  }

  const max = rows[0].visitors || 1;
  body.innerHTML =
    '<div class="table-head cols-2"><span>Country</span><span>Visitors</span></div>' +
    rows
      .map(
        (row) => `
      <div class="table-row cols-2">
        <span class="name" title="${esc(countryName(row.name))}">
          <span class="country-badge">${esc(row.name)}</span>
          <span>${esc(countryName(row.name))}</span>
        </span>
        <span class="num strong">${num(row.visitors)}</span>
        <span class="row-bar" style="--w:${Math.max(2, (row.visitors / max) * 100).toFixed(1)}%"></span>
      </div>`,
      )
      .join('');
}

function renderEvents() {
  const body = $('#events-body');
  if (!body) return;
  const rows = state.stats.events;
  const tag = $('#events-tag');
  if (tag) tag.textContent = `${num(state.stats.totals.events)} tracked`;

  if (!rows.length) {
    body.innerHTML = emptyRow(
      'No custom events yet.<br>Call <code>pulse.track(\'signup\', { plan: \'pro\' })</code> from your site.',
    );
    return;
  }

  const max = rows[0].count || 1;
  const bars = rows
    .map(
      (row) => `
      <div class="bar-item">
        <div class="bar-label"><span>${esc(row.name)}</span><b>${num(row.count)}</b></div>
        <div class="bar-track"><span style="--w:${Math.max(2, (row.count / max) * 100).toFixed(1)}%"></span></div>
      </div>`,
    )
    .join('');

  const outbound = state.stats.outboundLinks || [];
  const chips = outbound.length
    ? `<div class="os-chips">${outbound
        .map((row) => `<span class="chip">${esc(row.name)}<b>${num(row.count)}</b></span>`)
        .join('')}</div>`
    : '';

  body.innerHTML = `<div class="bar-list">${bars}</div>${chips}`;
}

function renderBrowsers() {
  const body = $('#browsers-body');
  if (!body) return;
  const rows = state.stats.browsers || [];
  const oses = state.stats.os || [];

  if (!rows.length) {
    body.innerHTML = emptyRow('No browser data yet.');
    return;
  }

  const max = rows[0].visitors || 1;
  const bars = rows
    .map(
      (row) => `
      <div class="bar-item">
        <div class="bar-label"><span>${esc(row.name)}</span><b>${num(row.visitors)}</b></div>
        <div class="bar-track"><span style="--w:${Math.max(2, (row.visitors / max) * 100).toFixed(1)}%"></span></div>
      </div>`,
    )
    .join('');

  const chips = oses.length
    ? `<div class="os-chips">${oses
        .map((row) => `<span class="chip">${esc(row.name)}<b>${esc(pct(row.share))}</b></span>`)
        .join('')}</div>`
    : '';

  body.innerHTML = `<div class="bar-list">${bars}</div>${chips}`;
}

function renderLivePill() {
  const count = state.live ? state.live.active : 0;
  const el = $('#live-count');
  if (el) el.textContent = String(count);
  const pill = $('#live-pill');
  if (pill) {
    pill.title = `${count} visitor${count === 1 ? '' : 's'} active in the last ${state.live?.windowSeconds ? Math.round(state.live.windowSeconds / 60) : 5} minutes`;
  }
}

function renderLive() {
  const body = $('#live-body');
  if (!body) return;
  if (!state.live) {
    body.innerHTML = '<div class="skeleton skeleton-block"></div>';
    return;
  }

  const feed = (state.live.recent || []).filter((event) => event.type !== 'duration').slice(0, 8);
  const items = feed.length
    ? `<ul class="live-feed">${feed
        .map((event) => {
          const type = event.type === 'event' ? 'event' : event.type === 'outbound' ? 'outbound' : 'pageview';
          const primary = type === 'event' ? event.name || 'event' : type === 'outbound' ? 'Outbound click' : event.path || '/';
          const metaParts = [
            type === 'event' ? event.path : event.source,
            event.country ? countryName(event.country) : null,
            event.browser && event.device ? `${event.browser} · ${event.device}` : event.device,
          ].filter(Boolean);
          return `
          <li class="live-item">
            <span class="live-icon type-${type}" aria-hidden="true"></span>
            <span>
              <span class="live-path" title="${esc(primary)}">${esc(primary)}</span>
              <span class="live-meta">${esc(metaParts.join(' · ') || 'direct')}</span>
            </span>
            <span class="live-time">${esc(relativeTime(event.ts))}</span>
          </li>`;
        })
        .join('')}</ul>`
    : '<div class="live-empty">Quiet right now. Recent pageviews and events will stream in here.</div>';

  body.innerHTML = `
    <div class="live-number"><strong>${num(state.live.active)}</strong><span>visitors in the last 5 min</span></div>
    ${items}`;
}

function hideEmptyError() {
  // Reserved for future use; keeps renderAll from referencing a missing element.
}

/* ---------------- login ---------------- */

function showLogin() {
  const overlay = $('#login');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  state.loginVisible = true;
  stopPolling();
  setTimeout(() => $('#login-token')?.focus(), 50);
}

function hideLogin() {
  const overlay = $('#login');
  if (!overlay) return;
  overlay.classList.add('hidden');
  state.loginVisible = false;
  const error = $('#login-error');
  if (error) error.classList.add('hidden');
}

async function submitLogin(event) {
  event.preventDefault();
  const input = $('#login-token');
  const error = $('#login-error');
  const token = input ? input.value.trim() : '';
  if (!token) return;

  try {
    const response = await fetch('/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      let message = 'Invalid token';
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch (err) { /* ignore */ }
      if (error) {
        error.textContent = message;
        error.classList.remove('hidden');
      }
      return;
    }
    if (input) input.value = '';
    hideLogin();
    await boot();
    if (editor.open && editor.current) await selectEditorPage(editor.current, true);
  } catch (err) {
    if (error) {
      error.textContent = 'Could not reach the server';
      error.classList.remove('hidden');
    }
  }
}

/* ---------------- page editor ---------------- */

function encodePagePath(pathname) {
  return String(pathname).split('/').map(encodeURIComponent).join('/');
}

function setEditorStatus(text) {
  const el = $('#editor-status');
  if (el) el.textContent = text;
}

function setEditorDirty(dirty) {
  editor.dirty = Boolean(dirty);
  $('#editor-dirty')?.classList.toggle('hidden', !editor.dirty);
  const save = $('#editor-save');
  if (save) save.disabled = !editor.current || editor.saving || !editor.ready;
  if (editor.dirty) setEditorStatus('Unsaved changes');
}

function editorFrameDoc() {
  const frame = $('#editor-frame');
  try {
    return frame?.contentDocument || null;
  } catch (err) {
    return null;
  }
}

function editorBody() {
  if (!editor.ready) return null;
  if (editor.source) return $('#editor-source')?.value ?? '';
  const doc = editorFrameDoc();
  return doc?.body ? doc.body.innerHTML : null;
}

function safeEditorUrl(value) {
  const url = String(value || '').trim();
  if (!url) return false;
  if (/^(https?:|mailto:|tel:|\/|#|\.{1,2}\/)/i.test(url)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function isEditorSessionLost(doc) {
  const text = doc?.body?.textContent?.trim() || '';
  return text === 'Unauthorized' && doc.body.children.length === 0;
}

function showEditorEmpty() {
  const list = $('#editor-file-list');
  if (list) {
    list.innerHTML = `<div class="editor-empty">No HTML pages found in <code>${esc(editor.root || 'the content directory')}</code>. Set <code>CONTENT_DIR</code> to a folder containing <code>.html</code> files.</div>`;
  }
  const loading = $('#editor-loading');
  if (loading) {
    loading.textContent = 'No page selected.';
    loading.classList.remove('hidden');
  }
  const frame = $('#editor-frame');
  if (frame) frame.src = 'about:blank';
  const title = $('#editor-page-title');
  if (title) title.value = '';
  const pathEl = $('#editor-path');
  if (pathEl) pathEl.textContent = 'No page selected';
  setEditorStatus('');
  editor.current = null;
  editor.meta = null;
  editor.ready = false;
  setEditorDirty(false);
}

function renderEditorFiles() {
  const list = $('#editor-file-list');
  if (!list) return;
  const query = editor.filter.trim().toLowerCase();
  const pages = editor.pages.filter((page) => !query || page.path.toLowerCase().includes(query));
  if (!pages.length) {
    list.innerHTML = `<div class="editor-empty">No HTML files${query ? ' match that filter' : ''} in <code>${esc(editor.root || 'the content directory')}</code>.</div>`;
    return;
  }
  list.innerHTML = pages
    .map(
      (page) => `
      <button class="editor-file${page.path === editor.current ? ' active' : ''}" type="button"
        data-path="${esc(page.path)}" role="option" aria-selected="${page.path === editor.current}">
        <span class="editor-file-name">${esc(page.name)}</span>
        <span class="editor-file-dir">${esc(page.dir || 'root')}</span>
        <span class="editor-file-meta">${formatBytes(page.bytes)} · ${relativeTime(page.modified)}</span>
      </button>`,
    )
    .join('');
}

async function loadEditorPages() {
  setEditorStatus('Loading pages…');
  try {
    const data = await api('/api/v1/pages');
    editor.pages = data.pages || [];
    editor.root = data.root || '';
    editor.loaded = true;
    const root = $('#editor-root');
    if (root) {
      root.textContent = editor.root ? `Editing ${editor.root}/` : 'Editing the configured content folder';
      root.title = editor.root || '';
    }
    renderEditorFiles();
    const target = editor.pages.some((page) => page.path === editor.current)
      ? editor.current
      : editor.pages[0]?.path;
    if (target) await selectEditorPage(target, true);
    else showEditorEmpty();
  } catch (err) {
    if (err.status === 403) {
      state.editorEnabled = false;
      $('#editor-btn')?.classList.add('hidden');
      closeEditor(true);
      toast(err.message, true);
      return;
    }
    if (err.status !== 401) {
      setEditorStatus('Could not load pages');
      toast(err.message || 'Could not load pages', true);
    }
  }
}

function handleEditorInput() {
  if (!editor.dirty) setEditorDirty(true);
}

function onEditorFrameLoad() {
  const frame = $('#editor-frame');
  const doc = editorFrameDoc();
  const loading = $('#editor-loading');
  if (!frame || !doc || !editor.current) return;
  if (!String(frame.contentWindow?.location?.href || '').includes('/content/')) return;

  if (isEditorSessionLost(doc)) {
    if (loading) {
      loading.textContent = 'Your session expired. Sign in again, then reopen this page.';
      loading.classList.remove('hidden');
    }
    showLogin();
    return;
  }

  try {
    doc.designMode = 'on';
    if (!doc.querySelector('style[data-pulse-editor]')) {
      const style = doc.createElement('style');
      style.setAttribute('data-pulse-editor', '');
      style.textContent = [
        'html{cursor:text}',
        'body{outline:none;min-height:100vh}',
        'a{cursor:text}',
        '::selection{background:rgba(60,227,164,.35)}',
      ].join('');
      (doc.head || doc.documentElement).appendChild(style);
    }
    doc.addEventListener('input', handleEditorInput);
    doc.addEventListener('keyup', handleEditorInput);
    doc.addEventListener('click', (event) => {
      const link = event.target.closest?.('a');
      if (link) event.preventDefault();
    }, true);
    doc.addEventListener('submit', (event) => event.preventDefault(), true);

    if (doc.title && !$('#editor-page-title')?.value) {
      $('#editor-page-title').value = doc.title;
    }
    editor.ready = true;
    const save = $('#editor-save');
    if (save) save.disabled = false;
    loading?.classList.add('hidden');
    const meta = editor.meta;
    setEditorStatus(
      `Editing ${meta?.bytes ? formatBytes(meta.bytes) : 'page'}${meta?.backup ? ' · .bak available' : ''}`,
    );
  } catch (err) {
    editor.ready = false;
    if (loading) {
      loading.textContent = 'This page could not be opened in the editor.';
      loading.classList.remove('hidden');
    }
  }
}

async function selectEditorPage(pathname, skipConfirm = false) {
  if (!pathname || editor.saving) return;
  if (!skipConfirm && editor.dirty && !confirm('Discard unsaved changes in the current page?')) return;
  try {
    const meta = await api(`/api/v1/pages/file?path=${encodeURIComponent(pathname)}`);
    editor.current = meta.path;
    editor.meta = meta;
    editor.source = false;
    editor.ready = false;
    setEditorDirty(false);

    const title = $('#editor-page-title');
    if (title) title.value = meta.title || '';
    const pathEl = $('#editor-path');
    if (pathEl) pathEl.textContent = meta.path;
    $('#editor-source')?.classList.add('hidden');
    $('#editor-frame')?.classList.remove('hidden');
    const toggle = $('#editor-source-toggle');
    if (toggle) toggle.textContent = 'View source';
    setEditorStatus(`Last saved ${savedFmt.format(new Date(meta.modified))}${meta.backup ? ' · .bak available' : ''}`);
    renderEditorFiles();

    const loading = $('#editor-loading');
    if (loading) {
      loading.textContent = 'Loading page…';
      loading.classList.remove('hidden');
    }
    const frame = $('#editor-frame');
    if (frame) {
      frame.onload = onEditorFrameLoad;
      frame.src = `/content/${encodePagePath(meta.path)}?v=${Date.now()}`;
    }
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'Could not open this page', true);
  }
}

function toggleEditorSource() {
  if (!editor.current) return;
  const frame = $('#editor-frame');
  const source = $('#editor-source');
  const toggle = $('#editor-source-toggle');
  if (!frame || !source) return;

  if (!editor.ready) {
    toast('The page is still loading', true);
    return;
  }
  if (!editor.source) {
    const doc = editorFrameDoc();
    if (!doc?.body) {
      toast('The page is still loading', true);
      return;
    }
    source.value = doc.body.innerHTML;
    editor.source = true;
    frame.classList.add('hidden');
    source.classList.remove('hidden');
    if (toggle) toggle.textContent = 'Visual editor';
    setEditorStatus('Source view · changes apply when you switch back or save');
    source.focus();
  } else {
    const doc = editorFrameDoc();
    if (doc?.body) doc.body.innerHTML = source.value;
    editor.source = false;
    source.classList.add('hidden');
    frame.classList.remove('hidden');
    if (toggle) toggle.textContent = 'View source';
    setEditorDirty(true);
    frame.contentWindow?.focus();
  }
}

function editorCommand(command, value = null) {
  if (!editor.current) return;
  if (editor.source) {
    toast('Switch to the visual editor to use the toolbar', true);
    return;
  }
  const doc = editorFrameDoc();
  if (!doc || doc.designMode !== 'on') return;
  try {
    doc.execCommand(command, false, value);
    setEditorDirty(true);
    $('#editor-frame')?.contentWindow?.focus();
  } catch (err) {
    toast('That formatting command is not available', true);
  }
}

async function saveEditorPage() {
  if (!editor.current || editor.saving) return;
  if (!editor.ready) {
    toast('The page is still loading. Try again in a moment.', true);
    return;
  }
  const body = editorBody();
  if (body === null) {
    toast('The page is not ready to save', true);
    return;
  }
  editor.saving = true;
  const save = $('#editor-save');
  if (save) save.disabled = true;
  setEditorStatus('Saving…');
  try {
    const saved = await api('/api/v1/pages/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: editor.current,
        body,
        title: $('#editor-page-title')?.value || '',
      }),
    });
    editor.meta = saved;
    const row = editor.pages.find((page) => page.path === saved.path);
    if (row) {
      row.bytes = saved.bytes;
      row.modified = saved.modified;
    }
    setEditorDirty(false);
    setEditorStatus(`Saved ${savedFmt.format(new Date(saved.modified))} · ${formatBytes(saved.bytes)} · .bak updated`);
    const doc = editorFrameDoc();
    if (doc) doc.title = saved.title || '';
    renderEditorFiles();
    toast(`Saved ${saved.path}`);
  } catch (err) {
    setEditorStatus('Save failed');
    if (err.status !== 401) toast(err.message || 'Could not save the page', true);
  } finally {
    editor.saving = false;
    if (save) save.disabled = !editor.current || !editor.ready;
    if (editor.dirty) setEditorStatus('Unsaved changes');
  }
}

async function openEditor() {
  if (!state.editorEnabled) {
    toast('The page editor is disabled on this server. Set EDITOR=1 to enable it.', true);
    return;
  }
  if (editor.open) return;
  editor.open = true;
  $('#editor')?.classList.remove('hidden');
  document.body.classList.add('editor-open');
  stopPolling();
  $('#editor-close')?.focus();
  await loadEditorPages();
}

function closeEditor(force = false) {
  if (!editor.open) return;
  if (!force && editor.dirty && !confirm('Close the editor and discard unsaved changes?')) return;
  editor.open = false;
  editor.dirty = false;
  editor.ready = false;
  setEditorDirty(false);
  $('#editor')?.classList.add('hidden');
  document.body.classList.remove('editor-open');
  const frame = $('#editor-frame');
  if (frame) frame.src = 'about:blank';
  if (!state.loginVisible) startPolling();
}

function bindEditorEvents() {
  $('#editor-btn')?.addEventListener('click', openEditor);
  $('#editor-close')?.addEventListener('click', () => closeEditor());
  $('#editor-save')?.addEventListener('click', saveEditorPage);
  $('#editor-source-toggle')?.addEventListener('click', toggleEditorSource);
  $('#editor-refresh')?.addEventListener('click', () => {
    if (editor.dirty && !confirm('Reload the page list and discard unsaved changes?')) return;
    loadEditorPages();
  });

  $('#editor-filter')?.addEventListener('input', (event) => {
    editor.filter = event.target.value || '';
    renderEditorFiles();
  });

  $('#editor-file-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-path]');
    if (!button) return;
    const pathname = button.dataset.path;
    if (pathname !== editor.current) selectEditorPage(pathname);
  });

  $('#editor-page-title')?.addEventListener('input', () => setEditorDirty(true));

  $('#editor')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeEditor();
  });

  $('#editor-toolbar')?.addEventListener('mousedown', (event) => {
    if (event.target.closest('.tool-btn')) event.preventDefault();
  });

  $('#editor-toolbar')?.addEventListener('click', (event) => {
    const button = event.target.closest('.tool-btn');
    if (!button) return;
    if (button.dataset.cmd) {
      editorCommand(button.dataset.cmd);
      return;
    }
    if (button.dataset.block) {
      editorCommand('formatBlock', `<${button.dataset.block}>`);
      return;
    }
    if (button.dataset.action === 'link') {
      const url = prompt('Link URL (https://, mailto:, or a relative path)', 'https://');
      if (url === null) return;
      if (!safeEditorUrl(url)) {
        toast('Use an http(s), mailto:, or relative URL', true);
        return;
      }
      editorCommand('createLink', url.trim());
      return;
    }
    if (button.dataset.action === 'image') {
      const url = prompt('Image URL (https:// or a relative path)');
      if (url === null) return;
      if (!safeEditorUrl(url) || /^mailto:|^tel:/i.test(url)) {
        toast('Use an image URL or a relative path', true);
        return;
      }
      editorCommand('insertImage', url.trim());
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!editor.open) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveEditorPage();
      return;
    }
    if (event.key === 'Escape' && !state.loginVisible) {
      event.preventDefault();
      closeEditor();
    }
  });

  $('#editor-source')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const source = event.target;
    const start = source.selectionStart;
    const end = source.selectionEnd;
    source.value = `${source.value.slice(0, start)}  ${source.value.slice(end)}`;
    source.selectionStart = source.selectionEnd = start + 2;
    setEditorDirty(true);
  });

  window.addEventListener('beforeunload', (event) => {
    if (!editor.open || !editor.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/* ---------------- events ---------------- */

function bindEvents() {
  $('#range-control')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    const range = button.dataset.range;
    if (!RANGES.includes(range) || range === state.range) return;
    state.range = range;
    storage.set('pulse.range', range);
    syncRangeButtons();
    loadAll();
  });

  $('#refresh-btn')?.addEventListener('click', () => {
    loadAll();
    refreshLive();
  });

  $('#theme-btn')?.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    if (state.stats) renderChart();
  });

  $('#site-select')?.addEventListener('change', (event) => {
    state.site = event.target.value;
    storage.set('pulse.site', state.site);
    state.stats = null;
    state.live = null;
    renderSkeletons();
    loadAll();
  });

  $('#login-form')?.addEventListener('submit', submitLogin);

  $('#logout-link')?.addEventListener('click', async () => {
    try {
      await fetch('/api/v1/logout', { method: 'POST' });
    } catch (err) { /* ignore */ }
    location.reload();
  });

  $('#copy-snippet')?.addEventListener('click', async () => {
    const code = $('#snippet-code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || '');
      toast('Snippet copied to clipboard');
    } catch (err) {
      toast('Select the snippet and copy it manually', true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.site && !state.loginVisible) {
      refreshLive();
      if (Date.now() - state.lastLoad > 15000) loadAll();
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.stats) renderChart();
    }, 150);
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('.nav-link[data-target]');
    if (!link) return;
    $$('.nav-link[data-target]').forEach((item) => item.classList.toggle('active', item === link));
  });

  bindEditorEvents();
  observeSections();
}

function observeSections() {
  if (!('IntersectionObserver' in window)) return;
  const links = new Map($$('.nav-link[data-target]').map((link) => [link.dataset.target, link]));
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const link = links.get(entry.target.id);
        if (!link) return;
        $$('.nav-link[data-target]').forEach((item) => item.classList.toggle('active', item === link));
      });
    },
    { rootMargin: '-20% 0px -65% 0px', threshold: 0 },
  );
  links.forEach((link, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

/* ---------------- skeletons ---------------- */

function renderSkeletons() {
  const rows = '<div class="skeleton skeleton-row"></div>'.repeat(4);
  ['pages-body', 'sources-body', 'events-body', 'browsers-body'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = rows;
  });
  const devices = $('#devices-body');
  if (devices) devices.innerHTML = '<div class="skeleton skeleton-block"></div>';
  const countries = $('#countries-body');
  if (countries) countries.innerHTML = '<div class="skeleton skeleton-block"></div>';
  const live = $('#live-body');
  if (live) live.innerHTML = '<div class="skeleton skeleton-block"></div>';
  const kpis = $('#kpis');
  if (kpis && !kpis.children.length) {
    kpis.innerHTML = '<div class="kpi skeleton-card"></div>'.repeat(5);
  }
}

/* ---------------- start ---------------- */

function start() {
  applyTheme(state.theme);
  syncRangeButtons();
  renderSkeletons();
  bindEvents();
  boot();
}

start();
