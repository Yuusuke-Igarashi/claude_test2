'use strict';
/* 共通ユーティリティ・テーマ・ルーター・状態保存 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });
/* 百万USD → 表示文字列 */
const fmtUSD = (m) => {
  if (m == null || isNaN(m)) return '—';
  if (m >= 999.95) return `US$${(m / 1000).toFixed(m >= 9999.5 ? 0 : 1)}B`;
  if (m >= 0.9995) return `US$${m.toFixed(m >= 99.95 ? 0 : 1)}M`;
  if (m >= 0.0005) return `US$${Math.round(m * 1000)}k`;
  return m > 0 ? 'US$1k未満' : '≈0';
};
const fmtPct = (v, d = 0) => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(d)}%`;
const fmtHours = (h) => { const H = Math.round(h); const d = Math.floor(H / 24), hh = H % 24; return d > 0 ? `D+${d} ${String(hh).padStart(2, '0')}:00` : `+${hh}h`; };
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const sum = (arr, f = (x) => x) => arr.reduce((s, x, i) => s + (f(x, i) || 0), 0);
const by = (arr, key) => Object.fromEntries(arr.map((x) => [x[key], x]));

/* トースト */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}
/* クリップボード（失敗時は選択にフォールバック） */
function copyText(text, el) {
  const ok = () => toast(`コピーしました：${text}`);
  const sel = () => { try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('選択しました。長押し／右クリックでコピーしてください'); } catch (e) { toast('コピーできませんでした'); } };
  try { navigator.clipboard.writeText(text).then(ok, sel); } catch (e) { sel(); }
}

/* 保存（per-viewer の利便性のみ） */
const Store = {
  key: 'bousai-sea-v1',
  load() { try { return JSON.parse(localStorage.getItem(this.key) || '{}') || {}; } catch (e) { return {}; } },
  save(obj) { try { localStorage.setItem(this.key, JSON.stringify(obj)); } catch (e) { /* 無視 */ } },
  get(k, d) { const v = this.load()[k]; return v === undefined ? d : v; },
  set(k, v) { const o = this.load(); o[k] = v; this.save(o); },
};

/* テーマ：system → dark → light */
const Theme = {
  get() { try { return localStorage.getItem('bousai-theme') || ''; } catch (e) { return ''; } },
  apply(v) { if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme; },
  cycle() {
    const cur = this.get(); const next = cur === '' ? 'dark' : cur === 'dark' ? 'light' : '';
    try { if (next) localStorage.setItem('bousai-theme', next); else localStorage.removeItem('bousai-theme'); } catch (e) { /* 無視 */ }
    this.apply(next); toast(next === '' ? 'テーマ：端末の設定に従う' : next === 'dark' ? 'テーマ：ダーク' : 'テーマ：ライト');
    document.dispatchEvent(new CustomEvent('themechange'));
  },
};

/* ルーター（ハッシュ＝画面名） */
const VIEWS = ['region', 'site', 'personal', 'live-support', 'live-local'];
const App = { views: {}, current: null, inited: new Set() };
function currentView() { const h = (location.hash || '').replace('#', ''); return VIEWS.includes(h) ? h : 'region'; }
function showView(name) {
  App.current = name;
  /* 発災画面の再生は画面を離れたら止める */
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
  if (h && !VIEWS.includes(h)) { if (!App.current) showView('region'); return; } /* 未知のハッシュ（#main など）は無視 */
  showView(currentView());
}

/* 要素生成 */
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* ハザードの語彙 */
const HAZ = {
  flood: { ja: '洪水（河川氾濫）', short: '河川洪水', icon: 'wave', th: 'river_flood' },
  urban_flood: { ja: '都市型浸水（内水）', short: '都市浸水', icon: 'drop', th: 'urban_flood' },
  coastal: { ja: '高潮・沿岸浸水', short: '高潮', icon: 'wave', th: 'coastal_flood' },
  quake: { ja: '地震', short: '地震', icon: 'quake', th: 'earthquake' },
  tsunami: { ja: '津波', short: '津波', icon: 'wave', th: 'tsunami' },
  cyclone: { ja: '台風・サイクロン（強風）', short: '台風', icon: 'wind', th: 'cyclone' },
  landslide: { ja: '地すべり・土砂', short: '土砂', icon: 'mountain', th: 'landslide' },
  volcano: { ja: '火山', short: '火山', icon: 'fire', th: 'volcano' },
  heat: { ja: '極端な暑さ', short: '熱波', icon: 'sun', th: 'extreme_heat' },
  haze: { ja: '煙霧・大気汚染（PM2.5）', short: '煙霧', icon: 'mask', th: 'wildfire' },
  water: { ja: '水不足・干ばつ', short: '水不足', icon: 'drop', th: 'water_scarcity' },
};
const LEVEL = {
  'High': { k: 4, ja: '高', cls: 'k5' }, 'Medium': { k: 3, ja: '中', cls: 'k3' }, 'Low': { k: 2, ja: '低', cls: 'k2' }, 'Very low': { k: 1, ja: '極めて低い', cls: 'k1' },
  'No data': { k: 0, ja: 'データなし', cls: 'k0' }, 'unknown': { k: 0, ja: '未取得', cls: 'k0' },
};
const lvInfo = (s) => LEVEL[s] || LEVEL.unknown;
const lvTag = (s) => { const l = lvInfo(s); return `<span class="lv"><i style="background:var(--${l.cls.replace('k', 'h')})"></i>${l.ja}</span>`; };
const srcTag = (label, url, note) => url ? `<a class="cite" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(note || url)}">${ic('link')}${esc(label)}</a>` : `<span class="cite" title="${esc(note || '')}">${esc(label)}</span>`;
const asmTag = (label = '仮定') => `<span class="cite asm" title="出典のない仮定値（デモ用）。前提は「前提と計算方法」を参照">${esc(label)}</span>`;
