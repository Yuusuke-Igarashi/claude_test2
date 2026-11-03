/* 画面4・5：発災時リアルタイムレポート（支援者向け／被災者・現地対応者向け）。シナリオと時刻は両画面で共有。 */
const Live = {
  st: { scen: Store.get('liveScen', null), t: null, playing: false, timer: null, district: null },
  scenario() { const s = M.scenario(this.st.scen); if (s && !this.st.scen) this.st.scen = s.id; if (s && this.st.t == null) this.st.t = s.default_t ?? 30; return s; },
  bar(root, onChange) {
    const st = this.st; const sc = this.scenario(); const self = this;
    const uid = root.id.replace('v-', '');
    const html = `<div class="livebar"><div class="sc"><span class="live-dot"><i></i>LIVE · DEMO</span><b class="lb-name">${esc(sc.name_ja)}</b><span class="lb-desc">${esc(sc.desc_ja || '')}</span></div>
      <div class="t"><div class="row"><span>発災からの経過</span><b class="lb-t">${esc(fmtHours(st.t))}</b><span class="lb-date">${esc(sc.t0_ja || '')}</span></div><input type="range" class="lb-range" id="lbRange-${uid}" min="0" max="168" step="1" value="${st.t}" aria-label="発災からの経過時間"></div>
      <div class="ctr"><select class="lb-scen" id="lbScen-${uid}" aria-label="シナリオ">${M.scenarios().map((s) => `<option value="${s.id}"${s.id === sc.id ? ' selected' : ''}>${esc(s.short_ja || s.name_ja)}</option>`).join('')}</select><button class="btn sm lb-play" id="lbPlay-${uid}">${ic(st.playing ? 'pause' : 'play')}${st.playing ? '停止' : '再生'}</button></div></div>`;
    const box = $('.livebar-slot', root); box.innerHTML = html;
    st.box = box; st.onChange = onChange; /* 再生タイマーは常に現在の画面を参照する */
    $('.lb-range', box).oninput = (e) => { st.t = +e.target.value; $('.lb-t', box).textContent = fmtHours(st.t); onChange(); };
    $('.lb-scen', box).onchange = (e) => { st.scen = e.target.value; Store.set('liveScen', st.scen); st.district = null; const ns = M.scenario(st.scen); st.t = ns && ns.default_t != null ? ns.default_t : 30; self.bar(root, onChange); onChange(); };
    $('.lb-play', box).onclick = () => { st.playing = !st.playing; clearInterval(st.timer); if (st.playing) { st.timer = setInterval(() => { st.t = st.t >= 168 ? 0 : st.t + 1; const r = $('.lb-range', st.box); if (r) { r.value = st.t; $('.lb-t', st.box).textContent = fmtHours(st.t); } st.onChange(); }, 700); } self.bar(root, onChange); };
  },
};
function sevCls(I) { return I > 0.6 ? 'crit' : I > 0.25 ? 'warn' : I > 0.05 ? 'ok' : ''; }
function sevJa(I) { return I > 0.6 ? '甚大' : I > 0.25 ? '大きい' : I > 0.05 ? '限定的' : '影響なし'; }

