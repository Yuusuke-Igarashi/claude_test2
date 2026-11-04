/* 画面2：リアルタイムレポーティング — ●●国●●市●●災害（複数）→ 被害全体像／外力状況／被害発生状況／拠点・サプライチェーン状況
 * シナリオ時刻（t：発災からの時間）はイベントごとに保持し、パーソナライズ画面のリアルタイム表示と共有する。 */
const Live = {
  st: { scen: Store.get('liveScen', null), tBy: {}, playing: false, timer: null, tab: Store.get('liveTab', 'overview'), incCat: 'all', seen: {}, autoStarted: false },
  scenario() { const s = M.scenario(this.st.scen); if (s) this.st.scen = s.id; return s; },
  t(sc) { sc = sc || this.scenario(); if (!sc) return 0; if (this.st.tBy[sc.id] == null) this.st.tBy[sc.id] = sc.default_t != null ? sc.default_t : 30; return this.st.tBy[sc.id]; },
  setT(v, sc) { sc = sc || this.scenario(); this.st.tBy[sc.id] = clamp(+v, 0, 168); },
  stop() { clearInterval(this.st.timer); this.st.timer = null; this.st.playing = false; },
  /* 再生：実時間 1 秒ごとにシナリオ時刻を 15 分進める（1 時間ごとに全面再描画） */
  play(onTick) { this.stop(); this.st.playing = true; this.st.timer = setInterval(() => { const t = this.t(); if (t >= 168) { this.stop(); onTick('end'); return; } this.setT(Math.min(168, Math.round((t + 0.25) * 4) / 4)); onTick(Number.isInteger(this.t()) ? 'hour' : 'tick'); }, 1000); },
};
const STAFF_JA = () => (Ctx.isGov() ? '職員' : '社員');
function sevCls(I) { return I > 0.6 ? 'crit' : I > 0.25 ? 'warn' : I > 0.05 ? 'ok' : ''; }
function sevJa(I) { return I > 0.6 ? '甚大' : I > 0.25 ? '大きい' : I > 0.05 ? '限定的' : '影響なし'; }

/* シナリオの現地時刻（t0_iso のオフセットで固定し、閲覧端末のタイムゾーンに依存しない） */
function scenTime(sc, t) {
  const iso = sc.t0_iso || ''; const m = iso.match(/([+-])(\d{2}):(\d{2})$/); const off = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  const base = iso ? Date.parse(iso) : Date.now(); const d = new Date(base + t * 3600e3 + off * 60e3);
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0'); const dow = '日月火水木金土'[d.getUTCDay()];
  return { date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, time: `${hh}:${mm}`, dow, full: `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${dow}）${hh}:${mm}` };
}

/* ---------- 外力（降雨・水位・潮位・放流・風・地震）の推移モデル：パラメータは scenarios.json の forcing（仮定） ---------- */
const gaussB = (x, w) => Math.exp(-0.5 * Math.pow(x / (Math.max(1e-6, w) / 2.355), 2));
const sstep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
function forcingAt(f, t) {
  if (f.kind === 'rain') return (f.base || 0) + sum(f.bursts || [], (b) => b[2] * gaussB(t - b[0], b[1]));
  if (f.kind === 'river' || f.kind === 'flow') { const ph = f.peak_h || 1, hold = f.hold_h || 0; if (t <= ph) return f.start + (f.peak - f.start) * sstep(t / ph); if (t <= ph + hold) return f.peak; return f.peak - (f.peak - f.start) * sstep((t - ph - hold) / (f.fall_h || 100)); }
  if (f.kind === 'tide') return (f.base || 0) + (f.amp || 0) * Math.sin(2 * Math.PI * t / (f.period || 12.4)) + (f.surge || 0) * gaussB(t - (f.surge_h || 0), 48);
  if (f.kind === 'wind') return (f.base || 0) + ((f.peak || 0) - (f.base || 0)) * gaussB(t - (f.peak_h || 0), f.width || 24);
  if (f.kind === 'quake') { const ev = (f.events || []).filter((e) => e[0] <= t); return ev.length ? ev[ev.length - 1][1] : 0; }
  return 0;
}
const fDec = (f) => (/mm|cm|km|m³/.test(f.unit) ? 0 : f.kind === 'quake' ? 1 : 2);
const fmtF = (v, f) => `${fmt(v, fDec(f))} ${f.unit}`;
const forcingSeries = (f, step = 1) => { const v = []; for (let t = 0; t <= 168; t += step) v.push([t, +forcingAt(f, t).toFixed(fDec(f))]); return v; };
const fIcon = (k) => ({ rain: 'cloud', river: 'wave', flow: 'drop', tide: 'wave', wind: 'wind', quake: 'quake' }[k] || 'gauge');
const fColor = (k) => ({ rain: 'var(--c1)', river: 'var(--c2)', flow: 'var(--c3)', tide: 'var(--c4)', wind: 'var(--c6)', quake: 'var(--c5)' }[k] || 'var(--c1)');
function forcingCrossings(f) { /* しきい値の上抜け・下抜け（30 分刻み） */
  const out = []; if (f.kind === 'quake' || !(f.thresholds || []).length) return out;
  let prev = forcingAt(f, 0);
  for (let t = 0.5; t <= 168; t += 0.5) { const v = forcingAt(f, t); f.thresholds.forEach((th, i) => { if (prev < th.v && v >= th.v) out.push({ t, type: 'forcing', sev: Math.min(3, i + 2), where_ja: f.name_ja, ja: `${th.ja} を超過（${fmtF(v, f)}）`, src: f.src || '', key: f.key }); else if (prev >= th.v && v < th.v) out.push({ t, type: 'forcing', sev: 1, where_ja: f.name_ja, ja: `${th.ja} を下回る（${fmtF(v, f)}）`, src: f.src || '', key: f.key }); }); prev = v; }
  return out;
}
function gaugeCard(f, t) {
  const v = forcingAt(f, t), v3 = forcingAt(f, Math.max(0, t - 3)); const d = v - v3; const eps = f.kind === 'quake' ? 0.05 : Math.max(0.01, Math.abs(v) * 0.005);
  const crossed = (f.thresholds || []).filter((th) => v >= th.v); const top = crossed[crossed.length - 1]; const next = (f.thresholds || []).find((th) => v < th.v);
  let cls = crossed.length >= 2 ? 'crit' : crossed.length === 1 ? 'warn' : ''; let body;
  if (f.kind === 'quake') { const evs = (f.events || []).filter((e) => e[0] <= t); const last = evs[evs.length - 1]; const n24 = evs.filter((e) => e[0] > t - 24 && e[1] >= 4.5).length; cls = last && t - last[0] < 24 && last[1] >= 5 ? 'warn' : ''; body = `<div class="v ${cls}">${last ? 'M' + last[1].toFixed(1) : '—'}<small>${last ? `最新（${esc(fmtHours(last[0]))}${last[2] ? '・' + esc(last[2]) : ''}）` : '発生なし'}</small></div><div class="th">直近 24 時間の M4.5 以上：${n24} 回${next ? `・${esc(next.ja)}` : ''}</div>`; }
  else body = `<div class="v ${cls}">${fmt(v, fDec(f))}<small>${esc(f.unit)}</small></div><div class="trend ${d > eps ? 'up' : d < -eps ? 'dn' : ''}">${d > eps ? '上昇' : d < -eps ? '下降' : '横ばい'} ${d > eps || d < -eps ? `${fmt(Math.abs(d), fDec(f))} ${esc(f.unit)} / 3h` : ''}</div><div class="th">${top ? `<span class="tag ${cls}">${esc(top.ja)}</span>` : next ? `次のしきい値「${esc(next.ja)}」まで ${fmt(next.v - v, fDec(f))} ${esc(f.unit)}` : 'しきい値の設定なし'}</div>`;
  return `<div class="gauge"><div class="h">${ic(fIcon(f.kind))}<b>${esc(f.group || '')}</b><span>${esc(f.name_ja.replace(/（.*?）/, ''))}</span></div>${body}</div>`;
}

