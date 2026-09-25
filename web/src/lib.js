import { useEffect, useRef, useState } from 'react';

// =============================================================================
// lib.js — shared, framework-light helpers for the dashboard (formatters,
// names, preferences, fetch/POST). Everything below is pure or a small React
// hook; sections import from here rather than re-implementing any of it.
// =============================================================================

// ---- brand -------------------------------------------------------------------
// The ONE place the product name lives (Burnglass was called Pulse up to
// v1.34): every visible product name in the UI reads this constant, never a
// string literal. The server also reports it as payload.brand.
export const BRAND = 'Burnglass';
// The executable users double-click to start the server again (stopped page,
// System panel copy). A DEFAULT only: prefer payload.exeName, the running
// exe's real filename — a self-updated v1 install is still called pulse.exe
// (null when running from source).
export const EXE_NAME = 'burnglass.exe';
// The Windows taskbar-strip companion's executable (System panel help copy).
export const STRIP_EXE_NAME = 'burnglass-strip.exe';

// ---- colour ------------------------------------------------------------------
// Categorical palette for SOURCES ONLY (validated in both themes). Values are
// CSS custom properties so light/dark switch without any JS; they work in
// style={{ background }}, SVG fill/stroke attributes and innerHTML alike.
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

// Effort levels, low → max, as an ordinal one-hue ramp (--ef1…--ef5). Never
// the only cue: pair it with <Signal>/<EffortLabel> (ui.jsx) or text.
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_RAMP = {
  minimal: 'var(--ef1)',
  low: 'var(--ef1)',
  medium: 'var(--ef2)',
  high: 'var(--ef3)',
  xhigh: 'var(--ef4)',
  max: 'var(--ef5)',
  ultracode: 'var(--ef5)', // draw hatched (class "hatch") so it differs from max
  default: 'var(--ef-def)', // no level recorded
};
const EFFORT_NAMES = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high',
  max: 'Max', ultracode: 'Ultracode', default: 'Default',
};
// "xhigh" → "Extra high"; unknown levels are capitalised.
export function effortLabel(level) {
  if (!level) return '';
  return EFFORT_NAMES[level] || String(level).charAt(0).toUpperCase() + String(level).slice(1);
}
// Number of lit bars (0–5) in the 5-bar signal glyph for a level.
export function effortBars(level) {
  switch (level) {
    case 'minimal': case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'xhigh': return 4;
    case 'max': case 'ultracode': return 5;
    default: return 0;
  }
}

// ---- formatters --------------------------------------------------------------
const LOCALE = 'en-US'; // "$" + en-US grouping — never "$1.063,72"

