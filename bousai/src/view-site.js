/* 画面2：企業・拠点版 災害時の備え評価 */
const SCEN_SITE = {
  flood: { ja: '洪水（河川氾濫・長期浸水）', short: '河川洪水', icon: 'wave', zone: 'flood', zoneCls: 'sm-flood' },
  urban_flood: { ja: '都市型浸水（集中豪雨・内水）', short: '都市浸水', icon: 'drop', zone: 'urban_flood', zoneCls: 'sm-flood' },
  quake: { ja: '地震（長周期地震動・建物被害）', short: '地震', icon: 'quake', zone: 'quake', zoneCls: 'sm-shake' },
  fire: { ja: '火災・停電（建物内の事故）', short: '火災・停電', icon: 'fire', zone: null, zoneCls: '' },
};
function walkMin(m, speed = 4) { return Math.round(m / (speed * 1000 / 60)); }
/* 経路コスト（シナリオ別） */
function routeCost(A, scen, A_area) {
  const hi = A.pois.filter((p) => ['mall_highrise', 'hotel'].includes(p.kind));
  return (e, a, b) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; let m = e.major ? 0.95 : 1;
    if (scen === 'flood' || scen === 'urban_flood') { const d = zoneDepthAt(A, scen, mx, my); if (d >= 0.6) return Infinity; if (d >= 0.3) m *= 3.5; else if (d > 0) m *= 1.8; }
    if (scen === 'quake') { const d = zoneDepthAt(A, 'quake', mx, my); if (d >= 1) m *= 2.2; for (const p of hi) { if (Math.hypot(p.x - mx, p.y - my) < 70) { m *= 1.5; break; } } if (!e.major) m *= 1.05; }
    return m;
  };
}
function shelterCandidates(A, area, scen, from, speed) {
  const fit = (p) => (p.shelter_for || []).includes(scen === 'urban_flood' ? 'flood' : scen) || (scen === 'fire' && (p.shelter_for || []).length > 0);
  const cost = routeCost(A, scen, area);
  return A.pois.filter(fit).map((p) => {
    const to = nearestNode(A, p.x, p.y); const r = shortestPath(A, from, to, cost); const dflood = (scen === 'flood' || scen === 'urban_flood') ? zoneDepthAt(A, scen, p.x, p.y) : 0;
    const reach = r && isFinite(r.cost); const len = reach ? r.len : null; const min = reach ? walkMin(len, speed) : null;
    const penalty = (dflood >= 0.6 ? 1e6 : dflood > 0 ? 1.4 : 1);
    return { poi: p, route: r, len, min, reach, dflood, score: reach ? r.cost * penalty : Infinity };
  }).sort((a, b) => a.score - b.score);
}