/* ---------- 被害発生状況フィード：登録済みの事象＋しきい値超過・避難所開設・拠点の稼働変化・対応ログを 1 本に統合 ---------- */
const INC = { flood: ['浸水', 'wave'], road: ['道路', 'car'], rail: ['鉄道', 'train'], airport: ['空港', 'plane'], power: ['停電', 'bolt'], water: ['断水', 'drop'], health: ['医療・衛生', 'heart'], supply: ['物資・供給', 'box'], evac: ['避難', 'route'], collapse: ['倒壊', 'building'], fire: ['火災', 'fire'], forcing: ['外力しきい値', 'gauge'], quake: ['地震', 'quake'], ops: ['対応・体制', 'shield'], req: ['支援要請', 'alert'], site: ['拠点', 'building'], logi: ['物流', 'truck'], shelter: ['避難所', 'home'] };
const INC_CATS = [['all', 'すべて'], ['damage', '被害'], ['forcing', '外力'], ['ops', '対応・拠点']];
function liveFeed(sc) {
  if (sc._feed) return sc._feed;
  const items = (sc.incidents || []).map((i) => Object.assign({ cat: 'damage' }, i));
  (sc.forcing || []).forEach((f) => { forcingCrossings(f).forEach((x) => items.push(Object.assign({ cat: 'forcing' }, x))); if (f.kind === 'quake') (f.events || []).forEach((e) => items.push({ t: e[0], type: 'quake', cat: 'forcing', sev: e[1] >= 6 ? 3 : e[1] >= 5 ? 2 : 1, where_ja: f.name_ja.replace(/（.*?）/, ''), ja: `M${e[1].toFixed(1)} ${e[2] || '余震'}`, src: f.src || '' })); });
  (sc.shelters || []).forEach((s) => items.push({ t: s.open_h || 0, type: 'shelter', cat: 'damage', sev: 1, district: s.district, where_ja: s.name_ja, ja: `避難所を開設（定員 ${fmt(s.cap)} 人）`, src: '自治体' }));
  (sc.timeline || []).forEach((e) => items.push({ t: e.t, type: 'ops', cat: 'ops', sev: e.cls === 'crit' ? 3 : e.cls === 'warn' ? 2 : 1, where_ja: e.who || '', ja: e.ja, detail: e.detail }));
  (sc.requests || []).forEach((q) => { items.push({ t: q.t, type: 'req', cat: 'ops', sev: q.cls === 'crit' ? 3 : 2, where_ja: q.from, ja: `支援要請：${q.what}`, detail: q.detail, admin: true }); if (q.resolved_t != null) items.push({ t: q.resolved_t, type: 'req', cat: 'ops', sev: 1, where_ja: q.from, ja: `要請に対応完了：${q.what}`, admin: true }); });
  (sc.logistics || []).forEach((l) => (l.states || []).forEach((s, i) => { if (i === 0 && s.cls === 'ok') return; items.push({ t: s.t, type: 'logi', cat: 'ops', sev: s.cls === 'crit' ? 3 : s.cls === 'warn' ? 2 : 1, where_ja: l.name_ja, ja: s.ja, detail: s.note }); }));
  if ((sc.sites || []).length) { const prev = {}; for (let t = 0; t <= 168; t++) { sim(sc, t).sites.forEach((s) => { if (prev[s.id] == null) { if (s.op !== '稼働') items.push({ t, type: 'site', cat: 'ops', sev: s.status === 'crit' ? 3 : s.status === 'warn' ? 2 : 1, where_ja: s.name_ja, ja: `稼働状態：${s.op}` }); } else if (prev[s.id] !== s.op) items.push({ t, type: 'site', cat: 'ops', sev: s.status === 'crit' ? 3 : s.status === 'warn' ? 2 : 1, where_ja: s.name_ja, ja: `稼働状態：${prev[s.id]} → ${s.op}` }); prev[s.id] = s.op; }); } }
  items.sort((a, b) => a.t - b.t); sc._feed = items; return items;
}
const countBy = (arr, key) => { const o = {}; arr.forEach((x) => { const k = x[key]; if (!k) return; o[k] = (o[k] || 0) + 1; }); return o; };
function incRow(sc, x, isNew) {
  const d = x.district ? (sc.districts || []).find((dd) => dd.id === x.district) : null; const ty = INC[x.type] || [x.type, 'info'];
  return `<div class="incident${isNew ? ' new' : ''}${x.admin ? ' admin-only' : ''}"><span class="t"><b>${esc(fmtHours(x.t))}</b>${esc(scenTime(sc, x.t).time)}</span><span class="m"><b><i class="sev sev${x.sev || 1}"></i>${esc(x.ja)}</b><span>${esc(x.where_ja || '')}${x.detail ? '　' + esc(x.detail) : ''}</span><span class="meta"><span class="tag neutral">${ic(ty[1])}${esc(ty[0])}</span>${d ? `<span class="tag neutral">${esc(d.name_ja.split('（')[0])}</span>` : ''}${x.src ? `<span class="muted" style="font-size:11px">情報源：${esc(x.src)}（デモ）</span>` : ''}</span></span></div>`;
}
const tlRow = (e) => `<div class="tl ${e.cls || ''}"><span class="t">${esc(fmtHours(e.t))}<b>${esc(e.who || '')}</b></span><span class="m"><b>${esc(e.ja)}</b><span>${esc(e.detail || '')}</span></span></div>`;
const tlFut = (e) => `<div class="tl future"><span class="t">${esc(fmtHours(e.t))}<b>${esc(e.who || '')}</b></span><span class="m"><b>${esc(e.ja)}</b><span>（予定）</span></span></div>`;

