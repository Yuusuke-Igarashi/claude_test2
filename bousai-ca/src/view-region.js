/* 画面1：地域版 災害別リスク評価 */
App.views.region = {
  st: { region: Store.get('region', 'th-bkk'), hz: 'flood', focus: 'sea', rpHz: 'flood' },
  init(root) {
    const st = this.st; const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">01 · Regional risk</span><span class="aud">${ic('users')}想定読者：本社リスク管理・海外事業部</span></div>
          <h1>地域の災害リスクを、<em>頻度と規模</em>で見る</h1>
          <p class="q"><b>問い：</b>この地域では、どの災害が、どのくらいの頻度で、どの規模の被害（影響人口・操業停止・損失）をもたらしうるか。</p>
        </div>
        <div class="vh-r"><span class="tag asm">仮定値はラベルで区別</span><span class="tag src">出典付きの値はリンク</span></div>
      </div>
      <div class="ctl">
        <div class="f"><label for="rgSel">地域（都市圏）</label><select id="rgSel">${M.regions().map((r) => `<option value="${r.id}">${esc(r.name_ja)}（${esc(COUNTRY_JA[r.country] || r.country)}）</option>`).join('')}</select></div>
        <div class="f"><label>地図に表示するハザード</label><div class="seg" id="hzSeg" role="group" aria-label="地図に表示するハザード">${['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze'].map((k) => `<button data-hz="${k}" aria-pressed="${k === st.hz}">${esc(HAZ[k].short)}</button>`).join('')}</div></div>
        <div class="f"><label>表示範囲</label><div class="seg" id="focusSeg" role="group" aria-label="表示範囲"><button data-focus="sea" aria-pressed="true">東南アジア全域</button><button data-focus="country" aria-pressed="false">選択した国</button></div></div>
      </div>
      <div class="answer" id="rgAnswer"></div>
      <div class="grid map">
        <div class="card flush"><div class="map-box tall" id="rgMapBox"><svg id="rgMap" role="img" aria-label="東南アジアの州・県別ハザード水準地図"></svg><div class="legend" id="rgLegend"></div><div class="attr">Natural Earth · ハザード水準：ThinkHazard (GFDRR)</div></div></div>
        <div style="display:flex;flex-direction:column;gap:12px" id="rgSide"></div>
      </div>
      <section class="sec" id="rgRp"></section>
      <section class="sec" id="rgHist"></section>
      <section class="sec" id="rgSeason"></section>
      <section class="sec" id="rgSrc"></section>`;
    $('#rgSel', root).value = st.region;
    $('#rgSel', root).onchange = (e) => { st.region = e.target.value; Store.set('region', st.region); self.update(root); };
    this.setHz = (k) => { st.hz = k; $$('#hzSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x.dataset.hz === k)); $$('#hzCards .hz', root).forEach((x) => x.setAttribute('aria-pressed', x.dataset.hzCard === k)); self.drawMap(root); };
    $('#hzSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; self.setHz(b.dataset.hz); };
    $('#focusSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.focus = b.dataset.focus; $$('#focusSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); self.drawMap(root); };
    root.addEventListener('click', (e) => { const h = e.target.closest('[data-rphz]'); if (h) { st.rpHz = h.dataset.rphz; self.drawRp(root); } });
    this.update(root);
  },
  show(root) { /* 他画面からの地域変更を反映 */ const r = Store.get('region', this.st.region); if (r !== this.st.region) { this.st.region = r; $('#rgSel', root).value = r; this.update(root); } },
  levelOf(f, hz) {
    const id = f.properties.id; const th = HAZ[hz].th;
    const reg = M.regions().find((r) => (r.hazard_adm1_ids || r.adm1_ids || []).includes(id));
    if (reg && reg.hazards && reg.hazards[th] && reg.hazards[th].level) return { level: reg.hazards[th].level, scope: reg.hazard_scope_ja || reg.name_ja, src: reg.hazards[th].src };
    const c = D.regions && D.regions.countries && D.regions.countries[f.properties.c];
    if (c && c.hazards && c.hazards[th]) return { level: c.hazards[th].level, scope: `${COUNTRY_JA[f.properties.c]}（国レベル）`, src: c.hazards[th].src };
    return { level: 'unknown', scope: '' };
  },
  drawMap(root) {
    const st = this.st; const reg = M.region(st.region); const self = this;
    const G = window.GEO; let bbox = SEA_BBOX;
    if (st.focus === 'country') { const fs = G.adm1_sea.features.filter((f) => f.properties.c === reg.country); bbox = padBBox(bboxOfFeatures(fs), 0.06); }
    const sites = M.sites().map((s, i) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: s.name_ja, hl: s.region === reg.id }));
    renderRegionMap($('#rgMap', root), {
      bbox, selIds: new Set(reg.adm1_ids || []), sites,
      level: (f) => { const l = self.levelOf(f, st.hz); return lvInfo(l.level).cls + (/国レベル/.test(l.scope || '') ? ' nat' : ''); },
      tip: (f) => { const l = self.levelOf(f, st.hz); return `<b>${esc(f.properties.n)}</b><div class="r"><span>${esc(COUNTRY_JA[f.properties.c] || f.properties.c)}</span><span>${esc(f.properties.t)}</span></div><div class="r"><span>${esc(HAZ[st.hz].ja)}</span>${lvTag(l.level)}</div>${l.scope ? `<div class="r"><span class="muted">${esc(l.scope)}</span></div>` : ''}`; },
      onPick: (f) => { const r = M.regions().find((x) => (x.adm1_ids || []).includes(f.properties.id)); if (r) { st.region = r.id; Store.set('region', r.id); $('#rgSel', root).value = r.id; self.update(root); } else toast(`${f.properties.n}：都市圏としての詳細データは未収録です（国レベルの水準を表示）`); },
      onSite: (id) => { const s = M.site(id); st.region = s.region; Store.set('region', s.region); Store.set('site', id); $('#rgSel', root).value = s.region; self.update(root); toast(`${s.name_ja} の地域を表示。拠点の詳細は「2 拠点の備え」へ`); },
    });
    $('#rgLegend', root).innerHTML = `<span class="t">${esc(HAZ[st.hz].short)}の水準（ThinkHazard）</span>${['High', 'Medium', 'Low', 'Very low', 'unknown'].map((k) => `<span><i style="background:var(--${lvInfo(k).cls.replace('k', 'h')})"></i>${lvInfo(k).ja}</span>`).join('')}<span><i style="background:var(--h4);opacity:.35"></i>淡色＝州・県値なし（国レベル＝国内最大値で補完）</span><span><i style="background:var(--sel);opacity:.7;border-radius:50%"></i>自社拠点</span>`;
  },
  update(root) {
    const st = this.st; const reg = M.region(st.region); const c = M.country(reg.country); const gem = M.gem(reg.country);
    const cr = (D.regions && D.regions.countries && D.regions.countries[reg.country]) || {};
    this.drawMap(root);
    /* 右側：ハザード一覧と KPI */
    const order = ['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze', 'water'];
    const hzCards = order.map((k) => { const th = HAZ[k].th; const v = (reg.hazards && reg.hazards[th]) || (cr.hazards && cr.hazards[th] ? Object.assign({ country_level: true }, cr.hazards[th]) : null); const lv = lvInfo(v ? v.level : 'unknown'); return `<button class="hz" data-hz-card="${k}" aria-pressed="${k === st.hz}" style="${v && v.country_level ? 'opacity:.72;border-style:dashed' : ''}" title="${esc(v && v.country_level ? '州・県の値が未取得のため、国レベル（国内の最大値）で補完' : v && v.note ? v.note : '')}"><span class="h">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</span>${lvTag(v ? v.level : 'unknown')}<span class="lvbar">${[1, 2, 3, 4].map((i) => `<i style="${i <= lv.k ? `background:var(--${lv.cls.replace('k', 'h')})` : ''}"></i>`).join('')}</span><span class="s">${v && v.country_level ? '国の最大値' : v && v.level ? '州・県' : '未取得'}${v && v.confirmed_by === 'search_snippet' ? ' · 検索要約' : ''}</span></button>`; }).join('');
    const nReg = order.filter((k) => reg.hazards && reg.hazards[HAZ[k].th] && reg.hazards[HAZ[k].th].level).length;
    const NA = '<span style="font-size:15px;font-family:var(--f-body);color:var(--muted)">未取得</span>';
    const kpis = [
      { v: fmt(reg.pop_m, 1), u: '百万人', l: '都市圏人口', s: reg.pop_src || '出典：地域データ', url: reg.pop_url, asm: true },
      { v: c.jp_residents != null ? fmt(c.jp_residents) : NA, u: c.jp_residents != null ? '人' : '', l: '在留邦人（国全体）', s: c.jp_residents != null ? (c.residents_src || '外務省 海外在留邦人数調査統計') : '外務省 海外在留邦人数調査統計を参照（本セッション未取得）', url: c.residents_url || 'https://www.mofa.go.jp/mofaj/toko/tokei/hojin/index.html' },
      { v: c.jp_companies != null ? fmt(c.jp_companies) : NA, u: c.jp_companies != null ? '拠点' : '', l: '日系企業拠点（国全体）', s: c.jp_companies != null ? (c.companies_src || '外務省 日系企業拠点数調査') : '外務省 海外進出日系企業拠点数調査を参照（本セッション未取得）', url: c.companies_url || 'https://www.mofa.go.jp/mofaj/toko/page22_000043.html' },
      { v: c.wri != null ? fmt(c.wri, 2) : NA, u: c.wri_rank && !(c.wri_rank_note && /2024/.test(c.wri_rank_note)) ? `世界${c.wri_rank}位` : '', l: 'WorldRiskIndex 2025 スコア', s: (c.wri_src || 'WorldRiskReport') + (c.wri_rank && c.wri_rank_note && /2024/.test(c.wri_rank_note) ? `。順位は 2025 年版未確認（2024 年版 ${c.wri_rank} 位）` : c.wri_rank ? '' : '。順位は未確認'), url: c.wri_url, snip: c.wri_confirmed === 'search_snippet' },
      { v: c.inform != null ? fmt(c.inform, 1) : NA, u: c.inform != null ? '/10' : '', l: 'INFORM Risk 2025', s: c.inform != null ? (c.inform_src || 'EC JRC INFORM') : 'EC JRC INFORM（本セッション未取得）', url: c.inform_url || 'https://drmkc.jrc.ec.europa.eu/inform-index', snip: c.inform_confirmed === 'search_snippet' },
    ];
    $('#rgSide', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>${esc(reg.name_ja)}のハザード水準</h2><span class="r"><span class="tag neutral">州・県値 ${nReg}/${order.length}</span>${srcTag('ThinkHazard', reg.th_url, 'GFDRR ThinkHazard! 州・県レベルの定性的水準')}</span><span class="sub">${esc(reg.desc_ja || '')}</span></div><div class="hz-grid" id="hzCards">${hzCards}</div>${reg.hz_note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(reg.hz_note_ja)}</span></div>` : ''}</div>
      <div class="kpis">${kpis.filter((k) => k.v !== NA).map((k) => `<div class="kpi"><span class="v">${k.v}<small>${esc(k.u)}</small></span><span class="l">${esc(k.l)}${k.asm ? ' ' + asmTag() : ''}${k.snip ? ' <span class="tag warn" style="font-size:10px">検索要約</span>' : ''}</span><span class="s">${k.url ? `<a href="${esc(k.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(k.s)}</a>` : esc(k.s)}</span></div>`).join('')}</div>
      ${kpis.some((k) => k.v === NA) ? `<div class="note">${ic('info')}<span><b>未取得の指標：</b>${kpis.filter((k) => k.v === NA).map((k) => `${esc(k.l)}（<a href="${esc(k.url)}" target="_blank" rel="noopener">出典</a>）`).join('・')}。本セッションの実行環境から外務省・EC JRC のサイトに到達できなかったため、値を転記していません。</span></div>` : ''}`;
    $('#hzCards', root).onclick = (e) => { const b = e.target.closest('[data-hz-card]'); if (!b) return; if (!HAZ[b.dataset.hzCard] || b.dataset.hzCard === 'water') return; this.setHz(b.dataset.hzCard); };
    /* 02 再現期間 */
    const rpHzs = Object.keys(reg.rp || {}); if (!rpHzs.includes(st.rpHz)) st.rpHz = rpHzs[0];
    this.drawRp(root);
    /* 答え（要約） */
    const lvOf = (k) => { const th = HAZ[k].th; const v = (reg.hazards && reg.hazards[th]) || (cr.hazards && cr.hazards[th]); return v ? v.level : null; };
    const main = ['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze'];
    const highs = main.filter((k) => lvOf(k) === 'High').map((k) => HAZ[k].short), meds = main.filter((k) => lvOf(k) === 'Medium').map((k) => HAZ[k].short);
    const primary = rpHzs[0]; const prow = primary ? rpRows(reg, primary).find((r) => r.rp === 100) : null;
    const nowM = new Date().getMonth() + 1; const inSeason = Object.entries(reg.season || {}).filter(([k, v]) => v.months.includes(nowM)).map(([k]) => HAZ[k] ? HAZ[k].short : k);
    $('#rgAnswer', root).innerHTML = `<span class="k">答え</span><ul>
      <li><b>${esc(reg.name_ja)}の主なリスク：</b>${highs.length ? `${esc(highs.join('・'))}（高）` : '「高」の災害なし'}${meds.length ? `、${esc(meds.join('・'))}（中）` : ''}。水準は ThinkHazard（州・県単位、検索要約）。</li>
      ${prow ? `<li><b>規模の目安（${esc(HAZ[primary].short)}・年超過確率 1%＝再現期間 100 年）：</b>想定損失 ${fmtUSD(prow.loss)}${prow.pop ? `、影響人口 約 ${fmt(prow.pop)} 人` : ''}${prow.downtime ? `、操業停止 約 ${prow.downtime} 日` : ''}${primary === 'quake' ? '（GEM 全国値の按分）' : '（仮定モデル）'}。</li>` : ''}
      <li><b>今月（${nowM} 月）の季節性：</b>${inSeason.length ? `${esc(inSeason.join('・'))}の要注意期間` : '主要ハザードの要注意期間ではありません'}。過去の主な災害は ${(reg.history || []).length} 件を下に掲載。</li></ul>`;
    /* 03 過去の災害 */
    const isDate = (d) => /^\d/.test(String(d || ''));
    const hist = (reg.history || []).slice().sort((a, b) => (isDate(b.date) ? String(b.date) : '0').localeCompare(isDate(a.date) ? String(a.date) : '0'));
    const dateLabel = (d) => isDate(d) ? esc(d) : '<span style="font-family:var(--f-body)">毎年<span class="sub">乾季</span></span>';
    /* 調査過程の表現（未検証・モデル記憶など）は本文から除き、確からしさはタグと出典に委ねる */
    const clean = (s, n) => String(s || '').replace(/[（(][^（）()]*?(モデル記憶|未検証|要確認|要出典|本セッション|本ラン)[^（）()]*?[）)]/g, '').replace(/(未検証|要確認)[。．]?/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
    $('#rgHist', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>過去の主な災害</h2><span class="r"><span class="tag neutral">${hist.length} 件</span></span><p>この地域・国で記録に残る主要災害。死者・被害額は出典の値をそのまま示し、推計の幅がある場合は注記します。</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>年月</th><th>災害</th><th>種別</th><th>数値の範囲</th><th class="n">死者</th><th class="n">被害額</th><th>日系企業・在留邦人への影響</th><th>出典</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="num" style="white-space:nowrap">${dateLabel(h.date)}</td><td style="min-width:200px"><b>${esc(h.name_ja)}</b>${h.note_ja ? `<span class="sub">${esc(clean(h.note_ja, 110))}</span>` : ''}</td><td>${esc(HAZ[h.hazard] ? HAZ[h.hazard].short : h.hazard)}</td><td style="font-size:12px;color:var(--fg2);white-space:nowrap">${esc(h.scope_ja || (h.scope === 'country' ? `${COUNTRY_JA[reg.country] || ''}全国` : '当該地域'))}${h.multi ? ' <span class="tag warn">複数国合計</span>' : h.other_country ? ' <span class="tag neutral">他国中心</span>' : ''}</td><td class="n">${h.deaths != null ? fmt(h.deaths) : '—'}</td><td class="n">${h.damage_usd_m != null ? fmtUSD(h.damage_usd_m) : '—'}</td><td style="font-size:12.5px;color:var(--fg2);min-width:180px">${esc(clean(h.jp_ja, 90) || '—')}</td><td>${srcTag(h.src_name || '出典', h.src, h.confirmed_by === 'search_snippet' ? '検索結果の要約に基づく（原典ページ未取得）' : h.confirmed_by === 'unverified' ? '未検証の概数。公開前に出典確認が必要' : '')}${h.confirmed_by === 'unverified' ? ' <span class="tag warn">要確認</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">記録なし</td></tr>'}</tbody></table></div>
      <div class="note">${ic('info')}<span>「数値の範囲」は死者・被害額が指す範囲です。EM-DAT（OWID 集計）の値は「国×年×災害種別」の年間合計で、個別事象の公式値とは一致しないことがあります（例：2013 年フィリピンの嵐の死者はハイエン以外の台風を含む）。「複数国合計」は列挙した国の年間合計の和、「他国中心」は主な被災国が別の国で当該国にも影響した事象です。被害額は発生当時の名目 USD。</span></div>
      ${gem && gem.major_eq.length ? `<div class="note">${ic('info')}<span><b>GEM 地震リスクプロファイルが挙げる主な地震（${esc(gem.name_ja)}）：</b>${gem.major_eq.map((e) => `${e[0]}年 ${e[1]} ${e[2]}（死者 ${fmt(e[3])}）`).join('／')}。＊は国外震源。${srcTag('GEM', D.gem._source.url)}</span></div>` : ''}`;
    /* 04 季節性 */
    const months = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    $('#rgSeason', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>季節性</h2><p>月ごとの要注意期間。赤道近くでは雨季が二つある地域もあります。枠線は今月。</p></div><div class="card">${Object.entries(reg.season || {}).map(([k, v]) => `<div class="mrow"><span>${ic(HAZ[k] ? HAZ[k].icon : 'info')} ${esc(HAZ[k] ? HAZ[k].short : k)}<span class="muted" style="font-size:11px;display:block">${esc(v.note_ja || '')}</span></span><div class="months">${months.map((m) => `<span class="${v.months.includes(+m) ? 'on' : ''}${+m === nowM ? ' now' : ''}">${m}</span>`).join('')}</div></div>`).join('') || '<div class="empty">季節性データなし</div>'}${reg.season_src ? `<div style="margin-top:8px">${srcTag(reg.season_src_name || '出典', reg.season_src)}</div>` : ''}</div>`;
    /* 05 出典 */
    const srcs = (reg.sources || []).concat(cr.sources || []);
    $('#rgSrc', root).innerHTML = `<div class="sec-h"><span class="no">05</span><h2>出典と確からしさ</h2><p>この画面の値の由来。「検索要約」はウェブ検索結果の要約から転記したもので、原典ページ本文を取得できていないため、採用前に原典で確認してください。</p></div><div class="card src-list">${[{ name: 'ThinkHazard!（GFDRR／世界銀行）', d: '州・県レベルのハザード水準（High／Medium／Low／Very low）。本セッションの環境からは thinkhazard.org に直接アクセスできず、水準は検索結果の要約から転記', url: reg.th_url || 'https://thinkhazard.org/', tags: ['公開', '検索要約'] }, { name: 'GEM Foundation 国別地震リスクプロファイル v2026.0.0（2026 年 6 月公開）', d: '再現期間 10／50／100／500／1000 年の建物損失（住宅・商業・工業、2025 年 USD）。画像を取得し値を転記。版により値が大きく異なるため他版と混用しない。CC BY-NC-SA 4.0（非商用：商用利用は GEM との個別契約が必要）', url: D.gem._source.url, tags: ['公開', '取得済み', '非商用'] }, { name: 'Natural Earth', d: '国・州県境界、都市、河川（パブリックドメイン）', url: 'https://www.naturalearthdata.com/', tags: ['公開', '取得済み'] }].concat(srcs).map((s, i) => `<div class="src-row"><span class="idx">${i + 1}</span><span><b>${esc(s.name)}</b><span class="d">${esc(s.d || s.what_ja || '')}</span>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}</span><span class="tags">${(s.tags || ['公開']).map((t) => `<span class="tag ${t === '検索要約' ? 'warn' : t === '仮定' ? 'asm' : 'neutral'}">${esc(t)}</span>`).join('')}</span></div>`).join('')}</div>`;
  },
  drawRp(root) {
    const st = this.st; const reg = M.region(st.region); const gem = M.gem(reg.country);
    const hzs = Object.keys(reg.rp || {}); const box = $('#rgRp', root);
    if (!hzs.length) { box.innerHTML = `<div class="sec-h"><span class="no">02</span><h2>確率年別の被害規模</h2></div><div class="empty">この地域の再現期間モデルは未設定です</div>`; return; }
    const hz = st.rpHz; const cfg = reg.rp[hz]; const rows = rpRows(reg, hz);
    const isQ = hz === 'quake' && gem;
    const tabs = `<div class="seg">${hzs.map((k) => `<button data-rphz="${k}" aria-pressed="${k === hz}">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</button>`).join('')}</div>`;
    const cr = (D.regions && D.regions.countries && D.regions.countries[reg.country]) || {};
    const fc = hz === 'flood' && cr.flood_curve ? cr.flood_curve : null;
    /* 地震：全国（GEM）と按分は同じ基準なので同一軸。洪水：全国（Aqueduct）は基準が異なるため表の参考行にのみ出す */
    const series = isQ ? [{ name: `${gem.name_ja} 全国（GEM・建物損失）`, color: 'var(--c6)', points: RPS.map((rp) => [rp, gem.loss_curve_m[String(rp)] || 0]) }, { name: `${reg.name_ja} 按分（仮定：全国の ${Math.round((cfg.share || 0) * 100)}%）`, color: 'var(--c1)', points: rows.map((r) => [r.rp, r.loss || 0]), dashed: true }]
      : [{ name: `${reg.name_ja} 想定損失（仮定）`, color: 'var(--c1)', points: rows.map((r) => [r.rp, r.loss || 0]) }];
    box.innerHTML = `<div class="sec-h"><span class="no">02</span><h2>確率年別の被害規模</h2><span class="r">${tabs}</span><p>「再現期間 100 年」は「どの年にも 1% の確率で起こりうる規模」の意味で、100 年に一度しか起きないという意味ではありません。影響人口・操業停止・損失の列は、出典のあるアンカー値（下の前提）から相対係数で引き延ばした<b>仮定値</b>です。</p></div>
      <div class="grid map">
        <div class="card"><div class="card-h"><h2>${esc(HAZ[hz].ja)}：損失の再現期間曲線</h2><span class="r">${isQ ? srcTag('GEM v2026', D.gem._source.url, 'GEM 国別地震リスクプロファイル（建物損失）') : fc ? srcTag('WRI Aqueduct', fc.source_url, fc.note_ja) : ''}${asmTag(isQ ? '按分は仮定' : '地域値は仮定')}</span></div><div class="chart" id="rpChart"></div><div class="chart-cap">${series.map((s) => `<span><i class="ln" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>${fc ? `<div class="note" style="margin-top:10px">${ic('info')}<span><b>参考（表の最下行）：</b>${esc(fc.source_name)} の全国値は「都市資産の直接被害額」（2010 年ベースライン、防護水準を考慮しない曝露ベース）で、地域の仮定曲線（被害・損失、間接損失を含む）とは基準が異なるため同じ軸には重ねていません。</span></div>` : ''}</div>
        <div class="card"><div class="card-h"><h2>被害規模の目安</h2><span class="r">${asmTag('仮定')}</span><span class="sub">${esc(cfg.anchor_ja || '')}</span></div>
          <div class="tbl-wrap"><table class="rp-table"><thead><tr><th>再現期間<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">年超過確率</span></th><th style="min-width:210px">想定事象</th>${cfg.depth_max != null || cfg.area_max != null ? '<th class="n">浸水深<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">影響範囲</span></th>' : ''}<th class="n">影響人口<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">操業停止</span></th><th class="n">損失</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="num" style="white-space:nowrap"><b>${r.rp}年</b><span class="sub">${(r.p * 100).toFixed(r.rp >= 100 ? 1 : 0)}%／年</span></td><td style="font-size:12.5px;min-width:210px">${esc(r.scen)}</td>${cfg.depth_max != null || cfg.area_max != null ? `<td class="n">${cfg.depth_max != null ? (r.depth > 0 ? r.depth + ' m' : '—') : ''}<span class="sub">${cfg.area_max != null ? (r.area_pct > 0 ? r.area_pct + '%' : '—') : ''}</span></td>` : ''}<td class="n">${r.pop > 0 ? fmt(r.pop) : '—'}<span class="sub">${r.downtime > 0 ? r.downtime + '日' : '—'}</span></td><td class="n"><b>${esc(fmtUSD(r.loss))}</b>${isQ ? `<span class="sub">全国 ${esc(fmtUSD(r.loss_nat))}</span>` : ''}</td></tr>`).join('')}${fc ? `<tr style="background:var(--deep)"><td class="num" colspan="2" style="font-size:12px;color:var(--fg2)">参考：${esc(COUNTRY_JA[reg.country] || reg.country)}全国の河川洪水・都市被害額（Aqueduct 2010）</td><td colspan="${(cfg.depth_max != null || cfg.area_max != null) ? 3 : 2}" class="n" style="font-size:12px;color:var(--fg2)">${Object.values(fc.curve_m).every((v) => !v) ? '未モデル化（河川氾濫モデルの解像度上、対象外）' : RPS.map((rp) => `${rp}年 ${esc(fmtUSD(fc.curve_m[String(rp)]))}`).join('／')} ${srcTag('WRI Aqueduct', fc.source_url, fc.note_ja)}</td></tr>` : ''}</tbody></table></div>
          <details class="more" style="margin-top:10px"><summary>${ic('chev')}前提と計算方法</summary><div class="body"><p>${esc(cfg.method_ja || '')}</p><ul>${(cfg.assumptions_ja || []).map((a) => `<li>${esc(a)}</li>`).join('')}${isQ ? `<li>全国の損失曲線は GEM Foundation の国別地震リスクプロファイル v2026.0.0（住宅・商業・工業建物の損失、2025 年 USD）の値をそのまま用いています。地域按分の比率は GEM の「地域別 AAL」から読み取った仮定です。</li>` : ''}<li>影響人口＝都市圏人口 × 最大影響率 × 相対係数。操業停止日数は 2011 年タイ洪水での工業団地の操業停止期間（数週間〜数か月）を上限の参考にした仮定です。</li></ul>${(cfg.refs || []).map((r) => srcTag(r.name, r.url)).join(' ')}</div></details>
        </div>
      </div>`;
    rpChart($('#rpChart', root), { series, yLabel: '損失' });
  },
};