App.views.site = {
  st: { site: Store.get('site', 'bkk-hq'), scen: 'flood', me: 'site', custom: null, dest: null, done: Store.get('siteDone', {}) },
  init(root) {
    const st = this.st; const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">02 · Site readiness</span><span class="aud">${ic('building')}想定読者：拠点長・総務・安全管理担当</span></div>
          <h1>拠点の備えを、<em>避難の実際</em>から評価する</h1>
          <p class="q"><b>問い：</b>この拠点は、想定される災害に対して、誰が・どこへ・どの経路で避難し、何を備えておくべきか。</p>
        </div>
        <div class="vh-r"><span class="tag asm">避難所・経路は概略図上のデモ</span></div>
      </div>
      <div class="ctl">
        <div class="f"><label for="stSel">拠点</label><select id="stSel">${M.sites().map((s) => `<option value="${s.id}">${esc(s.label)}　${esc(s.name_ja)}</option>`).join('')}</select></div>
        <div class="f"><label>シナリオ</label><div class="seg" id="scSeg">${Object.entries(SCEN_SITE).map(([k, v]) => `<button data-scen="${k}" aria-pressed="${k === st.scen}">${ic(v.icon)}${esc(v.short)}</button>`).join('')}</div></div>
        <div class="f"><label>現在地</label><div class="seg" id="meSeg"><button data-me="site" aria-pressed="true">${ic('building')}拠点</button><button data-me="home" aria-pressed="false">${ic('home')}駐在員住宅（代表）</button><button data-me="custom" aria-pressed="false">${ic('pin')}地図をクリック</button></div></div>
      </div>
      <div class="grid side">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="card flush"><div class="map-box tall" id="stMapBox"><svg id="stMap" role="img" aria-label="拠点周辺の概略図と避難経路"></svg><div class="hint" id="stHint"></div><div class="legend" id="stLegend"></div><div class="attr" id="stAttr"></div></div></div>
          <div id="stRoutes" class="grid c3"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px" id="stSide"></div>
      </div>
      <section class="sec" id="stShelters"></section>
      <section class="sec" id="stAlerts"></section>
      <section class="sec" id="stTodo"></section>
      <section class="sec" id="stInfo"></section>`;
    $('#stSel', root).value = st.site;
    $('#stSel', root).onchange = (e) => { st.site = e.target.value; st.custom = null; st.dest = null; Store.set('site', st.site); self.update(root); };
    $('#scSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.scen = b.dataset.scen; st.dest = null; $$('#scSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); self.update(root); };
    $('#meSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.me = b.dataset.me; $$('#meSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); if (st.me === 'custom') toast('地図上の任意の地点をクリックすると、そこからの経路を計算します'); st.dest = null; self.update(root); };
    root.addEventListener('click', (e) => { const d = e.target.closest('[data-dest]'); if (d) { st.dest = d.dataset.dest; self.update(root); } const c = e.target.closest('[data-chk]'); if (c) { st.done[c.dataset.chk] = !st.done[c.dataset.chk]; Store.set('siteDone', st.done); self.update(root); } });
    this.update(root);
  },
  show(root) { const s = Store.get('site', this.st.site); if (s !== this.st.site) { this.st.site = s; $('#stSel', root).value = s; this.st.custom = null; this.update(root); } },
  update(root) {
    const st = this.st; const site = M.site(st.site); const area = M.area(site.area); const reg = M.region(site.region); const c = M.country(site.country || reg.country);
    if (!area) { $('#stSide', root).innerHTML = '<div class="empty">拠点周辺図が未設定です</div>'; return; }
    const A = area._built || (area._built = buildArea(area));
    const siteXY = localXY(area, site.lon, site.lat); const homeXY = site.home ? localXY(area, site.home.lon, site.home.lat) : siteXY;
    const me = st.me === 'custom' && st.custom ? st.custom : st.me === 'home' ? { x: homeXY[0], y: homeXY[1], label: site.home ? site.home.name_ja : '住宅' } : { x: siteXY[0], y: siteXY[1], label: site.label + ' 拠点' };
    const from = nearestNode(A, me.x, me.y); const speed = 4;
    const cands = shelterCandidates(A, area, st.scen, from, speed);
    const best = cands.find((x) => x.reach); const chosen = st.dest ? cands.find((x) => x.poi.name === st.dest) : best;
    const alts = cands.filter((x) => x.reach && x !== chosen).slice(0, 2);
    const scen = SCEN_SITE[st.scen];
    const routes = []; if (chosen && chosen.route) routes.push({ path: chosen.route.path }); alts.forEach((a) => routes.push({ path: a.route.path, cls: 'alt' }));
    const closed = new Set(cands.filter((x) => x.dflood >= 0.6 || !x.reach).map((x) => x.poi.name));
    renderAreaMap($('#stMap', root), A, area, { scenario: scen.zone, zoneCls: scen.zoneCls, me, routes, dest: chosen ? chosen.poi.name : null, closed, site: { x: siteXY[0], y: siteXY[1], name: site.label + ' ' + site.short_ja }, onMap: (x, y) => { if (st.me !== 'custom') { st.me = 'custom'; $$('#meSeg button', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.me === 'custom')); } st.custom = { x, y, label: '現在地（指定）' }; st.dest = null; this.update(root); }, onPoi: (name) => { const cnd = cands.find((x) => x.poi.name === name); if (cnd && cnd.reach) { st.dest = name; this.update(root); } else toast(`${name}：このシナリオでは避難先に適しません`); } });
    $('#stHint', root).innerHTML = `${ic('route')}<span>${esc(scen.ja)}：${chosen ? `最適 <b>${esc(chosen.poi.name_ja || chosen.poi.name)}</b>（徒歩 ${chosen.min} 分・${fmt(chosen.len)} m）` : '到達可能な避難先がありません'}</span>`;
    $('#stLegend', root).innerHTML = `<span class="t">凡例</span><span><i style="background:var(--sel);border-radius:50%"></i>現在地</span><span><i style="background:var(--fg);border-radius:2px"></i>拠点</span><span><i style="background:var(--ok);border-radius:50%"></i>公園・広場</span><span><i style="background:var(--accent);border-radius:50%"></i>高層施設（垂直避難）</span><span><i style="background:var(--crit);border-radius:50%"></i>病院</span><span><i style="background:var(--poi);border-radius:50%"></i>大使館・領事館</span>${scen.zone === 'quake' ? '<span><i style="background:var(--crit);opacity:.3"></i>想定被害（軟弱地盤・落下物）</span>' : scen.zone ? '<span><i style="background:var(--m-flood);opacity:.4"></i>想定浸水域（濃＝深い）</span>' : ''}<span><i class="ln" style="background:var(--sel)"></i>推奨経路　<i class="ln" style="background:var(--muted)"></i>代替</span>`;
    $('#stAttr', root).textContent = `概略図：道路網は模式化、施設は実座標に基づく相対配置 · 浸水域・被害域は${area.zone_src_ja || '仮定'}`;
    /* 経路カード */
    const card = (cnd, best) => `<div class="route-card${best ? ' best' : ''}" data-dest="${esc(cnd.poi.name)}" role="button" tabindex="0"><div class="h">${ic(best ? 'check' : 'route')}${best ? '推奨' : '代替'}：${esc(cnd.poi.name_ja || cnd.poi.name)}</div><div class="kv"><span>距離 <b>${fmt(cnd.len)} m</b></span><span>徒歩 <b>${cnd.min} 分</b></span>${cnd.poi.floors ? `<span>階数 <b>${cnd.poi.floors}</b></span>` : ''}${cnd.poi.cap ? `<span>収容目安 <b>${fmt(cnd.poi.cap)}</b></span>` : ''}</div><ol class="steps">${(cnd.poi.why_ja ? [`適性：${cnd.poi.why_ja}`] : []).concat(cnd.dflood > 0 ? [`注意：施設周辺に浸水想定（${cnd.dflood} m）`] : []).concat(scen.zone === 'quake' ? ['余震に備え、建物から離れた位置で待機'] : scen.zone ? ['冠水した道路は避け、流れのある水には入らない（FEMA：15cm で転倒、30cm で車が流される）'] : ['非常階段を使用、エレベーターは使わない']).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
    $('#stRoutes', root).innerHTML = (chosen ? card(chosen, true) : '') + alts.map((a) => card(a, false)).join('') || '<div class="empty">避難先候補なし</div>';
    /* 右側：備えスコア */
    const sc = siteScore(site);
    $('#stSide', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>${esc(site.name_ja)}</h2><span class="r"><span class="tag ${sc.total >= 75 ? 'ok' : sc.total >= 50 ? 'warn' : 'crit'}">${ic('shield')}備えスコア ${sc.total}</span></span><span class="sub">${esc(site.desc_ja || '')}</span></div>
        <div class="score-rows">${sc.cats.map((cat) => `<div class="score-row"><span class="k">${esc(cat.label)}<small>${esc(cat.note)}</small></span><span class="track"><i style="width:${cat.score}%;background:${cat.score >= 75 ? 'var(--ok)' : cat.score >= 50 ? 'var(--warn)' : 'var(--crit)'}"></i></span><span class="v">${cat.score}</span></div>`).join('')}</div>
        <div class="note" style="margin-top:10px">${ic('info')}<span>8 分野の整備状況（整備 1／一部 0.5／未整備 0）を重み付き平均した<b>デモ値</b>。分野の構成は内閣府「事業継続ガイドライン」と中小企業庁「BCP策定運用指針」の要素を参考にしています。</span></div></div>
      <div class="card"><div class="card-h"><h2>拠点の災害リスク</h2><span class="r">${srcTag('ThinkHazard', reg.th_url)}</span></div><div class="hz-grid">${['flood', 'urban_flood', 'quake', 'cyclone', 'heat', 'haze'].map((k) => { const v = reg.hazards && reg.hazards[HAZ[k].th]; return `<div class="hz" style="cursor:default"><span class="h">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</span>${lvTag(v ? v.level : 'unknown')}</div>`; }).join('')}</div>${site.risk_note_ja ? `<p style="font-size:12.5px;color:var(--fg2);margin:10px 0 0">${esc(site.risk_note_ja)}</p>` : ''}</div>`;
    /* 避難所候補テーブル */
    $('#stShelters', root).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>避難先候補（${esc(scen.short)}）</h2><span class="r"><span class="tag neutral">現在地：${esc(me.label)}</span></span><p>行をクリックすると経路を表示します。浸水想定域内や到達不能な候補は薄く表示します。収容目安は施設の規模からの仮定です。</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>候補</th><th>種別</th><th class="n">距離</th><th class="n">徒歩</th><th>適するシナリオ</th><th>備考</th></tr></thead><tbody>${cands.map((x) => `<tr class="click${chosen && chosen.poi.name === x.poi.name ? ' sel' : ''}" data-dest="${esc(x.poi.name)}" style="${x.reach && x.dflood < 0.6 ? '' : 'opacity:.5'}"><td><b>${esc(x.poi.name_ja || x.poi.name)}</b><span class="sub">${esc(x.poi.name)}</span></td><td>${esc({ park_open_space: '公園・広場', mall_highrise: '高層商業施設', hotel: 'ホテル', hospital: '病院', embassy: '在外公館', school: '学校', station: '駅', government: '公共施設' }[x.poi.kind] || x.poi.kind)}</td><td class="n">${x.reach ? fmt(x.len) + ' m' : '到達不能'}</td><td class="n">${x.reach ? x.min + ' 分' : '—'}</td><td>${(x.poi.shelter_for || []).map((s) => `<span class="tag neutral">${esc(SCEN_SITE[s] ? SCEN_SITE[s].short : s)}</span>`).join(' ')}</td><td style="font-size:12.5px;color:var(--fg2)">${esc(x.poi.why_ja || '')}${x.dflood ? `<span class="tag warn" style="margin-left:4px">浸水想定 ${x.dflood}m</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">候補なし</td></tr>'}</tbody></table></div>`;
    /* 警報・情報手段 */
    const ch = (c.alert_channels || []); const regd = site.alerts || {};
    $('#stAlerts', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>警報と情報の受け取り方（防災無線の代替）</h2><p>日本の防災行政無線のような屋外スピーカー網は、この地域の都市部には原則ありません。代わりに携帯向け緊急速報（セルブロードキャスト）・公式アプリ・SNS・在外公館の領事メールを組み合わせます。登録状況は拠点のデモ値です。</p></div>
      <div class="grid c2">
        <div class="card"><div class="card-h"><h2>${esc(COUNTRY_JA[reg.country] || reg.country)}の警報チャネル</h2><span class="r">${c.alert_src ? srcTag(c.alert_src_name || '出典', c.alert_src) : ''}</span></div><div class="chk-list">${ch.map((a) => `<div class="chk" data-done="${regd[a.key] ? 1 : 0}"><span class="box">${ic('check')}</span><span class="t"><b>${esc(a.name_ja)}</b><span>${esc(a.desc_ja || '')}</span></span><span class="pri ${regd[a.key] ? 'p3' : 'p1'}">${regd[a.key] ? '登録済' : '未登録'}</span></div>`).join('') || '<div class="empty">チャネル情報なし</div>'}</div>${c.alert_note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(c.alert_note_ja)}</span></div>` : ''}</div>
        <div class="card"><div class="card-h"><h2>日本側の公的チャネル</h2><span class="r">${srcTag('外務省', 'https://www.anzen.mofa.go.jp/')}</span></div><div class="chk-list">${(D.contacts && D.contacts.mofa_services || []).map((m) => `<div class="chk" data-done="${regd[m.key] ? 1 : 0}"><span class="box">${ic('check')}</span><span class="t"><b>${esc(m.name_ja)}</b><span>${esc(m.what_ja || '')}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener">リンク</a>` : ''}</span></span><span class="pri ${regd[m.key] ? 'p3' : 'p2'}">${regd[m.key] ? '登録済' : '未登録'}</span></div>`).join('')}</div></div>
      </div>`;
    /* 備えておくべきこと */
    const gaps = sc.gaps; const g = M.guidance();
    const ref = (key) => { const r = g.find((x) => x.key === key); return r ? srcTag(r.source_name, r.source_url) : ''; };
    $('#stTodo', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>拠点として備えておくべきこと</h2><span class="r"><span class="tag crit">優先 ${gaps.filter((x) => x.pri === 1).length}</span><span class="tag warn">推奨 ${gaps.filter((x) => x.pri === 2).length}</span><span class="tag neutral">整備済 ${sum(sc.cats, (c) => c.items.filter((i) => i.s === 1).length)}</span></span><p>未整備・一部整備の項目を優先度順に並べています。チェックは閲覧者の端末に保存されます（デモ）。</p></div>
      <div class="grid c2"><div class="chk-list">${gaps.slice(0, Math.ceil(gaps.length / 2)).map((it) => `<div class="chk" data-done="${st.done[site.id + '|' + it.id] ? 1 : 0}"><button class="box" data-chk="${esc(site.id + '|' + it.id)}" aria-label="完了にする">${ic('check')}</button><span class="t"><b>${esc(it.label)}</b><span>${esc(it.cat)}${it.s === 0.5 ? '・一部整備' : ''}${it.note ? '：' + esc(it.note) : ''} ${it.ref ? ref(it.ref) : ''}</span></span><span class="pri p${it.pri || 3}">${it.pri === 1 ? '優先' : it.pri === 2 ? '推奨' : '改善'}</span></div>`).join('')}</div><div class="chk-list">${gaps.slice(Math.ceil(gaps.length / 2)).map((it) => `<div class="chk" data-done="${st.done[site.id + '|' + it.id] ? 1 : 0}"><button class="box" data-chk="${esc(site.id + '|' + it.id)}" aria-label="完了にする">${ic('check')}</button><span class="t"><b>${esc(it.label)}</b><span>${esc(it.cat)}${it.s === 0.5 ? '・一部整備' : ''}${it.note ? '：' + esc(it.note) : ''} ${it.ref ? ref(it.ref) : ''}</span></span><span class="pri p${it.pri || 3}">${it.pri === 1 ? '優先' : it.pri === 2 ? '推奨' : '改善'}</span></div>`).join('')}</div></div>
      <details class="more"><summary>${ic('chev')}整備済みの項目（${sum(sc.cats, (c) => c.items.filter((i) => i.s === 1).length)}）</summary><div class="body"><ul>${sc.cats.flatMap((c) => c.items.filter((i) => i.s === 1).map((i) => `<li>${esc(c.label)}：${esc(i.label)}</li>`)).join('')}</ul></div></details>`;
    /* 拠点情報 */
    $('#stInfo', root).innerHTML = `<div class="sec-h"><span class="no">05</span><h2>拠点の基本情報と前提</h2></div><div class="grid c3">
      <div class="card"><div class="card-h"><h3>施設</h3></div><dl style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px"><dt class="muted">種別</dt><dd style="margin:0">${esc(site.type_ja)}</dd><dt class="muted">建物</dt><dd style="margin:0">${esc(site.building_ja || '—')}</dd><dt class="muted">従業員</dt><dd style="margin:0">${fmt(site.staff)} 名（うち日本人 ${fmt(site.jp_staff)} 名、帯同家族 ${fmt(site.families)} 名）</dd><dt class="muted">駐在員住宅</dt><dd style="margin:0">${esc(site.home ? site.home.name_ja : '—')}</dd></dl></div>
      <div class="card"><div class="card-h"><h3>地域の文脈</h3></div><p style="font-size:13px;color:var(--fg2);margin:0">${esc(area.flood_context_ja || '')}</p><p style="font-size:13px;color:var(--fg2);margin:8px 0 0">${esc(area.earthquake_context_ja || '')}</p>${(area.sources || []).map((s) => srcTag(s.name, s.url)).join(' ')}</div>
      <div class="card"><div class="card-h"><h3>この画面の前提</h3></div><ul style="font-size:12.5px;color:var(--fg2);margin:0;padding-left:18px"><li>道路網は格子状に模式化し、主要道路のみ実際の位置を近似。経路の距離・時間は目安（徒歩 ${speed} km/h）。</li><li>浸水想定域は ${esc(area.zone_src_ja || '過去の浸水事例と地形からの仮定')}。</li><li>避難先の「収容目安」「適性」は施設規模からの仮定で、施設側の受け入れ合意ではありません。</li><li>実運用では現地当局のハザードマップ、施設との協定、避難訓練の結果で置き換える必要があります。</li></ul></div></div>`;
  },
};