// $1,063.72 · $7.63 · <$0.01 · −$5.10 · — (null). Always 2 decimals.
export function money(v) {
  if (v == null || !isFinite(v)) return '—';
  const n = Number(v);
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n < 0 && n > -0.01) return '−<$0.01';
  const s = '$' + Math.abs(n).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? '−' + s : s;
}
// Compact money for chart axes and tight labels: $0 · $2.5 · $25 · $1.2k · $12k.
export function moneyAxis(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e6) return sign + '$' + trimZero((a / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + 'M';
  if (a >= 1e3) return sign + '$' + trimZero((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'k';
  if (a >= 10 || a === 0) return sign + '$' + Math.round(a);
  return sign + '$' + trimZero(a.toFixed(a >= 1 ? 1 : 2));
}
function trimZero(s) { return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s; }

// Tokens: 708.7M · 60.5K · 812 · 1.29B (billions keep 2 decimals — at that
// scale the second digit is still ~10M tokens of real information).
export function tokens(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
// 27,746
export function num(v) {
  return v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString(LOCALE);
}
// 84% (integer). pctText(12.345, 1) → "12.3%".
export function pct(v) {
  return v == null || !isFinite(v) ? '—' : v.toFixed(0) + '%';
}
export function pctText(v, digits = 0) {
  return v == null || !isFinite(v) ? '—' : Number(v).toFixed(digits) + '%';
}
// Relative change in percent, or null when there is no baseline.
export function pctChange(cur, prev) {
  if (cur == null || prev == null || !(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

const pad = (n) => (n < 10 ? '0' : '') + n;
// 06:55:01 (local)
export function clockTime(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
// 06:55 (local)
export function hm(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// Durations switch format at a day, an hour and a minute: "3d 4h" · "2h 12m" · "12m 05s" · "45s".
export function dur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + 'd ' + (h % 24) + 'h';
  if (h >= 1) return h + 'h ' + pad(m % 60) + 'm';
  if (m >= 1) return m + 'm ' + pad(s % 60) + 's';
  return s + 's';
}
// "3m ago" relative to now.
export function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export { WEEKDAYS, MONTHS };
// Absolute reset time, local: "Mon 11:54".
export function formatReset(ts) {
  if (ts == null || !isFinite(ts)) return '—';
  const d = new Date(ts);
  return WEEKDAYS[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// 'YYYY-MM-DD' → "Sep 17"
export function shortDate(ds) {
  const p = String(ds).split('-').map(Number);
  return (MONTHS[p[1] - 1] || '?') + ' ' + p[2];
}
// 'YYYY-MM-DD' → "Thu, Sep 17" (weekday computed in local time)
export function longDate(ds) {
  const p = String(ds).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return WEEKDAYS[d.getDay()] + ', ' + shortDate(ds);
}
// 'YYYY-MM' (or any 'YYYY-MM…' key) → "Sep"
export function monthShort(key) {
  const m = parseInt(String(key).slice(5, 7), 10);
  return MONTHS[m - 1] || String(key);
}
// Local 'YYYY-MM-DD' for a Date (matches the server's daily bucket keys).
export function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// "Nice" axis scale: niceScale(81.3) → { max: 100, step: 25, ticks: [0,25,50,75,100] }.
export function niceScale(maxValue, maxTicks = 5) {
  const max = maxValue > 0 && isFinite(maxValue) ? maxValue : 1;
  const rough = max / Math.max(1, maxTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, step, ticks };
}

// ---- names ---------------------------------------------------------------------
// Friendly label for a builtin source key. Config-defined custom sources carry
// their own label in payload.sourceMeta, which always wins (see srcLabel).
export const SOURCE_LABELS = {
  cli: 'Claude CLI',
  'claude-vscode': 'Claude VS Code',
  'claude-desktop': 'Claude Desktop',
  'claude-jetbrains': 'Claude JetBrains',
  'sdk-cli': 'Claude SDK',
  'sdk-ts': 'Claude SDK (TS)',
  'sdk-py': 'Claude SDK (Python)',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  continue: 'Continue',
  cline: 'Cline',
  roo: 'Roo Code',
};
// UI label for a source: custom label (payload.sourceMeta) → builtin → raw key.
// Keys stay RAW everywhere that matters (filters, React keys, CSV, ?sources=).
export function srcLabel(key, meta) {
  const m = meta && meta[key];
  return (m && m.label) || SOURCE_LABELS[key] || key;
}

// Mirrors server.js prettyModelName (the Discord presence's model line), so
// the dashboard and the presence name a model the same way:
//   claude-opus-5-5 → "Opus 5.5" · claude-haiku-4-5-20251001 → "Haiku 4.5"
//   gpt-6-astra → "GPT-6 Astra" · gpt-5.6-sol → "GPT-5.6 Sol" · glm-4.6 → "GLM-4.6"
// One addition over the server: gemini-3.5-flash → "Gemini 3.5 Flash".
export function prettyModel(model) {
  if (!model) return '';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  let m = String(model)
    .replace(/^(?:[a-z]+(?:-[a-z]+)*\.)?openai\./, '')
    .replace(/^(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@(\d{8})$/, '-$1')
    .replace(/\[1m\]$/, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
  if (m.startsWith('claude-')) {
    const parts = m.slice(7).split('-');
    const fam = parts.filter((p) => /^[a-z]/.test(p) && !/^v\d+$/.test(p));
    const ver = parts.filter((p) => /^\d+$/.test(p));
    return fam.length ? fam.map(cap).join(' ') + (ver.length ? ' ' + ver.join('.') : '') : m;
  }
  if (m.startsWith('gpt-')) {
    const [v, ...rest] = m.slice(4).split('-');
    return /^\d/.test(v) ? 'GPT-' + v + (rest.length ? ' ' + rest.map(cap).join(' ') : '')
      : 'GPT ' + [v, ...rest].map(cap).join(' ');
  }
  if (m.startsWith('glm-')) return 'GLM-' + m.slice(4);
  if (m.startsWith('gemini-')) return 'Gemini ' + m.slice(7).split('-').map(cap).join(' ');
  return m;
}

// Folder name of a project path ("(other)"/"(unknown)" pass through).
export function projectBase(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  if (s.startsWith('(')) return s;
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// Stable color-by-entity: assign in the order names first appear (from the
// payload's all-time lists), so a series keeps its colour across periods and
// filters. Use with payload.allSources ONLY — models get neutral bars now.
export function makeColorMap(names) {
  const map = {};
  (names || []).forEach((n, i) => {
    map[n] = SERIES[i % SERIES.length];
  });
  return { get: (n) => map[n] || SERIES[Object.keys(map).length % SERIES.length], map };
}

// ---- alert thresholds / meter tone --------------------------------------------
// The configured alert thresholds (payload.alertThresholds, ascending), so meter
// ticks and warn/crit colouring agree with the alerts and notifications.
export function alertThresholds(data) {
  const t = data && Array.isArray(data.alertThresholds) ? data.alertThresholds.filter((n) => typeof n === 'number' && n > 0 && n <= 100) : [];
  return (t.length ? t : [80, 95]).slice().sort((a, b) => a - b);
}
// '' | 'warn' | 'crit' for a used-% against the thresholds: at/above the
// lowest → warn, at/above the highest (when there are 2+) → crit.
export function meterTone(pctUsed, thresholds = [80, 95]) {
  if (pctUsed == null || !isFinite(pctUsed) || !thresholds.length) return '';
  const hi = thresholds[thresholds.length - 1], lo = thresholds[0];
  if (thresholds.length > 1 && pctUsed >= hi) return 'crit';
  if (pctUsed >= lo) return 'warn';
  return '';
}

// ---- export links ---------------------------------------------------------------
// Same-origin GET link for /api/export carrying the period AND the active
// source filter, so a download always matches what is on screen.
//   exportHref({ format: 'csv', data: 'daily' }, 'last30', ['cli'])
export function exportHref(params, periodKey, srcFilter) {
  const p = new URLSearchParams(params || {});
  if (periodKey) p.set('period', periodKey);
  if (srcFilter && srcFilter.length) p.set('sources', srcFilter.join(','));
  return '/api/export?' + p.toString();
}
// The CSV datasets the export endpoint serves, in menu order: [label, data].
export const EXPORT_SETS = [
  ['Daily spend', 'daily'],
  ['By model', 'models'],
  ['By source', 'sources'],
  ['By project', 'projects'],
  ['Recent sessions', 'sessions'],
];

// ---- data hook: fetch /api/summary on mount + every 10s ----------------------------
// `sources` (array of source names) scopes the whole payload server-side;
// empty/null means all sources.
export function useSummary(intervalMs = 10000, sources = null) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const inFlight = useRef(false);
  const sourcesKey = (sources && sources.length) ? sources.slice().sort().join(',') : '';

  useEffect(() => {
    let alive = true;
    const url = '/api/summary' + (sourcesKey ? '?sources=' + encodeURIComponent(sourcesKey) : '');
    async function refresh() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 200));
        const data = await r.json();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: String(e.message || e), loading: false }));
      } finally {
        inFlight.current = false;
      }
    }
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, sourcesKey]);

  return state;
}

// POST to a Pulse mutation endpoint. The X-Pulse header is required by the
// server's cross-site guard (it forces a CORS preflight for foreign origins).
// `body` (optional) is sent as JSON. Anything secret — the Meshy API key — MUST
// travel this way and never as a query parameter: a URL ends up in the server
// log, the browser history and any referrer header, a request body does not.
export async function postJson(path, body) {
  const init = { method: 'POST', headers: { 'X-Pulse': '1' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  let out = null;
  try { out = await r.json(); } catch (_) {}
  if (!r.ok) {
    const err = new Error((out && out.error) || 'HTTP ' + r.status);
    err.status = r.status; // lets callers tell an HTTP failure from a dropped connection
    throw err;
  }
  return out || {};
}

// Poll /api/logs on the same cadence as the summary.
export function useLogs(enabled, intervalMs = 10000) {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function refresh() {
      try {
        const r = await fetch('/api/logs', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && j && Array.isArray(j.lines)) setLines(j.lines);
      } catch (_) { /* server gone — summary hook surfaces it */ }
    }
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [enabled, intervalMs]);
  return lines;
}

// ---- local preferences (localStorage, always try/catch) ------------------------------
function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }

// Source filter — [] means "all sources". Key unchanged since v1.x.
const SRC_FILTER_KEY = 'pulse-source-filter';
export function readSourceFilter() {
  try { const v = JSON.parse(lsGet(SRC_FILTER_KEY)); return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []; } catch (_) { return []; }
}
export function writeSourceFilter(list) { lsSet(SRC_FILTER_KEY, JSON.stringify(list || [])); }

// Selected period key ('last30', 'last90', '2026-09', …). Validated against the
// payload's periods by the caller; unknown keys fall back to last30.
const PERIOD_KEY = 'pulse-period';
export function readPeriod() {
  const v = lsGet(PERIOD_KEY);
  return v && /^(last\d+|\d{4}-\d{2})$/.test(v) ? v : 'last30';
}
export function writePeriod(key) { if (key) lsSet(PERIOD_KEY, key); }

// ---- theme: 'system' | 'dark' | 'light' → <html data-theme> ---------------------------
// 'system' removes the attribute so prefers-color-scheme decides (dark is the
// default when the OS expresses no preference).
const THEME_KEY = 'pulse-theme';
export function readTheme() {
  const t = lsGet(THEME_KEY);
  return t === 'dark' || t === 'light' ? t : 'system';
}
export function applyTheme(pref) {
  try {
    const el = document.documentElement;
    if (pref === 'dark' || pref === 'light') el.setAttribute('data-theme', pref);
    else el.removeAttribute('data-theme');
  } catch (_) {}
  lsSet(THEME_KEY, pref === 'dark' || pref === 'light' ? pref : 'system');
}
export function systemTheme() {
  try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (_) { return 'dark'; }
}
// { pref, effective: 'dark'|'light', set(pref) } — own it ONCE (App) and pass it down.
export function useTheme() {
  const [pref, setPref] = useState(() => { const p = readTheme(); applyTheme(p); return p; });
  const [sys, setSys] = useState(systemTheme);
  useEffect(() => { applyTheme(pref); }, [pref]);
  useEffect(() => {
    let mql;
    try { mql = window.matchMedia('(prefers-color-scheme: light)'); } catch (_) { return undefined; }
    const on = () => setSys(mql.matches ? 'light' : 'dark');
    if (mql.addEventListener) mql.addEventListener('change', on); else if (mql.addListener) mql.addListener(on);
    return () => { if (mql.removeEventListener) mql.removeEventListener('change', on); else if (mql.removeListener) mql.removeListener(on); };
  }, []);
  return { pref, effective: pref === 'system' ? sys : pref, set: setPref };
}

// ---- graphics performance mode ----------------------------------------------------------
// The redesign uses no blur and nothing that loops, so "lite" only drops
// transitions and number tweens. Detect software rendering via the WebGL
// renderer string (memoised — one probe per page load, not per render).
export const perf = { lite: false };

let softwareRendering = null;
export function detectSoftwareRendering() {
  if (softwareRendering != null) return softwareRendering;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) { softwareRendering = true; return true; } // no GL context at all → software paint path
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    softwareRendering = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (_) {}
  } catch (_) {
    softwareRendering = true;
  }
  return softwareRendering;
}

// mode: 'auto' (detect) | 'rich' | 'lite' — persisted in 'pulse-graphics'.
export function readGraphicsMode() {
  const m = lsGet('pulse-graphics');
  return m === 'rich' || m === 'lite' ? m : 'auto';
}

export function effectiveLite(mode) {
  return mode === 'lite' || (mode === 'auto' && detectSoftwareRendering());
}

export function applyGraphicsMode(mode) {
  const lite = effectiveLite(mode);
  perf.lite = lite;
  try { document.documentElement.classList.toggle('lite', lite); } catch (_) {}
  lsSet('pulse-graphics', mode);
  return lite;
}

// True when the user asked the OS for reduced motion OR lite mode is on.
export function motionReduced() {
  if (perf.lite) return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

// ---- limit alerts: desktop notifications, de-duplicated per reset cycle ----------------
// The server reports which windows are currently at/above a threshold; we fire
// a browser (OS) notification the first time we see each (window, threshold,
// reset-cycle) and remember it so we don't repeat until the window resets or
// escalates to a higher threshold.
const ALERTED_KEY = 'pulse-alerted';
function alertKey(a) { return a.key + '|' + a.threshold + '|' + (a.resetsAt || 0); }
export function notifyPermission() {
  return (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
}
export function requestAlertPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { return Notification.requestPermission(); } catch (_) {}
  }
  return undefined;
}
export function fireAlertNotifications(alerts) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!Array.isArray(alerts) || !alerts.length) return;
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem(ALERTED_KEY) || '[]')); } catch (_) { seen = new Set(); }
  let changed = false;
  for (const a of alerts) {
    const k = alertKey(a);
    if (seen.has(k)) continue;
    seen.add(k); changed = true;
    try {
      new Notification(BRAND + ' — usage alert', {
        body: a.kind === 'anomaly'
          ? `${a.label}: ${a.detail}`
          : `${a.label} is at ${Math.round(a.pct)}% (≥ ${a.threshold}%)`,
        tag: 'pulse-' + a.key, // one live toast per window; escalation replaces it
      });
    } catch (_) {}
  }
  if (changed) {
    try { localStorage.setItem(ALERTED_KEY, JSON.stringify(Array.from(seen).slice(-200))); } catch (_) {}
  }
}

// Live media-query match: useMedia('(max-width: 760px)') → boolean.
// Breakpoints (styles.css): 1360 layout reflow · 1024 rail → mobile header ·
// 760 phone · 420 narrow phone.
export const BP = { lg: '(max-width: 1360px)', md: '(max-width: 1024px)', sm: '(max-width: 760px)', xs: '(max-width: 420px)' };
export function useMedia(query) {
  const get = () => { try { return window.matchMedia(query).matches; } catch (_) { return false; } };
  const [match, setMatch] = useState(get);
  useEffect(() => {
    let mql;
    try { mql = window.matchMedia(query); } catch (_) { return undefined; }
    const on = () => setMatch(mql.matches);
    on();
    if (mql.addEventListener) mql.addEventListener('change', on); else if (mql.addListener) mql.addListener(on);
    return () => { if (mql.removeEventListener) mql.removeEventListener('change', on); else if (mql.removeListener) mql.removeListener(on); };
  }, [query]);
  return match;
}

// Re-render helper that ticks every `ms` (live countdowns / relative time).
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