/* ---------- 共通部品：イベントカード、ライブヘッダ ---------- */
function feedChips(sc, t) {
  const defs = sc.type === 'quake' ? [['地震速報', 'on'], ['当局速報', 'on'], ['電力・通信', 'lag'], ['自社 安否確認', 'on'], ['SNS 収集', 'on']] : sc.status === 'watch' ? [['気象警報', 'on'], ['水門水位', 'on'], ['交通情報', 'lag'], ['SNS 収集', 'on']] : [['降雨・気象', 'on'], ['河川水位', 'on'], ['当局速報', 'lag'], ['自社 安否確認', 'on'], ['SNS 収集', 'on']];
  return defs.map(([n, s]) => { const lagMin = s === 'lag' ? 35 + (hashStr(n) % 40) : 2 + (hashStr(n + sc.id) % 12); const tm = scenTime(sc, t - lagMin / 60); return `<span class="fd ${s}" title="${esc(n)}：最終受信 ${esc(tm.time)}（デモ値。実運用では各フィードの受信時刻）"><i></i>${esc(n)} ${esc(tm.time)}</span>`; }).join('');
}
function sparkline(values, now, color) {
  const maxX = Math.max(1, ...values.map((p) => p[0])); const ys = values.map((p) => p[1]); const maxY = Math.max(1e-9, ...ys), minY = Math.min(...ys); const W = 200, H = 30;
  const X = (x) => (x / maxX) * W, Y = (y) => H - 3 - ((y - minY) / Math.max(1e-9, maxY - minY)) * (H - 6);
  const d = values.map(([x, y], i) => (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(y).toFixed(1)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${W} ${H}L0 ${H}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/><line x1="${X(now).toFixed(1)}" x2="${X(now).toFixed(1)}" y1="0" y2="${H}" stroke="var(--fg2)" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/></svg>`;
}
function eventCards(cur) {
  return `<div class="ev-cards">${M.scenarios().map((sc) => { const t = Live.t(sc); const watch = sc.status === 'watch'; const r = sim(sc, t); const tm = scenTime(sc, 0); const series = sc._spark || (sc._spark = watch ? forcingSeries(sc.forcing[0], 2) : simSeries(sc, 'affected', 4)); const nSites = M.sites().filter((s) => (sc.sites || []).some((x) => x.id === s.id) || (sc.supply_sites || []).includes(s.id)).length; return `<button class="evcard${watch ? ' watch' : ''}" data-ev="${esc(sc.id)}" aria-pressed="${sc.id === cur}"><span class="where">${esc(sc.country_ja || '')} · ${esc(sc.city_ja || '')}</span><div class="h"><b>${esc(sc.hazard_ja || sc.short_ja)}</b><span class="tag ${watch ? 'warn' : 'crit'}">${watch ? '警戒中' : '発生中'}</span></div><div class="kv"><span>${watch ? '警報' : '発生'} <b>${esc(tm.full)}</b></span><span>経過 <b>${esc(fmtHours(t))}</b></span>${watch ? `<span>24h 雨量 <b>${fmt(forcingAt(sc.forcing[0], t))} mm</b></span>` : `<span>影響人口 <b>${fmtC(r.kpi.affected)}</b></span>`}<span>拠点 <b>${watch ? `${nSites} 監視中` : `${r.kpi.sitesDown}/${r.sites.length} 停止`}</b></span></div><div class="spark">${sparkline(series, t, watch ? 'var(--warn)' : 'var(--crit)')}</div></button>`; }).join('')}</div>`;
}
function liveHead(sc, t, { compact = false, idp = 'lb' } = {}) {
  const watch = sc.status === 'watch'; const tm = scenTime(sc, t); const playing = Live.st.playing && !compact;
  return `<div class="live-head${watch ? ' watch' : ''}${compact ? ' compact' : ''}" id="${idp}Head">
    <div class="ttl"><span class="live-dot"><i></i>${watch ? 'WATCH' : 'LIVE'} · DEMO</span><b>${esc(sc.country_ja || '')}・${esc(sc.city_ja || '')}　${esc(sc.hazard_ja || sc.name_ja)}</b>${compact ? '' : `<span>${esc(sc.desc_ja || '')}</span>`}<div class="feedbar" id="${idp}Feeds">${feedChips(sc, t)}</div></div>
    <div class="clock" id="${idp}Clock" aria-live="off">${esc(tm.time)}<small>${esc(tm.date)}（${esc(tm.dow)}）現地時刻 · ${esc(fmtHours(t))}</small></div>
    <div class="t"><div class="row"><span>${watch ? '警報発表' : '発災'}からの経過（スライダーで時刻を移動）</span><b class="lb-t">${esc(fmtHours(t))}</b></div><input type="range" class="lb-range" id="${idp}Range" min="0" max="168" step="0.25" value="${t}" aria-label="発災からの経過時間"><div class="ctr">${compact ? `<a class="btn sm" href="#live" data-golive="${esc(sc.id)}">${ic('layers')}リアルタイムレポーティングで詳しく</a>` : `<select class="lb-scen" id="${idp}Scen" aria-label="イベント">${M.scenarios().map((s) => `<option value="${s.id}"${s.id === sc.id ? ' selected' : ''}>${esc(s.short_ja || s.name_ja)}</option>`).join('')}</select><button class="btn sm lb-play" id="${idp}Play" aria-pressed="${playing}">${ic(playing ? 'pause' : 'play')}${playing ? '一時停止' : '再生'}</button><span class="muted" style="font-size:11px">${playing ? '再生中：実時間 4 秒＝シナリオ 1 時間' : '自動でシナリオ時刻を進める'}</span>`}</div></div></div>`;
}
const kpiTile = (x) => `<div class="kpi ${x.c || ''}${x.adm ? ' admin-only' : ''}"><span class="v">${x.v}<small>${esc(x.u || '')}</small></span><span class="l">${esc(x.l)}</span>${x.d || ''}<span class="s">${esc(x.s || '')}</span></div>`;

/* ---------- 画面本体 ---------- */
App.views.live = {
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">02 · Live reporting</span><span class="aud">${ic('users')}想定読者：対策本部・リスク管理責任者（管理者）と従業員</span></div>
          <h1>進行中の災害を、<em>時間を追って</em>見る</h1>
          <p class="q"><b>問い：</b>いま、どの国・都市でどんな災害が進行しているか。外力（降雨・水位・揺れ）はどう推移し、被害はどこまで広がり、拠点と取引先はどうなっているか。</p>
        </div>
        <div class="vh-r"><span class="tag crit">${ic('alert')}シナリオ再生（デモデータ）</span><span class="tag neutral">スライダーで任意の時刻に戻せます</span></div>
      </div>
      <div id="evCards"></div>
      <div id="headSlot"></div>
      <div class="tabs" role="tablist" id="liveTabs"></div>
      <div class="tabpanel" id="livePanel"></div>`;
    root.addEventListener('click', (e) => {
      const ev = e.target.closest('[data-ev]'); if (ev) { self.pick(ev.dataset.ev, root); return; }
      const tb = e.target.closest('[data-tab]'); if (tb) { Live.st.tab = tb.dataset.tab; Store.set('liveTab', Live.st.tab); self.renderPanel(root); return; }
      const ct = e.target.closest('[data-cat]'); if (ct) { Live.st.incCat = ct.dataset.cat; self.renderPanel(root); return; }
      const mb = e.target.closest('[data-more]'); if (mb) { const tl = $('#' + mb.dataset.more, root); tl.classList.toggle('collapsed'); mb.textContent = tl.classList.contains('collapsed') ? `さらに表示（残り ${tl.children.length - 7} 件）` : '折りたたむ'; return; }
      const cp = e.target.closest('[data-copy]'); if (cp) copyText(cp.dataset.copy, cp);
    });
    document.addEventListener('ctxchange', () => { if (App.current === 'live') self.renderPanel(root); });
    this.update(root);
    if (!Live.st.autoStarted) { Live.st.autoStarted = true; this.togglePlay(root, true); }
  },
  show(root) { this.update(root); if (Live.st.playing) this.togglePlay(root, true); },
  pick(id, root) { if (id === Live.st.scen) return; Live.st.scen = id; Store.set('liveScen', id); Live.st.incCat = 'all'; this.update(root); if (Live.st.playing) this.togglePlay(root, true); },
  togglePlay(root, on) {
    const self = this; const want = on == null ? !Live.st.playing : on;
    if (!want) Live.stop(); else Live.play((kind) => { if (kind === 'end') { self.renderHead(root); return; } self.renderClock(root); if (kind === 'hour') { self.renderPanel(root); self.renderCards(root); } });
    this.renderHead(root);
  },
  update(root) { this.renderCards(root); this.renderHead(root); this.renderPanel(root); },
  renderCards(root) { $('#evCards', root).innerHTML = eventCards(Live.st.scen); },
  renderHead(root) {
    const sc = Live.scenario(); const t = Live.t(); const self = this;
    $('#headSlot', root).innerHTML = liveHead(sc, t);
    $('#lbRange', root).oninput = (e) => { Live.setT(+e.target.value); if (Live.st.playing) { Live.stop(); const pb = $('#lbPlay', root); pb.innerHTML = ic('play') + '再生'; pb.setAttribute('aria-pressed', 'false'); pb.nextElementSibling.textContent = '自動でシナリオ時刻を進める'; } self.renderClock(root); cancelAnimationFrame(self._raf); self._raf = requestAnimationFrame(() => { self.renderPanel(root); self.renderCards(root); }); };
    $('#lbScen', root).onchange = (e) => self.pick(e.target.value, root);
    $('#lbPlay', root).onclick = () => self.togglePlay(root);
  },
  renderClock(root) {
    const sc = Live.scenario(); const t = Live.t(); const tm = scenTime(sc, t);
    const c = $('#lbClock', root); if (c) c.innerHTML = `${esc(tm.time)}<small>${esc(tm.date)}（${esc(tm.dow)}）現地時刻 · ${esc(fmtHours(t))}</small>`;
    const r = $('#lbRange', root); if (r && +r.value !== t) r.value = t; const lt = $('.lb-t', root); if (lt) lt.textContent = fmtHours(t); const f = $('#lbFeeds', root); if (f) f.innerHTML = feedChips(sc, t);
  },
  renderTabs(root) {
    const sc = Live.scenario(); const t = Live.t(); const feed = liveFeed(sc).filter((x) => x.t <= t && (!x.admin || !Ctx.isStaff())); const newN = feed.filter((x) => x.t > t - 6).length;
    const tabs = [['overview', 'layers', '被害全体像'], ['forcing', 'gauge', '外力状況'], ['incidents', 'alert', '被害発生状況', feed.length, newN], ['sites', 'building', '拠点・サプライチェーン']];
    $('#liveTabs', root).innerHTML = tabs.map(([k, i, l, n, nn]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${Live.st.tab === k}">${ic(i)}${l}${n != null ? `<span class="n${nn ? ' crit' : ''}" title="累計 ${n} 件（うち直近 6 時間 ${nn} 件）">${n}</span>` : ''}</button>`).join('');
  },
  renderPanel(root) {
    const sc = Live.scenario(); const t = Live.t(); const r = sim(sc, t); const box = $('#livePanel', root); this.renderTabs(root);
    const tab = Live.st.tab;
    if (tab === 'forcing') panelForcing(box, sc, t); else if (tab === 'incidents') panelIncidents(box, sc, r, t); else if (tab === 'sites') panelSites(box, sc, r, t); else panelOverview(box, sc, r, t);
    if (window.updateScales) setTimeout(window.updateScales, 20);
  },
};

/* ---------- タブ1：被害全体像 ---------- */
function panelOverview(box, sc, r, t) {
  if (sc.status === 'watch') { watchOverview(box, sc, r, t); return; }
  const k = r.kpi; const k24 = t >= 24 ? sim(sc, t - 24).kpi : null; const tm = scenTime(sc, t);
  const dlt = (key, f = fmtC, inv = false) => { if (!k24) return ''; const d = k[key] - k24[key]; if (!d) return '<span class="d">±0 / 24h</span>'; const up = d > 0; return `<span class="d ${(up !== inv) ? 'up' : 'dn'}">${up ? '+' : '−'}${f(Math.abs(d))} / 24h</span>`; };
  const nextA = (sc.actions || []).filter((a) => a.t <= t && t < a.t + 48)[0];
  const kpis = [
    { v: fmt(k.affected), u: '人', l: '影響人口（推計）', c: 'crit', s: '区別の曝露率×人口', d: dlt('affected') },
    { v: fmt(k.evac), u: '人', l: '避難者（推計）', c: 'warn', s: `避難所 ${fmt(k.shelterOcc)}/${fmt(k.shelterCap)}${k.shelterOver ? `（定員超過 ${fmt(k.shelterOver)}）` : ''}`, d: dlt('evac') },
    { v: fmt(k.staff - k.confirmed), u: `/${fmt(k.staff)}人`, l: `安否未確認の${STAFF_JA()}`, c: k.staff - k.confirmed > 0 ? 'crit' : 'ok', s: `確認率 ${fmtPct(k.confirmed / Math.max(1, k.staff))}`, d: dlt('confirmed', fmt, true) },
    { v: fmt(k.dead), u: '人', l: `死者（確認・推計）／負傷 ${fmt(k.inj)}`, c: 'crit', s: sc.type === 'quake' ? `最終見込み 約${fmt(Math.round(k.deadFinal / 1000) * 1000)} 人（MMEIRS の M7.2 想定は約 34,000 人）` : `最終見込み 約${fmt(k.deadFinal)} 人（2011 年実績 877 人・EM-DAT）`, d: dlt('dead', fmt) },
    { v: `${k.sitesDown}/${r.sites.length}`, u: '拠点', l: '操業停止の拠点', c: k.sitesDown ? 'crit' : 'ok', s: r.sites.filter((s) => s.status === 'warn').length + ' 拠点が縮退' },
    { v: fmtPct(k.fulfil), u: '', l: '物資充足率（平均）', c: k.fulfil < 0.5 ? 'crit' : k.fulfil < 0.8 ? 'warn' : 'ok', s: '需要に対する到着済み', adm: true },
    { v: fmt(k.jp), u: '人', l: '影響を受ける在留邦人（推計）', c: 'warn', s: '区別の在留邦人推計×曝露率', d: dlt('jp', fmt) },
  ];
  box.innerHTML = `<div class="answer"><span class="k">状況</span><ul><li><b>${esc(tm.full)} 時点：</b>影響人口 ${fmtC(k.affected)} 人、避難者 ${fmtC(k.evac)} 人、拠点 ${k.sitesDown}/${r.sites.length} が停止、${STAFF_JA()}の安否未確認 ${fmt(k.staff - k.confirmed)} 名。</li><li><b>次の動き：</b>${r.upcoming[0] ? `${esc(fmtHours(r.upcoming[0].t))} ${esc(r.upcoming[0].ja)}。` : '予定された主要イベントはありません。'}${nextA ? `<span class="admin-only"> 推奨アクション：${esc(nextA.ja)}。</span>` : ''}</li></ul></div>
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    <div class="grid map"><div class="card flush"><div class="map-box tall"><svg id="lsMap" role="img" aria-label="被害分布図"></svg><div class="legend" id="lsLegend"></div><div class="attr">Natural Earth · 被害分布はシナリオ値</div></div></div><div class="stack" id="lsSide"></div></div>
    <section class="sec" id="lsDist"></section><section class="sec admin-only" id="lsSupply"></section><section class="sec" id="lsTrend"></section><section class="sec" id="lsFeeds"></section>`;
  /* 地図：州・県単位の集計（複数の区が同じ州・県に属する場合は人口加重） */
  const agg = {}; r.districts.forEach((d) => { const a = agg[d.adm1] || (agg[d.adm1] = { pop: 0, wI: 0, affected: 0, evac: 0, n: 0, depth: 0 }); a.pop += d.pop; a.wI += d.pop * d.I; a.affected += d.affected; a.evac += d.evac; a.n++; a.depth = Math.max(a.depth, d.depth || 0); });
  Object.values(agg).forEach((a) => { a.I = a.pop ? a.wI / a.pop : 0; });
  const proj = renderRegionMap($('#lsMap', box), { bbox: sc.bbox, labels: true, level: (f) => { const a = agg[f.properties.id]; if (!a) return (sc.map_adm1 || []).includes(f.properties.id) ? 'b1' : ''; const I = a.I; return I > 0.6 ? 'b5' : I > 0.4 ? 'b4' : I > 0.2 ? 'b3' : I > 0.05 ? 'b2' : 'b1'; }, tip: (f) => { const a = agg[f.properties.id]; return `<b>${esc(f.properties.n)}</b>${a ? `<div class="r"><span>被害（${a.n} 区の加重）</span><span>${sevJa(a.I)}${sc.type === 'flood' ? `・最大浸水 ${a.depth.toFixed(1)} m` : ''}</span></div><div class="r"><span>影響人口</span><span>${fmt(a.affected)}</span></div><div class="r"><span>避難者</span><span>${fmt(a.evac)}</span></div>` : '<div class="r"><span class="muted">シナリオ対象外</span></div>'}`; }, sites: r.sites.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: `${s.name_ja}：${s.op}`, status: s.status })), onSite: (id) => { const s = r.sites.find((x) => x.id === id); toast(s ? `${s.name_ja}：${s.op}・安否確認 ${fmt(s.confirmed)}/${fmt(s.staff)}` : id); } });
  const svg = $('#lsMap', box); const bub = r.districts.filter((d) => d.lat && d.lon).map((d) => { const [x, y] = proj([d.lon, d.lat]); const rad = 4 + Math.sqrt(d.affected / 1000) * 1.1; return `<g class="bub" style="pointer-events:none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="var(--${d.I > 0.6 ? 'crit' : d.I > 0.25 ? 'warn' : 'accent'})" opacity=".55" stroke="var(--surface)" stroke-width="1"/><text class="m-label s" x="${(x + rad + 2).toFixed(1)}" y="${(y + 3).toFixed(1)}">${esc(d.name_ja)}</text></g>`; }).join('');
  svg.insertAdjacentHTML('beforeend', `<g class="g-bub">${bub}</g>`);
  $('#lsLegend', box).innerHTML = `<span class="t">${sc.type === 'flood' ? '浸水の程度' : '揺れ・建物被害'}</span><span><i style="background:var(--b5)"></i>甚大</span><span><i style="background:var(--b3)"></i>中程度</span><span><i style="background:var(--b1)"></i>軽微・なし</span>${bub ? '<span><i style="background:var(--crit);opacity:.6;border-radius:50%"></i>区の影響人口（円の大きさ）</span>' : ''}<span><i style="background:var(--sel);border-radius:50%"></i>自社拠点（色＝稼働状況）</span>`;
  /* 右：拠点の状況・支援要請 */
  const qs = (sc.requests || []).filter((q) => q.t <= t).map((q) => Object.assign({}, q, { st: q.resolved_t != null && t >= q.resolved_t ? 'done' : q.ack_t != null && t >= q.ack_t ? 'ack' : 'open' })); const open = qs.filter((q) => q.st === 'open'), ack = qs.filter((q) => q.st === 'ack'), done = qs.filter((q) => q.st === 'done'); const oldest = open.length ? Math.max(...open.map((q) => t - q.t)) : 0;
  $('#lsSide', box).innerHTML = `
    <div class="card"><div class="card-h"><h2>拠点の状況</h2><span class="r"><span class="tag neutral">${esc(fmtHours(t))} 時点</span></span><span class="sub">${r.sites.some((s) => !M.sites().find((x) => x.id === s.id)) ? '拠点 ' + r.sites.filter((s) => !M.sites().find((x) => x.id === s.id)).map((s) => s.label).join('・') + ' はシナリオ用の簡易登録（備え評価なし）。詳細は「拠点・サプライチェーン」タブ。' : '詳細は「拠点・サプライチェーン」タブ。'}</span></div><div class="tbl-wrap"><table><thead><tr><th>拠点</th><th>稼働</th><th class="n">安否確認</th></tr></thead><tbody>${r.sites.map((s) => `<tr><td><b>${esc(s.label)} ${esc(s.short_ja)}</b><span class="sub">${esc(s.district_ja || '')}</span></td><td><span class="tag ${s.status}">${esc(s.op)}</span></td><td class="n">${fmt(s.confirmed)}/${fmt(s.staff)}<span class="sub">${fmtPct(s.resp)}</span></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card admin-only"><div class="card-h"><h2>支援要請</h2><span class="r"><span class="tag crit">未対応 ${open.length}</span><span class="tag warn">対応中 ${ack.length}</span><span class="tag ok">完了 ${done.length}</span></span>${open.length ? `<span class="sub">最も古い未対応は発生から ${fmt(Math.round(oldest))} 時間経過</span>` : ''}</div><div class="timeline">${qs.filter((q) => q.st !== 'done').map((q) => `<div class="tl ${q.st === 'open' ? (q.cls || '') : ''}"><span class="t">${esc(fmtHours(q.t))}<b>${esc(q.from)}</b></span><span class="m"><b>${esc(q.what)} <span class="tag ${q.st === 'open' ? 'crit' : 'warn'}">${q.st === 'open' ? '未対応' : '対応中'}</span></b><span>${esc(q.detail || '')}</span></span></div>`).join('') || '<div class="empty">未対応・対応中の要請はありません</div>'}${done.length ? `<details class="more" style="margin-top:8px"><summary>${ic('chev')}完了した要請（${done.length}）</summary><div class="body"><ul>${done.map((q) => `<li>${esc(fmtHours(q.t))} ${esc(q.from)}：${esc(q.what)}（${esc(fmtHours(q.resolved_t))} 完了）</li>`).join('')}</ul></div></details>` : ''}</div></div>`;
  /* 被災者の分布 */
  const ds = r.districts.slice().sort((a, b) => b.affected - a.affected);
  $('#lsDist', box).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>被災者の分布</h2><span class="r"><span class="tag neutral">${ds.length} 区・市</span></span><p>区ごとの影響人口・避難者・要配慮者（高齢者・乳幼児・障害など 14% と仮定）・在留邦人の推計。避難所の収容は区内の主要避難所の合計。</p></div>
    <div class="tbl-wrap"><table><thead><tr><th>区・市</th><th>被害</th>${sc.type === 'flood' ? '<th class="n">浸水深</th>' : '<th class="n">揺れ</th>'}<th class="n">人口</th><th class="n">影響人口</th><th class="n">避難者</th><th class="n">要配慮者</th><th class="n">在留邦人</th><th>避難所</th></tr></thead><tbody>${ds.map((d) => { const shs = r.shelters.filter((s) => s.district === d.id); return `<tr><td><b>${esc(d.name_ja)}</b><span class="sub">${esc(d.note_ja || '')}</span></td><td><span class="tag ${sevCls(d.I) || 'neutral'}">${sevJa(d.I)}</span></td><td class="n">${sc.type === 'flood' ? (d.depth > 0 ? d.depth + ' m' : '—') : esc(d.intensity_ja || '—')}</td><td class="n">${fmt(d.pop)}</td><td class="n"><b>${fmt(d.affected)}</b></td><td class="n">${fmt(d.evac)}</td><td class="n">${fmt(d.vuln)}</td><td class="n">${fmt(d.jp)}</td><td style="font-size:12px">${shs.map((s) => s.open ? `<span class="tag ${s.over > 0 ? 'crit' : s.occ > s.cap * 0.8 ? 'warn' : 'ok'}">${esc(s.name_ja)} ${fmt(s.occ)}/${fmt(s.cap)}${s.over > 0 ? `（超過 +${fmt(s.over)}）` : ''}</span>` : `<span class="tag neutral">${esc(s.name_ja)} 開設前（${esc(fmtHours(s.open_h || 0))} 予定）</span>`).join(' ') || '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  /* 物資需給（対策本部向け） */
  $('#lsSupply', box).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>支援・物資の需給</h2><span class="r"><span class="tag ${k.fulfil < 0.5 ? 'crit' : k.fulfil < 0.8 ? 'warn' : 'ok'}">充足率 ${fmtPct(k.fulfil)}</span><span class="tag neutral">管理者向け</span></span><p>需要＝避難者数×1 人あたり必要量（Sphere 基準などを参考）。供給＝到着済み（在庫＋輸送）。縦線が需要、棒が供給。</p></div>
    <div class="grid c2">
      <div class="card"><div class="card-h"><h2>品目別</h2><span class="sub">数値は 到着済み／需要（k＝千、M＝百万）</span></div>${r.supplies.map((s) => `<div class="sup-row"><span class="k">${ic(s.icon || 'box')}${esc(s.name_ja)}<span class="muted" style="font-size:10.5px">${esc(s.unit)}</span></span><span class="track"><i class="sup" style="width:${clamp(s.rate * 100 / 1.2, 0, 100).toFixed(1)}%;background:${s.rate >= 1 ? 'var(--ok)' : s.rate >= 0.6 ? 'var(--warn)' : 'var(--crit)'}"></i><i class="dem" style="left:${(100 / 1.2).toFixed(1)}%"></i></span><span class="v ${s.rate < 0.6 ? 'gap' : s.rate >= 1 ? 'okv' : ''}" title="${fmt(s.got)}／${fmt(s.need)}">${fmtC(s.got)}/${fmtC(s.need)}<span class="sub">${s.rate < 1 ? `不足 ${fmtC(s.need - s.got)}` : '充足'}</span></span></div>`).join('')}<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(sc.supply_note_ja || '')}</span></div></div>
      <div class="card"><div class="card-h"><h2>物流・輸送の状況</h2></div><div class="status-grid">${(sc.logistics || []).map((l) => { const st = l.states.filter((s) => s.t <= t).slice(-1)[0] || l.states[0]; return `<div class="st ${st.cls}"><div class="h">${ic(l.icon || 'car')}${esc(l.name_ja)}</div><div class="eta" style="font-size:13px;color:var(--fg)">${esc(st.ja)}</div><div class="eta">${esc(st.note || '')}</div></div>`; }).join('')}</div><div class="card-h" style="margin-top:14px"><h3>今後 48 時間の推奨アクション</h3></div><ul style="margin:0;padding-left:18px;font-size:13px">${(sc.actions || []).filter((a) => a.t <= t && t < a.t + 48).map((a) => `<li><b>${esc(a.ja)}</b>${a.why ? `<span class="muted"> — ${esc(a.why)}</span>` : ''}</li>`).join('') || `<li><b>復旧フェーズの定常対応</b><span class="muted"> — 設備点検・保険申請・家族の生活再建支援・従業員のメンタルケアを続ける</span></li>`}</ul></div>
    </div>`;
  /* 推移 */
  const nTl = r.log.length + r.upcoming.length;
  $('#lsTrend', box).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>推移と対応ログ</h2></div><div class="grid c2"><div class="card"><div class="card-h"><h2>影響人口・避難者</h2></div><div class="chart" id="lsChart"></div><div class="chart-cap"><span><i class="ln" style="background:var(--c5)"></i>影響人口</span><span><i class="ln" style="background:var(--c2)"></i>避難者</span><span><i class="ln" style="background:var(--fg2);opacity:.5"></i>点線＝見込み</span></div><div class="card-h" style="margin-top:12px"><h3>${STAFF_JA()}の安否確認率</h3></div><div class="chart" id="lsChart2"></div></div>
    <div class="card"><div class="card-h"><h2>対応ログ</h2><span class="r"><span class="tag neutral">${r.log.length} 件</span></span></div><div class="timeline${nTl > 8 ? ' collapsed' : ''}" id="lsTimeline">${r.log.slice().reverse().map(tlRow).join('')}${r.upcoming.map(tlFut).join('')}</div>${nTl > 8 ? `<button class="btn sm more-btn" data-more="lsTimeline">さらに表示（残り ${nTl - 7} 件）</button>` : ''}</div></div>`;
  lineChart($('#lsChart', box), { now: t, yLabel: '影響人口と避難者の推移（発災からの時間）', series: [{ name: '影響人口', color: 'var(--c5)', values: simSeries(sc, 'affected') }, { name: '避難者', color: 'var(--c2)', values: simSeries(sc, 'evac') }], yFmt: (v) => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : fmt(v) });
  lineChart($('#lsChart2', box), { now: t, height: 150, yLabel: '安否確認率の推移', series: [{ name: '安否確認率', color: 'var(--c1)', values: simSeries(sc, (x) => x.kpi.staff ? x.kpi.confirmed / x.kpi.staff : 0) }], yFmt: (v) => fmtPct(v) });
  feedsSection($('#lsFeeds', box), sc, '05');
}
/* 本番で接続するフィード（公開データ一覧から、全球と当該国のもの） */
function feedsSection(box, sc, no) {
  const feeds = M.feeds(); const cj = COUNTRY_JA[sc.country] || ''; const allC = Object.values(COUNTRY_JA);
  const txt = (f) => `${f.name} ${f.provider || ''} ${f.covers_ja || ''}`;
  const isCountry = (f) => cj && (txt(f).includes(cj) || txt(f).includes(sc.country));
  const isGlobal = (f) => !allC.some((n) => txt(f).includes(n)) && !/Thai|BMKG|BNPB|PHIVOLCS|PAGASA|NDRRMC|NADMA|SCDF|NEA|VNDMA|MEA|PEA|MWA|DDPM|BMA|Air4Thai|HII|Malaysia|Singapore|Viet|Philippine|Indonesia/.test(txt(f));
  const shown = feeds.filter(isGlobal).slice(0, 10).concat(feeds.filter(isCountry).slice(0, 10));
  const feedRow = (f) => `<div class="feed"><div><b>${esc(f.name)} <span class="muted" style="font-weight:400">· ${esc(f.provider || '')}</span></b><span>${esc(f.use_in_app_ja || f.covers_ja || '')}</span>${f.api ? `<span class="mono" style="font-size:10.5px;color:var(--muted);word-break:break-all">${esc(f.api)}</span>` : ''}</div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="tag neutral">${esc(f.format || '')}</span>${f.url ? `<a class="cite" href="${esc(f.url)}" target="_blank" rel="noopener">${ic('link')}公式</a>` : ''}<span class="tag ${f.confirmed_by === 'third_party' ? 'neutral' : 'warn'}" title="${f.confirmed_by === 'third_party' ? 'クライアント実装等で URL を確認（公式ページ本体は未取得）' : '未検証'}">${f.confirmed_by === 'third_party' ? 'URL 確認済' : '要確認'}</span><span class="tag warn">未接続</span></div></div>`;
  box.innerHTML = `<details class="more"><summary>${ic('chev')}<span class="no" style="font-family:var(--f-mono);font-size:11px;color:var(--accent);font-weight:600;margin-right:8px">${no}</span>本番では何につなぐか（公開フィード ${shown.length} 件・現在は未接続）</summary><div class="body"><p style="margin:0 0 10px;color:var(--fg2);font-size:13px">この画面の各パネルに対応する公開フィード（全球のものと ${esc(cj)} 向けのもの）。現在はすべてデモ値です。API の URL は GitHub 上のクライアント実装などで確認したもので、利用規約・レート制限は各公式ページで要確認です。</p><div class="card feeds">${shown.map(feedRow).join('') || '<div class="empty">フィード一覧なし</div>'}</div></div></details>`;
}
/* 警戒段階（被害なし）の全体像 */
function watchOverview(box, sc, r, t) {
  const fs = sc.forcing || []; const feed = liveFeed(sc).filter((x) => x.t <= t); const tm = scenTime(sc, t);
  const lvl = (f) => { const v = forcingAt(f, t); const c = (f.thresholds || []).filter((th) => v >= th.v); return c.length ? c[c.length - 1] : null; };
  const gates = fs.filter((f) => f.kind !== 'rain'); const rain = fs.find((f) => f.kind === 'rain');
  const worst = gates.map((f) => ({ f, l: lvl(f) })).filter((x) => x.l).sort((a, b) => b.f.thresholds.indexOf(b.l) - a.f.thresholds.indexOf(a.l))[0];
  const sites = (sc.supply_sites || []).map((id) => M.sites().find((s) => s.id === id)).filter(Boolean);
  const acts = (sc.actions || []); const nextA = acts.filter((a) => a.t <= t).slice(-1)[0] || acts[0];
  const dmg = feed.filter((x) => x.cat === 'damage');
  box.innerHTML = `<div class="answer"><span class="k">状況</span><ul><li><b>${esc(tm.full)} 時点：</b>警報は継続中。被害の報告は ${dmg.length} 件（いずれも軽微）。${worst ? `${esc(worst.f.name_ja.split('（')[0])} が「${esc(worst.l.ja)}」。` : '水門・河川はいずれも基準値未満。'}</li><li><b>判断：</b>${esc(nextA ? nextA.ja : '通常勤務を継続し、朝の通勤前に再確認')}。</li></ul></div>
    <div class="kpis">${[
      { v: '継続', u: '', l: '大雨警報（気象当局）', c: 'warn', s: `発表から ${fmtHours(t)}` },
      rain ? { v: fmt(forcingAt(rain, t)), u: 'mm', l: '24 時間雨量（観測所）', c: lvl(rain) ? 'crit' : 'warn', s: lvl(rain) ? lvl(rain).ja : `しきい値 ${rain.thresholds[0].v} mm 未満` } : null,
      ...gates.map((f) => ({ v: fmt(forcingAt(f, t)), u: f.unit, l: f.name_ja.split('（')[0], c: lvl(f) ? (f.thresholds.indexOf(lvl(f)) >= 1 ? 'crit' : 'warn') : 'ok', s: lvl(f) ? lvl(f).ja : '基準値未満' })),
      { v: fmt(dmg.length), u: '件', l: '被害の報告', c: dmg.length ? 'warn' : 'ok', s: dmg.length ? '道路冠水・局所浸水など' : '報告なし' },
      { v: `${sites.length}`, u: '拠点', l: '監視中の拠点', c: 'ok', s: sites.map((s) => s.label + ' 通常稼働').join('・') || '—' },
    ].filter(Boolean).map(kpiTile).join('')}</div>
    <div class="grid map"><div class="card flush"><div class="map-box tall"><svg id="lsMap" role="img" aria-label="警戒範囲"></svg><div class="legend" id="lsLegend"><span class="t">凡例</span><span><i style="background:var(--b2)"></i>警報の対象地域</span><span><i style="background:var(--sel);border-radius:50%"></i>自社拠点</span></div><div class="attr">Natural Earth · 警戒範囲はシナリオ値</div></div></div>
      <div class="stack"><div class="card"><div class="card-h"><h2>監視しているしきい値</h2><span class="r">${asmTag('基準値は要確認')}</span></div><div class="gauges" style="grid-template-columns:1fr">${fs.map((f) => gaugeCard(f, t)).join('')}</div></div>
      <div class="card admin-only"><div class="card-h"><h2>対応・判断（対策本部）</h2><span class="r"><span class="tag neutral">管理者向け</span></span></div><ul style="margin:0;padding-left:18px;font-size:13px">${acts.map((a) => `<li${a.t > t ? ' class="muted"' : ''}><b>${esc(a.ja)}</b>${a.why ? `<span class="muted"> — ${esc(a.why)}</span>` : ''}${a.t > t ? ` <span class="tag neutral">${esc(fmtHours(a.t))} 予定</span>` : ''}</li>`).join('')}</ul></div>
      <div class="card"><div class="card-h"><h2>経過</h2></div><div class="timeline">${r.log.slice().reverse().map(tlRow).join('')}${r.upcoming.map(tlFut).join('')}</div></div></div></div>`;
  renderRegionMap($('#lsMap', box), { bbox: sc.bbox, labels: true, level: (f) => ((sc.map_adm1 || []).includes(f.properties.id) ? 'b2' : ''), tip: (f) => `<b>${esc(f.properties.n)}</b><div class="r"><span>${(sc.map_adm1 || []).includes(f.properties.id) ? '警報の対象' : '対象外'}</span></div>`, sites: sites.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: `${s.name_ja}：通常稼働・監視中`, status: 'ok' })), onSite: (id) => { const s = sites.find((x) => x.id === id); toast(s ? `${s.name_ja}：通常稼働・監視中` : id); } });
}

/* ---------- タブ2：外力状況 ---------- */
function panelForcing(box, sc, t) {
  const fs = sc.forcing || [];
  box.innerHTML = `<div class="sec-h"><h2>外力の状況</h2><span class="r"><span class="tag neutral">${fs.length} 系列</span>${asmTag('推移は仮定')}</span><p>降雨・河川水位・潮位・放流量・地震・風の推移としきい値。実線は現在まで、点線は見込み。しきい値を超えると「被害発生状況」に自動で記録されます。本番では各国の気象・水文当局のフィード（「本番では何につなぐか」参照）に置き換えます。</p></div>
    <div class="gauges">${fs.map((f) => gaugeCard(f, t)).join('')}</div>
    <div class="grid c2">${fs.map((f, i) => `<div class="card"><div class="card-h"><h2>${esc(f.name_ja)}</h2><span class="r">${f.src ? (/仮定/.test(f.src) ? `<span class="tag asm" title="${esc(f.src)}">仮定</span>` : `<span class="tag src" title="${esc(f.src)}">${esc(f.src.length > 28 ? f.src.slice(0, 28) + '…' : f.src)}</span>`) : ''}</span></div><div class="chart" id="fc-${i}"></div>${(f.thresholds || []).length ? `<div class="chart-cap">${f.thresholds.map((th) => `<span><i class="ln" style="background:var(--warn)"></i>${esc(th.ja)}：${fmtF(th.v, f)}</span>`).join('')}</div>` : ''}</div>`).join('')}</div>`;
  fs.forEach((f, i) => { const el = $(`#fc-${i}`, box); if (f.kind === 'quake') stemChart(el, { events: f.events || [], now: t, yLabel: f.name_ja, thresholds: f.thresholds || [] }); else lineChart(el, { now: t, height: 190, yLabel: f.name_ja, yMin: f.kind === 'river' || f.kind === 'tide' ? null : 0, thresholds: f.thresholds || [], series: [{ name: f.unit, color: fColor(f.kind), values: forcingSeries(f) }], yFmt: (v) => fmt(v, fDec(f) ? 1 : 0) }); });
}

/* ---------- タブ3：被害発生状況 ---------- */
function panelIncidents(box, sc, r, t) {
  const all = liveFeed(sc); const past = all.filter((x) => x.t <= t); const cat = Live.st.incCat || 'all';
  const lastT = Live.st.seen[sc.id]; Live.st.seen[sc.id] = t;
  const shown = past.filter((x) => cat === 'all' || x.cat === cat).slice().reverse().slice(0, 80);
  const byType = countBy(past, 'type'), byDist = countBy(past.filter((x) => x.cat === 'damage'), 'district');
  const dName = (id) => { const d = (sc.districts || []).find((x) => x.id === id); return d ? d.name_ja.split('（')[0] : id; };
  const fut = all.filter((x) => x.t > t && (x.type === 'forcing' || x.type === 'ops' || x.type === 'shelter')).slice(0, 6);
  box.innerHTML = `<div class="grid map">
    <div class="card"><div class="card-h"><h2>発生状況フィード</h2><span class="r"><span class="tag crit">直近 6 時間 ${past.filter((x) => x.t > t - 6).length} 件</span><span class="tag neutral">累計 ${past.length} 件</span></span><div class="pills" style="flex-basis:100%">${INC_CATS.map(([k, l]) => `<button class="pill" data-cat="${k}" aria-pressed="${cat === k}">${esc(l)}${k !== 'all' ? ` ${past.filter((x) => x.cat === k).length}` : ''}</button>`).join('')}</div></div><div class="inc-list">${shown.map((x) => incRow(sc, x, lastT != null && x.t > lastT && x.t <= t)).join('') || '<div class="empty">この区分の報告はまだありません</div>'}</div>${past.length > 80 ? `<div class="muted" style="font-size:12px;margin-top:8px">直近 80 件を表示</div>` : ''}</div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>種類別の件数</h2></div>${miniBars(Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: (INC[k] || [k])[0], value: v, color: INC_CATS[1][0] && ['forcing', 'quake'].includes(k) ? 'var(--c3)' : ['ops', 'req', 'site', 'logi'].includes(k) ? 'var(--c1)' : 'var(--crit)' })))}</div>
      <div class="card"><div class="card-h"><h2>地区別の被害報告</h2></div>${Object.keys(byDist).length ? miniBars(Object.entries(byDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: dName(k), value: v, color: 'var(--warn)' }))) : '<div class="empty">地区が特定された報告はありません</div>'}</div>
      <div class="card"><div class="card-h"><h2>今後の見込み</h2><span class="r">${asmTag('モデル・予定')}</span></div><div class="timeline">${fut.map((x) => `<div class="tl future"><span class="t">${esc(fmtHours(x.t))}<b>${esc(scenTime(sc, x.t).time)}</b></span><span class="m"><b>${esc(x.ja)}</b><span>${esc(x.where_ja || '')}</span></span></div>`).join('') || '<div class="empty">予定・見込みはありません</div>'}</div></div>
    </div></div>`;
}

/* ---------- タブ4：拠点・サプライチェーン状況 ---------- */
function onsetHour(sc, did, th = 0.25) { /* 区の被害が th を超える最初の時刻（1 時間刻み・キャッシュ） */
  sc._onset = sc._onset || {}; const key = did + ':' + th; if (sc._onset[key] !== undefined) return sc._onset[key];
  let out = null; for (let t = 0; t <= 168; t++) { const d = sim(sc, t).districts.find((x) => x.id === did); if (d && d.I > th) { out = t; break; } } sc._onset[key] = out; return out;
}
function panelSites(box, sc, r, t) {
  const g = GD(); const watch = sc.status === 'watch'; const regSites = M.sites(); const siteIds = sc.supply_sites || [];
  const nodeAttr = (s) => `data-node='${JSON.stringify({ type: 'site', region: s.region, site: s.id })}'`;
  const siteRows = r.sites.length ? r.sites.map((s) => { const reg = regSites.find((x) => x.id === s.id); const d = r.districts.find((x) => x.id === s.district); return `<tr><td><b>${esc(s.label)} ${esc(s.name_ja)}</b><span class="sub">${esc(s.district_ja || '')}${d ? '・地区の被害：' + sevJa(d.I) : ''}</span></td><td><span class="tag ${s.status}">${esc(s.op)}</span></td><td class="n">${fmt(s.confirmed)}/${fmt(s.staff)}<span class="sub">${fmtPct(s.resp)}</span></td><td style="font-size:12px;color:var(--fg2)">${esc(s.I > 0.6 ? s.need_crit_ja || '要員退避・代替拠点への切替' : s.I > 0.25 ? s.need_warn_ja || '燃料・飲料水の補給' : '—')}</td><td>${reg ? `<a href="#risk" class="cite" ${nodeAttr(reg)}>${ic('link')}備えスコア ${siteScore(reg).total}</a>` : '<span class="tag neutral">簡易登録</span>'}</td></tr>`; }).join('') : siteIds.map((id) => regSites.find((s) => s.id === id)).filter(Boolean).map((s) => `<tr><td><b>${esc(s.label)} ${esc(s.name_ja)}</b><span class="sub">${esc(s.short_ja)}</span></td><td><span class="tag ok">通常稼働</span></td><td class="n">—<span class="sub">安否確認は未発動</span></td><td style="font-size:12px;color:var(--fg2)">在宅勤務の判断基準を周知</td><td><a href="#risk" class="cite" ${nodeAttr(s)}>${ic('link')}備えスコア ${siteScore(s).total}</a></td></tr>`).join('');
  /* 取引先・物流 */
  const chain = siteIds.flatMap((sid) => (g.supply[sid] || []).map((x) => Object.assign({ site: sid }, x)));
  const rows = chain.map((x) => { const d = x.district ? r.districts.find((dd) => dd.id === x.district) : null; const I = d ? d.I : 0; const st = d ? (I > 0.6 ? 'crit' : I > 0.25 ? 'warn' : I > 0.05 ? 'ok' : 'none') : 'none'; const onset = d ? onsetHour(sc, x.district) : null; const inv = x.inventory_days != null ? (onset != null && t >= onset ? Math.max(0, x.inventory_days - (t - onset) / 24) : x.inventory_days) : null; return Object.assign({}, x, { d, I, st, onset, inv }); });
  const kindJa = { supplier: '仕入先', customer: '顧客', logistics: '物流', utility: 'ユーティリティ' };
  const stJa = { crit: '停止の見込み', warn: '縮退・遅延', ok: '一部影響', none: watch ? '監視中' : '影響なし' };
  const shareBy = (kind) => { const o = {}; rows.filter((x) => x.kind === kind && (x.st === 'crit' || x.st === 'warn')).forEach((x) => { o[x.site] = (o[x.site] || 0) + (x.share || 0); }); const e = Object.entries(o).sort((a, b) => b[1] - a[1])[0]; return e ? { v: Math.min(1, e[1]), site: regSites.find((s) => s.id === e[0]) } : { v: 0, site: null }; };
  const sup = shareBy('supplier'), cus = shareBy('customer'); const supShare = sup.v, cusShare = cus.v;
  const lowInv = rows.filter((x) => x.inv != null && x.inv < 3 && x.st !== 'none').length; const single = rows.filter((x) => x.single && (x.st === 'crit' || x.st === 'warn')).length;
  const kpis = [
    { v: `${r.sites.filter((s) => s.status === 'ok').length}/${r.sites.length || siteIds.length}`, u: '拠点', l: '通常稼働の拠点', c: r.sites.length && r.sites.filter((s) => s.status === 'ok').length < r.sites.length ? 'warn' : 'ok', s: r.sites.length ? `停止 ${r.kpi.sitesDown}・縮退 ${r.sites.filter((s) => s.status === 'warn').length}` : '警戒段階・監視中' },
    { v: r.sites.length ? fmtPct(r.kpi.confirmed / Math.max(1, r.kpi.staff)) : '—', u: '', l: `${STAFF_JA()}の安否確認率`, c: r.sites.length ? (r.kpi.confirmed / Math.max(1, r.kpi.staff) < 0.9 ? 'warn' : 'ok') : '', s: r.sites.length ? `未確認 ${fmt(r.kpi.staff - r.kpi.confirmed)} 名` : '未発動' },
    { v: fmtPct(supShare), u: '', l: '影響を受ける調達比率', c: supShare > 0.3 ? 'crit' : supShare > 0 ? 'warn' : 'ok', s: sup.site ? `${sup.site.label} ${sup.site.short_ja}：縮退・停止見込みの仕入先のシェア合計（最大の拠点）` : '縮退・停止見込みの仕入先なし' },
    { v: fmtPct(cusShare), u: '', l: '影響を受ける売上比率', c: cusShare > 0.3 ? 'crit' : cusShare > 0 ? 'warn' : 'ok', s: cus.site ? `${cus.site.label} ${cus.site.short_ja}：縮退・停止見込みの顧客のシェア合計（最大の拠点）` : '縮退・停止見込みの顧客なし' },
    { v: fmt(single), u: '件', l: '単一依存先の影響', c: single ? 'crit' : 'ok', s: '代替のない仕入先・物流が影響下' },
    { v: fmt(lowInv), u: '件', l: '在庫 3 日未満', c: lowInv ? 'crit' : 'ok', s: '被害開始からの消費で算出（仮定）' },
  ];
  const pts = rows.map((x) => [x.lon, x.lat]).concat((r.sites.length ? r.sites : siteIds.map((id) => regSites.find((s) => s.id === id)).filter(Boolean)).map((s) => [s.lon, s.lat]));
  const bb0 = sc.bbox || [pts[0][0], pts[0][1], pts[0][0], pts[0][1]]; const bbox = pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], bb0.slice()); const pad = 0.08; const bboxP = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const staffRows = (!Ctx.isGov() && !watch) ? siteIds.flatMap((sid) => ((g.staff[sid] || {}).clusters || []).map((cl) => { const d = cl.district ? r.districts.find((x) => x.id === cl.district) : null; const shs = d ? r.shelters.filter((s) => s.district === d.id) : []; return Object.assign({}, cl, { siteId: sid, d, shs }); })) : [];
  box.innerHTML = `<div class="kpis">${kpis.map(kpiTile).join('')}</div>
    <div class="card"><div class="card-h"><h2>拠点の稼働と安否</h2><span class="r"><span class="tag neutral">${esc(fmtHours(t))} 時点</span></span><span class="sub">拠点名のリンクから、平時の備え評価（画面 1）へ移動できます。</span></div><div class="tbl-wrap"><table><thead><tr><th>拠点</th><th>稼働</th><th class="n">安否確認</th><th>必要な支援</th><th>備え</th></tr></thead><tbody>${siteRows || '<tr><td colspan="5" class="empty">拠点の登録なし</td></tr>'}</tbody></table></div></div>
    <div class="grid map"><div class="card flush"><div class="map-box tall"><svg id="scMap" role="img" aria-label="拠点と取引先の位置"></svg><div class="legend"><span class="t">凡例</span><span><i style="background:var(--sel);border-radius:50%"></i>自社拠点</span><span><i style="background:var(--c1);border-radius:50%"></i>仕入先（円）</span><span><i style="background:var(--c1);clip-path:polygon(50% 0,100% 100%,0 100%)"></i>顧客（三角）</span><span><i style="background:var(--c1)"></i>物流・ユーティリティ（四角）</span><span><i style="background:var(--crit);border-radius:50%"></i>色＝所在地区の被害（赤 停止見込み／橙 縮退／緑 影響なし）</span></div><div class="attr">Natural Earth · 取引先は架空</div></div></div>
      <div class="card"><div class="card-h"><h2>サプライチェーンの状況</h2><span class="r">${asmTag('取引先は架空')}</span><span class="sub">所在地区の被害水準から稼働見込みを判定。在庫残は被害開始からの消費で減算。</span></div><div class="tbl-wrap"><table class="sc-table"><thead><tr><th>取引先・物流</th><th>関係</th><th>状況</th><th class="n">在庫残</th><th>代替</th></tr></thead><tbody>${rows.map((x) => `<tr><td><b>${esc(x.name_ja)}</b><span class="sub">${esc(x.tier || '')}${x.single ? '・<b style="color:var(--crit)">単一依存</b>' : ''}${x.district && x.d ? '・' + esc(x.d.name_ja.split('（')[0]) : ''}</span></td><td><span class="tag neutral">${esc(kindJa[x.kind] || x.kind)}</span><span class="sub">${x.share != null ? `シェア ${fmtPct(x.share)}` : ''}</span></td><td><span class="tag ${x.st === 'none' ? (watch ? 'warn' : 'neutral') : x.st}">${esc(stJa[x.st])}</span>${x.onset != null && x.st !== 'none' ? `<span class="sub">影響開始 ${esc(fmtHours(x.onset))}</span>` : x.district == null ? '<span class="sub">シナリオ範囲外</span>' : ''}</td><td class="n">${x.inv != null ? `<b style="color:${x.inv < 3 && x.st !== 'none' ? 'var(--crit)' : 'inherit'}">${fmt(x.inv, 1)} 日</b>` : '—'}</td><td style="font-size:12px;color:var(--fg2)">${esc(x.alt_ja || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">取引先の登録なし</td></tr>'}</tbody></table></div></div></div>
    ${staffRows.length ? `<div class="card"><div class="card-h"><h2>${Ctx.isGov() ? '職員' : '従業員'}・家族の居住地区の状況</h2><span class="r">${asmTag('居住分布は架空')}</span><span class="sub">地区の被害水準と避難所の収容状況。個人別の安否は安否確認システム側（デモでは拠点単位の確認率のみ）。</span></div><div class="tbl-wrap"><table><thead><tr><th>居住地区</th><th class="n">人数</th><th class="n">うち家族あり</th><th>住まい</th><th>地区の被害</th><th>避難所</th></tr></thead><tbody>${staffRows.map((x) => `<tr><td><b>${esc(x.name_ja)}</b><span class="sub">${esc(regSites.find((s) => s.id === x.siteId).label)} 拠点</span></td><td class="n">${fmt(x.n)}</td><td class="n">${fmt(x.fam)}</td><td style="font-size:12px">${esc(x.home_ja || '')}</td><td>${x.d ? `<span class="tag ${sevCls(x.d.I) || 'neutral'}">${sevJa(x.d.I)}${sc.type === 'flood' && x.d.depth > 0 ? `・${x.d.depth} m` : ''}</span>` : '<span class="tag neutral">シナリオ範囲外</span>'}</td><td style="font-size:12px">${x.shs.map((s) => s.open ? `<span class="tag ${s.over > 0 ? 'crit' : 'ok'}">${esc(s.name_ja)} ${fmt(s.occ)}/${fmt(s.cap)}</span>` : `<span class="tag neutral">${esc(s.name_ja)} 開設前</span>`).join(' ') || '—'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  /* 地図 */
  const agg = {}; r.districts.forEach((d) => { const a = agg[d.adm1] || (agg[d.adm1] = { pop: 0, wI: 0 }); a.pop += d.pop; a.wI += d.pop * d.I; });
  const proj = renderRegionMap($('#scMap', box), { bbox: bboxP, labels: true, level: (f) => { const a = agg[f.properties.id]; if (!a) return (sc.map_adm1 || []).includes(f.properties.id) ? 'b1' : ''; const I = a.pop ? a.wI / a.pop : 0; return I > 0.6 ? 'b5' : I > 0.4 ? 'b4' : I > 0.2 ? 'b3' : I > 0.05 ? 'b2' : 'b1'; }, tip: (f) => `<b>${esc(f.properties.n)}</b>`, sites: (r.sites.length ? r.sites : siteIds.map((id) => regSites.find((s) => s.id === id)).filter(Boolean).map((s) => Object.assign({}, s, { op: '通常稼働', status: 'ok' }))).map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: `${s.name_ja}：${s.op}`, status: s.status })), onSite: (id) => { const s = r.sites.find((x) => x.id === id); toast(s ? `${s.name_ja}：${s.op}` : id); } });
  $('#scMap', box).insertAdjacentHTML('beforeend', `<g class="g-bub">${rows.map((x) => { const [px, py] = proj([x.lon, x.lat]); const col = x.st === 'crit' ? 'var(--crit)' : x.st === 'warn' ? 'var(--warn)' : x.st === 'ok' ? 'var(--c3)' : 'var(--ok)'; const shape = x.kind === 'logistics' || x.kind === 'utility' ? `<rect x="${(px - 6).toFixed(1)}" y="${(py - 6).toFixed(1)}" width="12" height="12" rx="2" fill="${col}" stroke="var(--surface)"/>` : x.kind === 'customer' ? `<path d="M${px.toFixed(1)} ${(py - 8).toFixed(1)}l7 12h-14z" fill="${col}" stroke="var(--surface)"/>` : `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" fill="${col}" stroke="var(--surface)"/>`; return `<g style="pointer-events:none">${shape}<text class="m-label s" x="${(px + 9).toFixed(1)}" y="${(py + 3).toFixed(1)}">${esc(x.name_ja.split('（')[0])}</text></g>`; }).join('')}</g>`);
}

/* ---------- 地区単位のリアルタイム情報（パーソナライズ画面で使用）：ライフライン・支援イベント・天候・連絡先・医療・街区図 ---------- */
function localLive(sc, t, did, opts = {}) {
  const r = sim(sc, t); const d = r.districts.find((x) => x.id === did) || null; const c = M.country(sc.country); const watch = sc.status === 'watch';
  const logiNow = (sc.logistics || []).map((l) => ({ l, s: l.states.filter((s) => s.t <= t).slice(-1)[0] || l.states[0] }));
  const util = r.util.length ? r.util.map((u) => { const a = u.per[did] ? u.per[did].avail : u.avail; const cls = a >= 0.8 ? 'ok' : a >= 0.4 ? 'warn' : 'crit'; const etaD = (u.eta_ja && u.eta_ja[did]) || u.eta_default_ja || '復旧時期未定'; const eta = a >= 0.97 ? (t <= 0 ? '供給継続' : '概ね正常') : a >= 0.8 ? `概ね利用可（${etaD}）` : etaD; return `<div class="st ${cls}"><div class="h">${ic(u.icon || 'bolt')}${esc(u.name_ja)}</div><div class="pct">${fmtPct(a)}</div><div class="track"><i style="width:${(a * 100).toFixed(0)}%;background:var(--${cls})"></i></div><div class="eta">${esc(eta)}</div></div>`; }).join('') + (logiNow.length ? `<div class="st" style="grid-column:1/-1;flex-direction:row;flex-wrap:wrap;gap:6px 14px;align-items:center"><span class="eb dim">交通・物流</span>${logiNow.map((x) => `<span class="tag ${x.s.cls}">${esc(x.l.name_ja)}：${esc(x.s.ja)}</span>`).join('')}</div>` : '') : `<div class="st ok" style="grid-column:1/-1"><div class="h">${ic('bolt')}ライフライン</div><div class="eta" style="font-size:13px;color:var(--fg)">${watch ? '警報段階のため通常どおり。停電・断水の報告はありません' : 'この地区の情報はありません'}</div></div>`;
  /* 支援イベント（個別登録のない地区は避難所の開設・給水を自動生成） */
  let evs = (sc.events || []).filter((e) => !e.district || e.district === did || e.district === '*'); let synthesized = false;
  if (!evs.length && !watch) { synthesized = true; const shs = (sc.shelters || []).filter((s) => s.district === did); evs = shs.flatMap((s) => [{ t: s.open_h || 0, dur: 168, ja: `${s.name_ja} 開設（避難所・定員 ${fmt(s.cap)}）`, short_ja: '避難所', where_ja: s.name_ja, for: ['全員'], by: '自治体（想定）' }, { t: (s.open_h || 0) + 12, dur: 120, ja: '給水・食料配布（想定）', short_ja: '給水', where_ja: s.name_ja, for: ['全員'], by: '自治体・赤十字（想定）' }]); }
  const upcoming = evs.filter((e) => e.t + (e.dur || 4) > t).sort((a, b) => a.t - b.t).slice(0, 6); const past = evs.filter((e) => e.t + (e.dur || 4) <= t).slice(-3);
  const events = `<div class="card"><div class="card-h"><h2>支援イベント</h2><span class="r">${d ? `<span class="tag neutral">${esc(d.name_ja.split('（')[0])}</span>` : ''}${synthesized ? '<span class="tag warn">個別登録なし・避難所から自動生成</span>' : ''}</span><span class="sub">${watch ? '警報段階のため、給水・炊き出しなどの支援イベントはまだありません。' : synthesized ? 'この地区の個別イベントは未登録のため、シナリオの避難所情報から開設・給水を想定表示しています。' : '給水・炊き出し・医療巡回・領事サービス。時刻は発災からの相対時刻（デモ）。'}</span></div><div class="ev-list">${upcoming.map((e) => `<div class="ev"><span class="t">${esc(fmtHours(e.t))}<small>${e.t <= t ? '実施中' : '予定'}</small></span><div><b>${esc(e.ja)}</b><span>${esc(e.where_ja || '')}${e.detail ? '　' + esc(e.detail) : ''}</span><div class="meta">${(e.for || []).map((f) => `<span class="tag neutral">${esc(f)}</span>`).join('')}${e.by ? `<span class="tag acc">${esc(e.by)}</span>` : ''}</div></div></div>`).join('') || `<div class="empty">${watch ? '支援イベントはありません（警報段階）' : '予定されている支援はありません'}</div>`}${past.map((e) => `<div class="ev past"><span class="t">${esc(fmtHours(e.t))}<small>終了</small></span><div><b>${esc(e.ja)}</b><span>${esc(e.where_ja || '')}</span></div></div>`).join('')}</div></div>`;
  const w = sc.weather || {}; const hi = w.temp != null && w.rh != null ? heatIndex(w.temp, w.rh) : null;
  const weather = `<div class="card"><div class="card-h"><h2>気温と備え</h2><span class="r">${w.src ? srcTag(w.src_name || '出典', w.src) : asmTag('デモ値')}${srcTag('NOAA Heat Index', 'https://www.weather.gov/ama/heatindex', '体感温度は NOAA の Heat Index（気温と湿度から算出）。日本の暑さ指数（WBGT）とは別の指標')}</span></div><div class="weather"><div class="big">${w.temp != null ? w.temp : '—'}<small>°C</small><div style="font-size:12px;color:var(--fg2);font-family:var(--f-body);font-weight:400">${esc(w.desc_ja || '')}</div></div><ul>${hi != null ? `<li>体感温度（NOAA Heat Index）<b>${hi.toFixed(0)}°C</b>：${hi >= 54 ? '極めて危険。屋外活動は中止' : hi >= 41 ? '危険。屋外作業は中止、熱中症に厳重注意' : hi >= 32 ? '厳重警戒。屋外作業は 30 分ごとに休憩と水分' : hi >= 27 ? '注意。こまめな水分補給' : '通常'}（NOAA の 4 段階）</li>` : ''}<li>湿度 <b>${w.rh != null ? w.rh + '%' : '—'}</b>・降水 <b>${esc(w.rain_ja || '—')}</b></li>${(w.advice_ja || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div></div>`;
  const contacts = `<div class="card"><div class="card-h"><h2>連絡先</h2><span class="r"><span class="tag warn">要確認</span></span><span class="sub">番号・住所は第三者データからの転記です。赴任時に在外公館の公式サイトで確認し、この画面を更新してください。</span></div>${(c.emergency_numbers || []).slice(0, 4).map((n) => `<div class="contact"><div><b>${esc(n.service_ja)}</b><span>${esc(n.note_ja || '')}</span></div><button class="num copy" data-copy="${esc(n.number)}">${esc(n.number)}</button></div>`).join('')}${(c.disaster_hotlines || []).slice(0, 2).map((n) => `<div class="contact"><div><b>${esc(n.agency)}</b><span>${esc(n.note_ja || '')}</span></div><button class="num copy" data-copy="${esc(n.number)}">${esc(n.number)}</button></div>`).join('')}${(c.japanese_missions || []).slice(0, 1).map((m) => `<div class="contact"><div><b>${esc(m.name_ja)}</b><span>${esc(m.address || '')}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener">サイト</a>` : ''}</span></div>${m.phone ? `<button class="num copy" data-copy="${esc(m.phone)}">${esc(m.phone)}</button>` : ''}</div>`).join('')}</div>`;
  const hosp = (sc.hospitals || []).map((h) => Object.assign({}, h, { st: h.states.filter((s) => s.t <= t).slice(-1)[0] || h.states[0] }));
  const hospitals = hosp.length ? `<div class="card"><div class="card-h"><h2>受診できる医療機関</h2><span class="sub">外国人対応の病院の受入状況（デモ）。軽症は病院へ行かず、薬局・遠隔診療を使うと救急が詰まりません。</span></div><div class="tbl-wrap"><table><thead><tr><th>医療機関</th><th>状況</th><th>備考</th></tr></thead><tbody>${hosp.map((h) => `<tr><td><b>${esc(h.name_ja)}</b><span class="sub">${esc(h.district_ja || '')}${h.jp ? '・日本語デスク' : ''}</span></td><td><span class="tag ${h.st.cls}">${esc(h.st.ja)}</span></td><td style="font-size:12.5px;color:var(--fg2)">${esc(h.st.note || '')}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  const hz = sc.type === 'watch' ? 'flood' : sc.type;
  const health = `<div class="card"><div class="card-h"><h2>健康上の注意（${esc(hz === 'flood' ? '洪水時' : '地震後')}）</h2><span class="r">${srcTag('WHO', 'https://www.who.int/')}</span></div><div style="display:flex;flex-direction:column;gap:8px">${((D.guidance && D.guidance.health_after_disaster) || []).filter((h) => h.hazard === hz || h.hazard === 'all').slice(0, 6).map((h) => `<div class="note">${ic(/デング|蚊|マラリア/.test(h.risk_ja) ? 'bug' : /熱|暑/.test(h.risk_ja) ? 'sun' : 'heart')}<span><b>${esc(h.risk_ja)}：</b>${esc(h.advice_ja)} ${h.source_url ? srcTag('出典', h.source_url) : ''}</span></div>`).join('') || '<div class="empty">—</div>'}</div></div>`;
  /* 街区図 */
  const area = opts.area || (sc.area_id ? M.area(sc.area_id) : null); const showMap = area && (!sc.area_district || sc.area_district === did || opts.area);
  const mapHtml = showMap ? `<div class="card flush"><div class="map-box" id="llMapBox"><svg id="llMapSvg" role="img" aria-label="地区の状況図"></svg><div class="legend"><span class="t">凡例</span>${opts.home ? '<span><i style="background:var(--accent);border-radius:50%"></i>自宅</span>' : ''}<span><i style="background:var(--amber);border-radius:50%"></i>支援イベント</span><span><i style="background:var(--surface);border:2px solid var(--ok)"></i>避難所 収容/定員</span>${hz === 'flood' ? '<span><i style="background:var(--m-flood);opacity:.4"></i>想定浸水域（現在の深さで表示）</span>' : '<span><i style="background:var(--crit);opacity:.3"></i>被害集中域</span>'}</div><div class="attr">概略図・デモ</div></div></div>` : `<div class="note">${ic('info')}<span>この地区の街区図は未登録です。広域の被害分布は「リアルタイムレポーティング」の地図を参照してください。</span></div>`;
  const mountMap = (box) => { if (!showMap) return; const A = area._built || (area._built = buildArea(area)); const evPins = upcoming.filter((e) => e.lat && e.lon).map((e) => { const [x, y] = localXY(area, e.lon, e.lat); return { x, y, label: e.short_ja || e.ja }; }); const shelters = r.shelters.filter((s) => s.poi).map((s) => ({ poi: s.poi, occ: s.occ, cap: s.cap })); const depth = d ? d.depth : 0; renderAreaMap($('#llMapSvg', box), A, area, { scenario: hz === 'flood' ? (depth > 0.15 ? 'flood' : null) : 'quake', zoneCls: hz === 'flood' ? 'sm-flood' : 'sm-shake', events: evPins, shelters, me: opts.home || null, site: sc.area_site ? (() => { const s = M.site(sc.area_site); const [x, y] = localXY(area, s.lon, s.lat); return { x, y, name: s.label + ' 拠点' }; })() : null, onPoi: (n) => toast(n) }); };
  return { r, d, util, events, weather, contacts, hospitals, health, mapHtml, mountMap, upcoming, watch };
}
/* 暑さ指数（NOAA Heat Index、°C） */
function heatIndex(tc, rh) { const T = tc * 9 / 5 + 32; const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094); if ((simple + T) / 2 < 80) return (simple - 32) * 5 / 9; const HI = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 6.83783e-3 * T * T - 5.481717e-2 * rh * rh + 1.22874e-3 * T * T * rh + 8.5282e-4 * T * rh * rh - 1.99e-6 * T * T * rh * rh; return (HI - 32) * 5 / 9; }
