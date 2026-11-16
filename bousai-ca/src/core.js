'use strict';
/* Shared utilities, theme, router and state persistence */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
/* Million USD → display string */
const fmtUSD = (m) => {
  if (m == null || isNaN(m)) return '—';
  if (m >= 999.95) return `US$${(m / 1000).toFixed(m >= 9999.5 ? 0 : 1)}B`;
  if (m >= 0.9995) return `US$${m.toFixed(m >= 99.95 ? 0 : 1)}M`;
  if (m >= 0.0005) return `US$${Math.round(m * 1000)}k`;
  return m > 0 ? 'under US$1k' : '≈0';
};
const fmtPct = (v, d = 0) => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(d)}%`;
/* Compact notation for large numbers (1.6M / 95k) */
const fmtC = (n) => (n == null || isNaN(n)) ? '—' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : fmt(n);
const fmtHours = (h) => { const H = Math.round(h); const d = Math.floor(H / 24), hh = H % 24; return d > 0 ? `D+${d} ${String(hh).padStart(2, '0')}:00` : `+${hh}h`; };
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const sum = (arr, f = (x) => x) => arr.reduce((s, x, i) => s + (f(x, i) || 0), 0);
const by = (arr, key) => Object.fromEntries(arr.map((x) => [x[key], x]));

/* Toast */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}
/* Clipboard (falls back to selecting the text on failure) */
function copyText(text, el) {
  const ok = () => toast(`Copied: ${text}`);
  const sel = () => { try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Text selected. Long-press or right-click to copy'); } catch (e) { toast('Could not copy'); } };
  try { navigator.clipboard.writeText(text).then(ok, sel); } catch (e) { sel(); }
}

/* Persistence (per-viewer convenience only) */
const Store = {
  key: 'dc-ca-v1',
  load() { try { return JSON.parse(localStorage.getItem(this.key) || '{}') || {}; } catch (e) { return {}; } },
  save(obj) { try { localStorage.setItem(this.key, JSON.stringify(obj)); } catch (e) { /* ignore */ } },
  get(k, d) { const v = this.load()[k]; return v === undefined ? d : v; },
  set(k, v) { const o = this.load(); o[k] = v; this.save(o); },
};

/* Theme: system → dark → light */
const Theme = {
  get() { try { return localStorage.getItem('dc-ca-theme') || ''; } catch (e) { return ''; } },
  apply(v) { if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme; },
  cycle() {
    const cur = this.get(); const next = cur === '' ? 'dark' : cur === 'dark' ? 'light' : '';
    try { if (next) localStorage.setItem('dc-ca-theme', next); else localStorage.removeItem('dc-ca-theme'); } catch (e) { /* ignore */ }
    this.apply(next); toast(next === '' ? 'Theme: follow device setting' : next === 'dark' ? 'Theme: dark' : 'Theme: light');
    document.dispatchEvent(new CustomEvent('themechange'));
  },
};

/* Viewing context: organization type (company / government) and viewer (manager / staff) */
const Ctx = {
  org: Store.get('org', 'corp'), persona: Store.get('persona', 'admin'),
  set(k, v) { this[k] = v; Store.set(k, v); document.documentElement.dataset[k] = v; document.dispatchEvent(new CustomEvent('ctxchange')); },
  isGov() { return this.org === 'gov'; }, isStaff() { return this.persona === 'staff'; },
};
/* Router (hash = view name) */
const VIEWS = ['risk', 'live', 'me'];
const HASH_ALIAS = { region: 'risk', site: 'risk', personal: 'me', 'live-support': 'live', 'live-local': 'live' };
const App = { views: {}, current: null, inited: new Set() };
function currentView() { let h = (location.hash || '').replace('#', ''); h = HASH_ALIAS[h] || h; return VIEWS.includes(h) ? h : 'risk'; }
function showView(name) {
  App.current = name;
  /* Stop live-reporting playback when leaving the live view */
  if (!/^live/.test(name) && typeof Live !== 'undefined' && Live.st.playing) { clearInterval(Live.st.timer); Live.st.playing = false; }
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('#nav a, #navM a').forEach((a) => { if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const v = App.views[name];
  if (v) {
    const el = $(`#v-${name}`);
    if (!App.inited.has(name)) { App.inited.add(name); v.init(el); }
    else if (v.show) v.show(el);
  }
  window.scrollTo({ top: 0 });
}
function route() {
  const h = (location.hash || '').replace('#', '');
  if (h && !VIEWS.includes(h) && !HASH_ALIAS[h]) { if (!App.current) showView('risk'); return; } /* Ignore unknown hashes (e.g. #main) */
  showView(currentView());
}
/* Date-time display (scenario time) */
const fmtDT = (d) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const scenarioDate = (sc, t) => { const base = sc.t0_iso ? new Date(sc.t0_iso) : new Date(); return new Date(base.getTime() + t * 3600 * 1000); };

/* Element creation */
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* Hazard vocabulary */
const HAZ = {
  flood: { ja: 'River flood', short: 'River flood', icon: 'wave', th: 'river_flood' },
  urban_flood: { ja: 'Urban (pluvial) flooding', short: 'Urban flood', icon: 'drop', th: 'urban_flood' },
  coastal: { ja: 'Coastal flooding (Caspian Sea)', short: 'Coastal', icon: 'wave', th: 'coastal_flood' },
  quake: { ja: 'Earthquake', short: 'Earthquake', icon: 'quake', th: 'earthquake' },
  cyclone: { ja: 'Strong wind / dust storm', short: 'Wind', icon: 'wind', th: 'cyclone' },
  landslide: { ja: 'Landslide / mudflow (debris flow)', short: 'Landslide', icon: 'mountain', th: 'landslide' },
  heat: { ja: 'Extreme heat', short: 'Heat', icon: 'sun', th: 'extreme_heat' },
  cold: { ja: 'Extreme cold / cold wave', short: 'Cold', icon: 'cloud', th: 'extreme_cold' },
  haze: { ja: 'Wildfire smoke / air pollution', short: 'Air quality', icon: 'mask', th: 'wildfire' },
  water: { ja: 'Water scarcity / drought', short: 'Water', icon: 'drop', th: 'water_scarcity' },
};
const LEVEL = {
  'High': { k: 4, ja: 'High', cls: 'k5' }, 'Medium': { k: 3, ja: 'Medium', cls: 'k3' }, 'Low': { k: 2, ja: 'Low', cls: 'k2' }, 'Very low': { k: 1, ja: 'Very low', cls: 'k1' },
  'No data': { k: 0, ja: 'No data', cls: 'k0' }, 'unknown': { k: 0, ja: 'Not retrieved', cls: 'k0' },
};
const lvInfo = (s) => LEVEL[s] || LEVEL.unknown;
const lvTag = (s) => { const l = lvInfo(s); return `<span class="lv"><i style="background:var(--${l.cls.replace('k', 'h')})"></i>${l.ja}</span>`; };
const srcTag = (label, url, note) => url ? `<a class="cite" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(note || url)}">${ic('link')}${esc(label)}</a>` : `<span class="cite" title="${esc(note || '')}">${esc(label)}</span>`;
const asmTag = (label = 'Assumed') => `<span class="cite asm" title="Assumed value without a source (demo). See 'Assumptions and method' for the basis">${esc(label)}</span>`;