/* ---------- 画面4：支援者向け ---------- */
App.views['live-support'] = {
  init(root) {
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">04 · Live · Responders</span><span class="aud">${ic('box')}想定読者：本社対策本部・支援チーム・物流担当</span></div>
          <h1>被害の全体像と、<em>支援の需給</em>をひと目で</h1>
          <p class="q"><b>問い：</b>いま、どこで、誰が、どれだけ困っていて、何がどれだけ足りないか。次の 24 時間に何を送るべきか。</p>
        </div>
        <div class="vh-r"><span class="tag crit">${ic('alert')}シナリオ訓練（デモデータ）</span></div>
      </div>
      <div class="livebar-slot"></div>
      <div class="kpis" id="lsKpi"></div>
      <div class="grid map">
        <div class="card flush"><div class="map-box tall" id="lsMapBox"><svg id="lsMap" role="img" aria-label="被害分布図"></svg><div class="legend" id="lsLegend"></div><div class="attr">Natural Earth · 被害分布はシナリオ値</div></div></div>
        <div style="display:flex;flex-direction:column;gap:12px" id="lsSide"></div>
      </div>
      <section class="sec" id="lsDist"></section>
      <section class="sec" id="lsSupply"></section>
      <section class="sec" id="lsTrend"></section>
      <section class="sec" id="lsFeeds"></section>`;
    Live.bar(root, () => this.update(root)); this.update(root);
  },
  show(root) { Live.bar(root, () => this.update(root)); this.update(root); },
  update(root) {
    const sc = Live.scenario(); const t = Live.st.t; const r = sim(sc, t); const k = r.kpi;
    $('#lsKpi', root).innerHTML = [
      { v: fmt(k.affected), u: '人', l: '影響人口（推計）', c: 'crit', s: '区別の曝露率×人口' },
      { v: fmt(k.evac), u: '人', l: '避難者（推計）', c: 'warn', s: `開設済み避難所 ${fmt(k.shelterOcc)}/${fmt(k.shelterCap)}${k.shelterOver ? `（定員超過 ${fmt(k.shelterOver)}）` : ''}` },
      { v: fmt(k.staff - k.confirmed), u: `/${fmt(k.staff)}人`, l: '安否未確認の社員', c: k.staff - k.confirmed > 0 ? 'crit' : 'ok', s: `確認率 ${fmtPct(k.confirmed / Math.max(1, k.staff))}` },
      { v: fmt(k.dead), u: '人', l: `確認された死者（推計）／負傷 ${fmt(k.inj)}`, c: 'crit', s: sc.type === 'quake' ? `最終見込み 約${fmt(Math.round(k.deadFinal / 1000) * 1000)} 人（MMEIRS の M7.2 想定は約 34,000 人）` : `最終見込み 約${fmt(k.deadFinal)} 人（2011 年実績 877 人・EM-DAT）` },
      { v: `${k.sitesDown}/${r.sites.length}`, u: '拠点', l: '操業停止の拠点', c: k.sitesDown ? 'crit' : 'ok', s: r.sites.filter((s) => s.status === 'warn').length + ' 拠点が縮退' },
      { v: fmtPct(k.fulfil), u: '', l: '物資充足率（平均）', c: k.fulfil < 0.5 ? 'crit' : k.fulfil < 0.8 ? 'warn' : 'ok', s: '需要に対する到着済み' },
      { v: fmt(k.jp), u: '人', l: '影響を受ける在留邦人（推計）', c: 'warn', s: '区別の在留邦人推計×曝露率' },
    ].map((x) => `<div class="kpi ${x.c}"><span class="v">${x.v}<small>${esc(x.u)}</small></span><span class="l">${esc(x.l)}</span><span class="s">${esc(x.s)}</span></div>`).join('');
    /* 地図 */
    const G = window.GEO; const fs = G.adm1_sea.features.filter((f) => (sc.map_adm1 || []).includes(f.properties.id)); const bbox = sc.bbox || padBBox(bboxOfFeatures(fs), 0.15);
    /* 州・県単位の集計（複数の区が同じ州・県に属する場合は人口加重） */
    const agg = {}; r.districts.forEach((d) => { const a = agg[d.adm1] || (agg[d.adm1] = { pop: 0, wI: 0, affected: 0, evac: 0, n: 0, depth: 0 }); a.pop += d.pop; a.wI += d.pop * d.I; a.affected += d.affected; a.evac += d.evac; a.n++; a.depth = Math.max(a.depth, d.depth || 0); });
    Object.values(agg).forEach((a) => { a.I = a.pop ? a.wI / a.pop : 0; });
    const proj = renderRegionMap($('#lsMap', root), { bbox, labels: true, level: (f) => { const a = agg[f.properties.id]; if (!a) return (sc.map_adm1 || []).includes(f.properties.id) ? 'b1' : ''; const I = a.I; return I > 0.6 ? 'b5' : I > 0.4 ? 'b4' : I > 0.2 ? 'b3' : I > 0.05 ? 'b2' : 'b1'; }, tip: (f) => { const a = agg[f.properties.id]; return `<b>${esc(f.properties.n)}</b>${a ? `<div class="r"><span>被害（${a.n} 区の加重）</span><span>${sevJa(a.I)}${sc.type === 'flood' ? `・最大浸水 ${a.depth} m` : ''}</span></div><div class="r"><span>影響人口</span><span>${fmt(a.affected)}</span></div><div class="r"><span>避難者</span><span>${fmt(a.evac)}</span></div>` : '<div class="r"><span class="muted">シナリオ対象外</span></div>'}`; }, sites: r.sites.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: `${s.name_ja}：${s.op}`, status: s.status })), onSite: (id) => { const s = r.sites.find((x) => x.id === id); toast(s ? `${s.name_ja}：${s.op}・安否確認 ${fmt(s.confirmed)}/${fmt(s.staff)}` : id); } });
    /* 区のバブル（adm1 に無い区は円で表現） */
    const svg = $('#lsMap', root); const bub = r.districts.filter((d) => d.lat && d.lon).map((d) => { const [x, y] = proj([d.lon, d.lat]); const rad = 4 + Math.sqrt(d.affected / 1000) * 1.1; return `<g class="bub" style="pointer-events:none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="var(--${d.I > 0.6 ? 'crit' : d.I > 0.25 ? 'warn' : 'accent'})" opacity=".55" stroke="var(--surface)" stroke-width="1"/><text class="m-label s" x="${(x + rad + 2).toFixed(1)}" y="${(y + 3).toFixed(1)}">${esc(d.name_ja)}</text></g>`; }).join('');
    svg.insertAdjacentHTML('beforeend', `<g class="g-bub">${bub}</g>`);
    $('#lsLegend', root).innerHTML = `<span class="t">${sc.type === 'flood' ? '浸水の程度' : '揺れ・建物被害'}</span><span><i style="background:var(--b5)"></i>甚大</span><span><i style="background:var(--b3)"></i>中程度</span><span><i style="background:var(--b1)"></i>軽微・なし</span>${bub ? '<span><i style="background:var(--crit);opacity:.6;border-radius:50%"></i>区の影響人口（円の大きさ）</span>' : ''}<span><i style="background:var(--sel);border-radius:50%"></i>自社拠点（色＝稼働状況）</span>`;
    /* 右：拠点状況・要請 */
    $('#lsSide', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>拠点の状況</h2><span class="r"><span class="tag neutral">${esc(fmtHours(t))} 時点</span></span><span class="sub">${r.sites.some((s) => !M.sites().find((x) => x.id === s.id)) ? '拠点 ' + r.sites.filter((s) => !M.sites().find((x) => x.id === s.id)).map((s) => s.label).join('・') + ' はシナリオ用の簡易登録（備え評価なし）。' : ''}</span></div><div class="tbl-wrap"><table><thead><tr><th>拠点</th><th>稼働</th><th class="n">安否確認</th><th>必要な支援</th></tr></thead><tbody>${r.sites.map((s) => `<tr><td><b>${esc(s.label)} ${esc(s.short_ja)}</b><span class="sub">${esc(s.district_ja || '')}</span></td><td><span class="tag ${s.status}">${esc(s.op)}</span></td><td class="n">${fmt(s.confirmed)}/${fmt(s.staff)}<span class="sub">${fmtPct(s.resp)}</span></td><td style="font-size:12px;color:var(--fg2)">${esc(s.I > 0.6 ? s.need_crit_ja || '要員退避・代替拠点への切替' : s.I > 0.25 ? s.need_warn_ja || '燃料・飲料水の補給' : '—')}</td></tr>`).join('')}</tbody></table></div></div>
      ${(() => { const qs = (sc.requests || []).filter((q) => q.t <= t).map((q) => Object.assign({}, q, { st: q.resolved_t != null && t >= q.resolved_t ? 'done' : q.ack_t != null && t >= q.ack_t ? 'ack' : 'open' })); const open = qs.filter((q) => q.st === 'open'), ack = qs.filter((q) => q.st === 'ack'), done = qs.filter((q) => q.st === 'done'); const oldest = open.length ? Math.max(...open.map((q) => t - q.t)) : 0; return `<div class="card"><div class="card-h"><h2>支援要請</h2><span class="r"><span class="tag crit">未対応 ${open.length}</span><span class="tag warn">対応中 ${ack.length}</span><span class="tag ok">完了 ${done.length}</span></span>${open.length ? `<span class="sub">最も古い未対応は発生から ${fmt(Math.round(oldest))} 時間経過</span>` : ''}</div><div class="timeline">${qs.filter((q) => q.st !== 'done').map((q) => `<div class="tl ${q.st === 'open' ? (q.cls || '') : ''}"><span class="t">${esc(fmtHours(q.t))}<b>${esc(q.from)}</b></span><span class="m"><b>${esc(q.what)} <span class="tag ${q.st === 'open' ? 'crit' : 'warn'}">${q.st === 'open' ? '未対応' : '対応中'}</span></b><span>${esc(q.detail || '')}</span></span></div>`).join('') || '<div class="empty">未対応・対応中の要請はありません</div>'}${done.length ? `<details class="more" style="margin-top:8px"><summary>${ic('chev')}完了した要請（${done.length}）</summary><div class="body"><ul>${done.map((q) => `<li>${esc(fmtHours(q.t))} ${esc(q.from)}：${esc(q.what)}（${esc(fmtHours(q.resolved_t))} 完了）</li>`).join('')}</ul></div></details>` : ''}</div></div>`; })()}`;
    /* 被災者の分布 */
    const ds = r.districts.slice().sort((a, b) => b.affected - a.affected);
    $('#lsDist', root).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>被災者の分布</h2><span class="r"><span class="tag neutral">${ds.length} 区・市</span></span><p>区ごとの影響人口・避難者・要配慮者（高齢者・乳幼児・障害など 14% と仮定）・在留邦人の推計。避難所の収容は区内の主要避難所の合計。</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>区・市</th><th>被害</th>${sc.type === 'flood' ? '<th class="n">浸水深</th>' : '<th class="n">揺れ</th>'}<th class="n">人口</th><th class="n">影響人口</th><th class="n">避難者</th><th class="n">要配慮者</th><th class="n">在留邦人</th><th>避難所</th></tr></thead><tbody>${ds.map((d) => { const shs = r.shelters.filter((s) => s.district === d.id); return `<tr><td><b>${esc(d.name_ja)}</b><span class="sub">${esc(d.note_ja || '')}</span></td><td><span class="tag ${sevCls(d.I) || 'neutral'}">${sevJa(d.I)}</span></td><td class="n">${sc.type === 'flood' ? (d.depth > 0 ? d.depth + ' m' : '—') : esc(d.intensity_ja || '—')}</td><td class="n">${fmt(d.pop)}</td><td class="n"><b>${fmt(d.affected)}</b></td><td class="n">${fmt(d.evac)}</td><td class="n">${fmt(d.vuln)}</td><td class="n">${fmt(d.jp)}</td><td style="font-size:12px">${shs.map((s) => s.open ? `<span class="tag ${s.over > 0 ? 'crit' : s.occ > s.cap * 0.8 ? 'warn' : 'ok'}">${esc(s.name_ja)} ${fmt(s.occ)}/${fmt(s.cap)}${s.over > 0 ? `（超過 +${fmt(s.over)}）` : ''}</span>` : `<span class="tag neutral">${esc(s.name_ja)} 開設前（${esc(fmtHours(s.open_h || 0))} 予定）</span>`).join(' ') || '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
    /* 物資需給 */
    $('#lsSupply', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>支援・物資の需給</h2><span class="r"><span class="tag ${k.fulfil < 0.5 ? 'crit' : k.fulfil < 0.8 ? 'warn' : 'ok'}">充足率 ${fmtPct(k.fulfil)}</span></span><p>需要＝避難者数×1 人あたり必要量（Sphere 基準などを参考）。供給＝到着済み（在庫＋輸送）。縦線が需要、棒が供給。</p></div>
      <div class="grid c2">
        <div class="card"><div class="card-h"><h2>品目別</h2><span class="sub">数値は 到着済み／需要（k＝千、M＝百万）</span></div>${r.supplies.map((s) => `<div class="sup-row"><span class="k">${ic(s.icon || 'box')}${esc(s.name_ja)}<span class="muted" style="font-size:10.5px">${esc(s.unit)}</span></span><span class="track"><i class="sup" style="width:${clamp(s.rate * 100 / 1.2, 0, 100).toFixed(1)}%;background:${s.rate >= 1 ? 'var(--ok)' : s.rate >= 0.6 ? 'var(--warn)' : 'var(--crit)'}"></i><i class="dem" style="left:${(100 / 1.2).toFixed(1)}%"></i></span><span class="v ${s.rate < 0.6 ? 'gap' : s.rate >= 1 ? 'okv' : ''}" title="${fmt(s.got)}／${fmt(s.need)}">${fmtC(s.got)}/${fmtC(s.need)}<span class="sub">${s.rate < 1 ? `不足 ${fmtC(s.need - s.got)}` : '充足'}</span></span></div>`).join('')}<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(sc.supply_note_ja || '')}</span></div></div>
        <div class="card"><div class="card-h"><h2>物流・輸送の状況</h2></div><div class="status-grid">${(sc.logistics || []).map((l) => { const st = l.states.filter((s) => s.t <= t).slice(-1)[0] || l.states[0]; return `<div class="st ${st.cls}"><div class="h">${ic(l.icon || 'car')}${esc(l.name_ja)}</div><div class="eta" style="font-size:13px;color:var(--fg)">${esc(st.ja)}</div><div class="eta">${esc(st.note || '')}</div></div>`; }).join('')}</div><div class="card-h" style="margin-top:14px"><h3>今後 48 時間の推奨アクション</h3></div><ul style="margin:0;padding-left:18px;font-size:13px">${(sc.actions || []).filter((a) => a.t <= t && t < a.t + 48).map((a) => `<li><b>${esc(a.ja)}</b>${a.why ? `<span class="muted"> — ${esc(a.why)}</span>` : ''}</li>`).join('') || `<li><b>復旧フェーズの定常対応</b><span class="muted"> — 設備点検・保険申請・家族の生活再建支援・従業員のメンタルケアを続ける</span></li>`}</ul></div>
      </div>`;
    /* 推移 */
    $('#lsTrend', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>推移とタイムライン</h2></div><div class="grid c2"><div class="card"><div class="card-h"><h2>影響人口・避難者</h2></div><div class="chart" id="lsChart"></div><div class="chart-cap"><span><i class="ln" style="background:var(--c5)"></i>影響人口</span><span><i class="ln" style="background:var(--c2)"></i>避難者</span></div><div class="card-h" style="margin-top:12px"><h3>社員の安否確認率</h3></div><div class="chart" id="lsChart2"></div></div>
      <div class="card"><div class="card-h"><h2>タイムライン</h2><span class="r"><span class="tag neutral">${r.log.length} 件</span></span></div><div class="timeline${r.log.length + r.upcoming.length > 8 ? ' collapsed' : ''}" id="lsTimeline">${r.log.slice().reverse().map((e) => `<div class="tl ${e.cls || ''}"><span class="t">${esc(fmtHours(e.t))}<b>${esc(e.who || '')}</b></span><span class="m"><b>${esc(e.ja)}</b><span>${esc(e.detail || '')}</span></span></div>`).join('')}${r.upcoming.map((e) => `<div class="tl future"><span class="t">${esc(fmtHours(e.t))}<b>${esc(e.who || '')}</b></span><span class="m"><b>${esc(e.ja)}</b><span>（予定）</span></span></div>`).join('')}</div>${r.log.length + r.upcoming.length > 8 ? `<button class="btn sm more-btn" data-more="lsTimeline">さらに表示（残り ${r.log.length + r.upcoming.length - 7} 件）</button>` : ''}</div></div>`;
    $$('[data-more]', root).forEach((b) => { b.onclick = () => { const tl = $('#' + b.dataset.more, root); tl.classList.toggle('collapsed'); b.textContent = tl.classList.contains('collapsed') ? `さらに表示（残り ${tl.children.length - 7} 件）` : '折りたたむ'; }; });
    lineChart($('#lsChart', root), { now: t, yLabel: '影響人口と避難者の推移（発災からの時間）', series: [{ name: '影響人口', color: 'var(--c5)', values: simSeries(sc, 'affected') }, { name: '避難者', color: 'var(--c2)', values: simSeries(sc, 'evac') }], yFmt: (v) => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : fmt(v) });
    lineChart($('#lsChart2', root), { now: t, height: 150, yLabel: '社員の安否確認率の推移', series: [{ name: '安否確認率（社員）', color: 'var(--c1)', values: simSeries(sc, (r) => r.kpi.staff ? r.kpi.confirmed / r.kpi.staff : 0) }], yFmt: (v) => fmtPct(v) });
    /* データ連携 */
    const feeds = M.feeds(); const cj = COUNTRY_JA[sc.country] || ''; const allC = Object.values(COUNTRY_JA);
    const txt = (f) => `${f.name} ${f.provider || ''} ${f.covers_ja || ''}`;
    const isCountry = (f) => cj && (txt(f).includes(cj) || txt(f).includes(sc.country));
    const isGlobal = (f) => !allC.some((n) => txt(f).includes(n)) && !/Thai|BMKG|BNPB|PHIVOLCS|PAGASA|NDRRMC|NADMA|SCDF|NEA|VNDMA|MEA|PEA|MWA|DDPM|BMA|Air4Thai|HII|Malaysia|Singapore|Viet|Philippine|Indonesia/.test(txt(f));
    const shown = feeds.filter(isGlobal).slice(0, 10).concat(feeds.filter(isCountry).slice(0, 10));
    const feedRow = (f) => `<div class="feed"><div><b>${esc(f.name)} <span class="muted" style="font-weight:400">· ${esc(f.provider || '')}</span></b><span>${esc(f.use_in_app_ja || f.covers_ja || '')}</span>${f.api ? `<span class="mono" style="font-size:10.5px;color:var(--muted);word-break:break-all">${esc(f.api)}</span>` : ''}</div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="tag neutral">${esc(f.format || '')}</span>${f.url ? `<a class="cite" href="${esc(f.url)}" target="_blank" rel="noopener">${ic('link')}公式</a>` : ''}<span class="tag ${f.confirmed_by === 'third_party' ? 'neutral' : 'warn'}" title="${f.confirmed_by === 'third_party' ? 'クライアント実装等で URL を確認（公式ページ本体は未取得）' : '未検証'}">${f.confirmed_by === 'third_party' ? 'URL 確認済' : '要確認'}</span><span class="tag warn">未接続</span></div></div>`;
    $('#lsFeeds', root).innerHTML = `<div class="sec-h"><span class="no">05</span><h2>本番では何につなぐか</h2><span class="r"><span class="tag neutral">全 ${feeds.length} 件のうち ${shown.length} 件を表示</span></span><p>この画面の各パネルに対応する公開フィード（全球のものと ${esc(cj)} 向けのもの）。現在はすべてデモ値で、接続していません。API の URL は GitHub 上のクライアント実装などで確認したもので、利用規約・レート制限は各公式ページで要確認です。</p></div><div class="card feeds">${shown.map(feedRow).join('') || '<div class="empty">フィード一覧なし</div>'}</div>`;
  },
};

/* ---------- 画面5：被災者・現地対応者向け ---------- */
App.views['live-local'] = {
  init(root) {
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">05 · Live · Residents</span><span class="aud">${ic('home')}想定読者：被災地にいる駐在員・家族・現地対応者</span></div>
          <h1>いま自分の地区で、<em>何が使えて何に気をつけるか</em></h1>
          <p class="q"><b>問い：</b>電気・水・通信・交通はいつ戻るか。今日どこで何の支援が受けられるか。暑さと病気にどう備えるか。</p>
        </div>
        <div class="vh-r"><span class="tag crit">${ic('alert')}シナリオ訓練（デモデータ）</span><button class="btn sm primary" id="llSafe">${ic('check')}安否を報告（デモ）</button></div>
      </div>
      <div class="livebar-slot"></div>
      <div class="ctl"><div class="f"><label for="llDist">居住地区</label><select id="llDist"></select></div><div class="f" id="llDistInfo" style="flex:1" aria-live="polite"></div></div>
      <div class="status-grid" id="llUtil"></div>
      <div class="grid c2" id="llMain"></div>
      <div class="grid c2" id="llHealth"></div>
      <section class="sec" id="llMap"></section>`;
    $('#llSafe', root).onclick = () => toast('安否報告を送信しました（デモ）：拠点の安否確認システムに「無事・自宅待機」と記録されます');
    Live.bar(root, () => this.update(root));
    $('#llDist', root).onchange = (e) => { Live.st.district = e.target.value; this.update(root); };
    this.update(root);
  },
  show(root) { Live.bar(root, () => this.update(root)); this.update(root); },
  update(root) {
    const sc = Live.scenario(); const t = Live.st.t; const r = sim(sc, t);
    const sel = $('#llDist', root); if (sel.options.length === 0 || sel.dataset.scen !== sc.id) { sel.dataset.scen = sc.id; sel.innerHTML = r.districts.map((d) => `<option value="${esc(d.id)}">${esc(d.name_ja)}</option>`).join(''); }
    const did = Live.st.district && r.districts.find((d) => d.id === Live.st.district) ? Live.st.district : (sc.default_district || r.districts[0].id); Live.st.district = did; sel.value = did;
    const d = r.districts.find((x) => x.id === did); const c = M.country(sc.country);
    $('#llDistInfo', root).innerHTML = `<label>この地区の状況</label><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="tag ${sevCls(d.I) || 'neutral'}">${sevJa(d.I)}${d.depth != null && d.depth >= 0.05 ? `・浸水 ${d.depth} m` : d.intensity_ja ? `・${esc(d.intensity_ja)}` : ''}</span><span class="muted" style="font-size:12.5px">${esc(d.local_ja || d.note_ja || '')}</span></div>`;
    /* ライフライン */
    const logiNow = (sc.logistics || []).map((l) => ({ l, s: l.states.filter((s) => s.t <= t).slice(-1)[0] || l.states[0] }));
    $('#llUtil', root).innerHTML = r.util.map((u) => { const a = u.per[did] ? u.per[did].avail : u.avail; const cls = a >= 0.8 ? 'ok' : a >= 0.4 ? 'warn' : 'crit'; const etaD = (u.eta_ja && u.eta_ja[did]) || u.eta_default_ja || '復旧時期未定'; const eta = a >= 0.97 ? (t <= 0 ? '供給継続' : '概ね正常') : a >= 0.8 ? `概ね利用可（${etaD}）` : etaD; return `<div class="st ${cls}"><div class="h">${ic(u.icon || 'bolt')}${esc(u.name_ja)}</div><div class="pct">${fmtPct(a)}</div><div class="track"><i style="width:${(a * 100).toFixed(0)}%;background:var(--${cls})"></i></div><div class="eta">${esc(eta)}</div></div>`; }).join('') + (logiNow.length ? `<div class="st" style="grid-column:1/-1;flex-direction:row;flex-wrap:wrap;gap:6px 14px;align-items:center"><span class="eb dim">交通・物流（支援者向けと同じ情報）</span>${logiNow.map((x) => `<span class="tag ${x.s.cls}">${esc(x.l.name_ja)}：${esc(x.s.ja)}</span>`).join('')}</div>` : '');
    /* イベント・天候（個別登録のない地区は、避難所の開設・給水を自動生成して表示） */
    let evs = (sc.events || []).filter((e) => !e.district || e.district === did || e.district === '*'); let synthesized = false;
    if (!evs.length) { synthesized = true; const shs = (sc.shelters || []).filter((s) => s.district === did); evs = shs.flatMap((s) => [{ t: s.open_h || 0, dur: 168, ja: `${s.name_ja} 開設（避難所・定員 ${fmt(s.cap)}）`, short_ja: '避難所', where_ja: s.name_ja, for: ['全員'], by: '自治体（想定）' }, { t: (s.open_h || 0) + 12, dur: 120, ja: '給水・食料配布（想定）', short_ja: '給水', where_ja: s.name_ja, for: ['全員'], by: '自治体・赤十字（想定）' }]); }
    const upcoming = evs.filter((e) => e.t + (e.dur || 4) > t).sort((a, b) => a.t - b.t).slice(0, 6); const past = evs.filter((e) => e.t + (e.dur || 4) <= t).slice(-3);
    const w = sc.weather || {}; const hi = w.temp != null && w.rh != null ? heatIndex(w.temp, w.rh) : null;
    $('#llMain', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>支援イベント</h2><span class="r"><span class="tag neutral">${esc(d.name_ja.split('（')[0])}</span>${synthesized ? '<span class="tag warn">個別登録なし・避難所から自動生成</span>' : ''}</span><span class="sub">${synthesized ? 'この地区の個別イベントは未登録のため、シナリオの避難所情報から開設・給水を想定表示しています。' : '給水・炊き出し・医療巡回・領事サービス。時刻は発災からの相対時刻（デモ）。'}</span></div><div class="ev-list">${upcoming.map((e) => `<div class="ev"><span class="t">${esc(fmtHours(e.t))}<small>${e.t <= t ? '実施中' : '予定'}</small></span><div><b>${esc(e.ja)}</b><span>${esc(e.where_ja || '')}${e.detail ? '　' + esc(e.detail) : ''}</span><div class="meta">${(e.for || []).map((f) => `<span class="tag neutral">${esc(f)}</span>`).join('')}${e.by ? `<span class="tag acc">${esc(e.by)}</span>` : ''}</div></div></div>`).join('') || '<div class="empty">予定されている支援はありません</div>'}${past.map((e) => `<div class="ev past"><span class="t">${esc(fmtHours(e.t))}<small>終了</small></span><div><b>${esc(e.ja)}</b><span>${esc(e.where_ja || '')}</span></div></div>`).join('')}</div></div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="card"><div class="card-h"><h2>気温と備え</h2><span class="r">${w.src ? srcTag(w.src_name || '出典', w.src) : asmTag('デモ値')}${srcTag('NOAA Heat Index', 'https://www.weather.gov/ama/heatindex', '体感温度は NOAA の Heat Index（気温と湿度から算出）。日本の暑さ指数（WBGT）とは別の指標')}</span></div><div class="weather"><div class="big">${w.temp != null ? w.temp : '—'}<small>°C</small><div style="font-size:12px;color:var(--fg2);font-family:var(--f-body);font-weight:400">${esc(w.desc_ja || '')}</div></div><ul>${hi != null ? `<li>体感温度（NOAA Heat Index）<b>${hi.toFixed(0)}°C</b>：${hi >= 54 ? '極めて危険。屋外活動は中止' : hi >= 41 ? '危険。屋外作業は中止、熱中症に厳重注意' : hi >= 32 ? '厳重警戒。屋外作業は 30 分ごとに休憩と水分' : hi >= 27 ? '注意。こまめな水分補給' : '通常'}（NOAA の 4 段階）</li>` : ''}<li>湿度 <b>${w.rh != null ? w.rh + '%' : '—'}</b>・降水 <b>${esc(w.rain_ja || '—')}</b></li>${(w.advice_ja || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div></div>
        <div class="card"><div class="card-h"><h2>連絡先</h2><span class="r"><span class="tag warn">要確認</span></span><span class="sub">番号・住所は第三者データからの転記です。赴任時に在外公館の公式サイトで確認し、この画面を更新してください。</span></div>${(c.emergency_numbers || []).slice(0, 4).map((n) => `<div class="contact"><div><b>${esc(n.service_ja)}</b><span>${esc(n.note_ja || '')}</span></div><button class="num copy" data-copy="${esc(n.number)}">${esc(n.number)}</button></div>`).join('')}${(c.disaster_hotlines || []).slice(0, 2).map((n) => `<div class="contact"><div><b>${esc(n.agency)}</b><span>${esc(n.note_ja || '')}</span></div><button class="num copy" data-copy="${esc(n.number)}">${esc(n.number)}</button></div>`).join('')}${(c.japanese_missions || []).slice(0, 1).map((m) => `<div class="contact"><div><b>${esc(m.name_ja)}</b><span>${esc(m.address || '')}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener">サイト</a>` : ''}</span></div>${m.phone ? `<button class="num copy" data-copy="${esc(m.phone)}">${esc(m.phone)}</button>` : ''}</div>`).join('')}</div>
      </div>`;
    $$('[data-copy]', root).forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b); });
    /* 健康・医療 */
    const hosp = (sc.hospitals || []).map((h) => { const a = r.util.find((u) => u.key === 'power'); const avail = a && a.per[h.district] ? a.per[h.district].avail : 1; const st = h.states.filter((s) => s.t <= t).slice(-1)[0] || h.states[0]; return Object.assign({}, h, { st }); });
    $('#llHealth', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>受診できる医療機関</h2><span class="sub">外国人対応の病院の受入状況（デモ）。軽症は病院へ行かず、薬局・遠隔診療を使うと救急が詰まりません。</span></div><div class="tbl-wrap"><table><thead><tr><th>医療機関</th><th>状況</th><th>備考</th></tr></thead><tbody>${hosp.map((h) => `<tr><td><b>${esc(h.name_ja)}</b><span class="sub">${esc(h.district_ja || '')}${h.jp ? '・日本語デスク' : ''}</span></td><td><span class="tag ${h.st.cls}">${esc(h.st.ja)}</span></td><td style="font-size:12.5px;color:var(--fg2)">${esc(h.st.note || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="card-h"><h2>健康上の注意（${esc(sc.type === 'flood' ? '洪水後' : '地震後')}）</h2><span class="r">${srcTag('WHO', 'https://www.who.int/')}</span></div><div style="display:flex;flex-direction:column;gap:8px">${((D.guidance && D.guidance.health_after_disaster) || []).filter((h) => h.hazard === sc.type || h.hazard === 'all').slice(0, 6).map((h) => `<div class="note">${ic(/デング|蚊|マラリア/.test(h.risk_ja) ? 'bug' : /熱|暑/.test(h.risk_ja) ? 'sun' : 'heart')}<span><b>${esc(h.risk_ja)}：</b>${esc(h.advice_ja)} ${h.source_url ? srcTag('出典', h.source_url) : ''}</span></div>`).join('') || '<div class="empty">—</div>'}</div></div>`;
    /* 地区の地図（拠点周辺図がある場合） */
    const area = sc.area_id ? M.area(sc.area_id) : null; const box = $('#llMap', root);
    if (area && (sc.area_district === did || !sc.area_district)) {
      const A = area._built || (area._built = buildArea(area));
      const evPins = upcoming.filter((e) => e.lat && e.lon).map((e) => { const [x, y] = localXY(area, e.lon, e.lat); return { x, y, label: e.short_ja || e.ja }; });
      const shelters = r.shelters.filter((s) => s.poi).map((s) => ({ poi: s.poi, occ: s.occ, cap: s.cap }));
      box.innerHTML = `<div class="sec-h"><span class="no">02</span><h2>地区の状況図</h2><p>想定浸水域（現在の深さに応じて表示）、避難所の収容状況、支援イベントの場所。</p></div><div class="card flush"><div class="map-box" id="llMapBox"><svg id="llMapSvg" role="img" aria-label="地区の状況図"></svg><div class="legend"><span class="t">凡例</span><span><i style="background:var(--amber);border-radius:50%"></i>支援イベント</span><span><i style="background:var(--surface);border:2px solid var(--ok)"></i>避難所 収容/定員</span>${sc.type === 'flood' ? '<span><i style="background:var(--m-flood);opacity:.4"></i>想定浸水域</span>' : '<span><i style="background:var(--crit);opacity:.3"></i>被害集中域</span>'}</span></div><div class="attr">概略図・デモ</div></div></div>`;
      renderAreaMap($('#llMapSvg', root), A, area, { scenario: sc.type === 'flood' ? (d.depth > 0.15 ? 'flood' : null) : 'quake', zoneCls: sc.type === 'flood' ? 'sm-flood' : 'sm-shake', events: evPins, shelters, site: sc.area_site ? (() => { const s = M.site(sc.area_site); const [x, y] = localXY(area, s.lon, s.lat); return { x, y, name: s.label + ' 拠点' }; })() : null });
    } else box.innerHTML = `<div class="note">${ic('info')}<span>この地区の街区図は未登録です。広域の被害分布は「4 支援者向け」の地図を参照してください。</span></div>`;
  },
};
/* 暑さ指数（NOAA Heat Index、°C） */
function heatIndex(tc, rh) { const T = tc * 9 / 5 + 32; const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094); if ((simple + T) / 2 < 80) return (simple - 32) * 5 / 9; const HI = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 6.83783e-3 * T * T - 5.481717e-2 * rh * rh + 1.22874e-3 * T * T * rh + 8.5282e-4 * T * rh * rh - 1.99e-6 * T * T * rh * rh; return (HI - 32) * 5 / 9; }
