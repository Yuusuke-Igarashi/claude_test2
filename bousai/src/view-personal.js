/* 画面3：パーソナライズダッシュボード（従業員向け）— 住所・家族構成・年齢を入力 → 住所に応じた事前の備えとリアルタイム情報 */
/* 住所→登録済み代表地点の照合（デモ：キーワード一致。実運用ではジオコーディングして最寄りの街区・浸水想定に照合） */
const ADDR_KEYS = {
  'bkk-hq': [['スクンビット', 'sukhumvit', 'プロンポン', 'phrom phong', 'soi 24', 'soi24', 'emquartier'], ['トンロー', 'thong lo', 'thonglor', 'soi 13', 'soi13'], ['アソーク', 'asok', 'asoke', 'soi 23', 'soi23', 'terminal 21'], ['ラーマ4', 'ラーマ 4', 'rama 4', 'rama iv', 'rama4', 'クロントゥーイ', 'khlong toei', 'klong toey']],
  'ayut-plant': [['アユタヤ市', '市街', 'ayutthaya city', 'u-thong', 'uthong', 'ウートン', 'naresuan', 'ナレースワン', 'pratu chai'], ['ロジャナ', 'rojana', 'uthai', 'ウタイ', '工業団地', 'industrial']],
  'jkt-office': [['クニンガン', 'kuningan', 'スティアブディ', 'setiabudi', 'rasuna', 'ラスナ'], ['scbd', 'スナヤン', 'senayan', 'sudirman', 'スディルマン', 'セノパティ', 'senopati'], ['メンテン', 'menteng', 'cikini', 'チキニ']],
  'mnl-office': [['bgc', 'ボニファシオ', 'bonifacio', 'taguig', 'タギッグ', 'fort', 'global city'], ['マカティ', 'makati', 'legaspi', 'レガスピ', 'salcedo', 'サルセド'], ['ロックウェル', 'rockwell', 'poblacion', 'ポブラシオン']],
};
const CITY_KEYS = { 'bkk-hq': ['バンコク', 'bangkok', 'krung thep', 'กรุงเทพ', 'bkk'], 'ayut-plant': ['アユタヤ', 'ayutthaya', 'อยุธยา'], 'jkt-office': ['ジャカルタ', 'jakarta', 'dki', 'jkt'], 'mnl-office': ['マニラ', 'manila', 'metro manila', 'ncr', 'quezon', 'ケソン', 'pasig', 'パシッグ', 'mnl'] };
const ADDR_EXAMPLES = ['Sukhumvit Soi 24, Bangkok', 'ロジャナ工業団地 東側, アユタヤ', 'Jl. Menteng Raya, Jakarta', '26th St, BGC, Taguig'];
function matchAddress(q) {
  const s = String(q || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); if (!s) return null;
  let best = null;
  Object.entries(ADDR_KEYS).forEach(([site, homes]) => homes.forEach((keys, idx) => { const score = sum(keys, (k) => (s.includes(k.toLowerCase()) ? k.length : 0)); if (score > 0 && (!best || score > best.score)) best = { site, homeIdx: idx, score, how: 'エリア名' }; }));
  if (best) return best;
  const city = Object.entries(CITY_KEYS).find(([, keys]) => keys.some((k) => s.includes(k.toLowerCase())));
  return city ? { site: city[0], homeIdx: 0, score: 0, how: '都市名（代表地点）' } : null;
}

App.views.me = {
  st: Object.assign({ site: Store.get('site', 'bkk-hq'), homeIdx: 0, home: 'highrise', floor: 18, members: [{ sex: 'm', age: 42, cond: false }, { sex: 'f', age: 39, cond: false }, { sex: 'f', age: 7, cond: false }, { sex: 'm', age: 1, cond: false }], pets: false, car: true, lang: false, days: 7, scen: 'flood', addr: '', addrHow: '' }, Store.get('personal', {})),
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">03 · Personalized dashboard</span><span class="aud">${ic('home')}想定読者：従業員とその家族</span></div>
          <h1>住所と家族に合わせた、<em>備えと今の状況</em></h1>
          <p class="q"><b>問い：</b>自分の住所・家族構成・年齢から、災害の種類ごとに「どこへ・どう逃げるか」「何をどれだけ備えるか」。そして、いま進行中の災害で自分の地区は何が使えて、どんな支援があるか。</p>
        </div>
        <div class="vh-r"><span class="tag neutral">入力はこの端末にのみ保存</span><div class="jump"><button class="btn sm" data-jump="meAnswer">${ic('shield')}事前の備え</button><button class="btn sm" data-jump="meLive">${ic('clock')}リアルタイム</button></div></div>
      </div>
      <div class="persona-note admin-only">${ic('info')}<span>この画面は従業員・家族向けです。管理者は従業員がどう見えるかを確認できます（入力はこの端末にのみ保存されます）。</span></div>
      <div class="grid side personal">
        <div class="card" id="psForm"></div>
        <div class="stack" id="psRight"><div class="grp-eb"><span class="eb">事前の備え · Preparedness</span></div><div class="answer" id="meAnswer"></div><div class="stack" id="psOut"></div></div>
      </div>
      <section class="sec" id="psStock"></section>
      <section class="sec" id="psTodo"></section>
      <section class="sec" id="psCard"></section>
      <div class="grp-eb"><span class="eb">リアルタイム · Live for your address</span></div>
      <section class="sec" id="meLive"></section>
      <section class="sec" id="meEvents"></section>`;
    root.addEventListener('click', (e) => { const j = e.target.closest('[data-jump]'); if (j) { const el = $('#' + j.dataset.jump, root); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; } const cp = e.target.closest('[data-copy]'); if (cp) copyText(cp.dataset.copy, cp); });
    document.addEventListener('ctxchange', () => { if (App.current === 'me') self.renderLive(root); });
    this.form(root); this.update(root);
  },
  form(root) {
    const st = this.st; const self = this; const site = M.site(st.site); const area = M.area(site.area);
    const homes = (area && area.homes) || [];
    $('#psForm', root).innerHTML = `<div class="card-h"><h2>住所・家族・住まい</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="fld"><label for="psAddr">住所（市・エリア・通り名など）</label><div class="addr"><input type="text" id="psAddr" value="${esc(st.addr || '')}" placeholder="例：Sukhumvit Soi 24, Bangkok" list="psAddrList" autocomplete="street-address"><button class="btn sm primary" id="psAddrBtn">${ic('search')}住所から特定</button></div><datalist id="psAddrList">${ADDR_EXAMPLES.map((a) => `<option value="${esc(a)}">`).join('')}</datalist><div class="addr-hit" id="psAddrHit">${st.addr ? `「${esc(st.addr)}」→ <b>${esc(site.short_ja)} 圏・${esc(homes[st.homeIdx] ? homes[st.homeIdx].name_ja : '代表地点')}</b> として表示中${st.addrHow ? `（${esc(st.addrHow)}で照合）` : ''}` : 'デモでは登録済みの代表地点に照合します。実運用では住所をジオコーディングし、最寄りの街区・浸水想定・避難所に対応づけます。'}</div><div class="ex-chips" aria-label="入力例">${ADDR_EXAMPLES.map((a) => `<button type="button" data-ex="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>
        <div class="two"><div class="fld"><label for="psSite">勤務先の拠点</label><select id="psSite">${M.sites().map((s) => `<option value="${s.id}">${esc(s.name_ja)}</option>`).join('')}</select></div><div class="fld"><label for="psHome">居住エリア（代表地点）</label><select id="psHome">${homes.map((h, i) => `<option value="${i}">${esc(h.name_ja)}</option>`).join('') || '<option value="0">（代表地点）</option>'}</select></div></div>
        <div class="two"><div class="fld"><label for="psType">住居タイプ</label><select id="psType"><option value="highrise">高層コンドミニアム</option><option value="lowrise">低層アパート（〜4階）</option><option value="house">一戸建て</option></select></div><div class="fld"><label for="psFloor">居住階</label><input type="number" id="psFloor" min="1" max="80" value="${st.floor}"></div></div>
        <div class="fld"><label>家族（本人を含む）：性別・年齢・要配慮</label><div class="members" id="psMembers"></div><button class="btn sm" id="psAdd" style="align-self:flex-start;margin-top:4px">${ic('users')}家族を追加</button></div>
        <div class="pills"><button class="pill" id="psPets" aria-pressed="${st.pets}">${ic('heart')}ペットあり</button><button class="pill" id="psCar" aria-pressed="${st.car}">${ic('car')}自家用車あり</button><button class="pill" id="psLang" aria-pressed="${st.lang}">${ic('globe')}現地語で会話できる</button></div>
        <div class="fld"><label id="psDaysLbl">備蓄日数（内閣府：最低 3 日、推奨 1 週間）</label><div class="seg" id="psDays" role="group" aria-labelledby="psDaysLbl"><button data-days="3" aria-pressed="${st.days === 3}">3日</button><button data-days="7" aria-pressed="${st.days === 7}">7日</button><button data-days="14" aria-pressed="${st.days === 14}">14日（物流途絶を想定）</button></div></div>
      </div>`;
    $('#psSite', root).value = st.site; $('#psHome', root).value = st.homeIdx; $('#psType', root).value = st.home;
    const renderMembers = () => { $('#psMembers', root).innerHTML = st.members.map((m, i) => `<div class="member"><select data-m="${i}" data-k="sex" aria-label="性別"><option value="m"${m.sex === 'm' ? ' selected' : ''}>男性</option><option value="f"${m.sex === 'f' ? ' selected' : ''}>女性</option><option value="x"${m.sex === 'x' ? ' selected' : ''}>その他</option></select><input type="number" min="0" max="110" value="${m.age}" data-m="${i}" data-k="age" aria-label="年齢" placeholder="年齢"><label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" data-m="${i}" data-k="cond"${m.cond ? ' checked' : ''}>持病・要配慮</label><button class="icon-btn del" data-del="${i}" aria-label="削除">${ic('x')}</button></div>`).join(''); };
    renderMembers();
    const save = () => { Store.set('personal', st); self.update(root); };
    const applyAddr = (q) => { st.addr = q; const m = matchAddress(q); if (!m) { st.addrHow = ''; Store.set('personal', st); $('#psAddrHit', root).innerHTML = `「${esc(q)}」から都市を特定できませんでした。デモで対応しているのは バンコク・アユタヤ・ジャカルタ・マニラ の代表地点です（下の入力例を試してください）。`; toast('住所から都市を特定できませんでした（デモ）'); return; } st.addrHow = m.how; const changed = m.site !== st.site; st.site = m.site; st.homeIdx = m.homeIdx; Store.set('site', st.site); const nh = ((M.area(M.site(st.site).area) || {}).homes || [])[st.homeIdx]; if (nh && nh.type) { st.home = nh.type; if (nh.floor) st.floor = nh.floor; } Store.set('personal', st); self.form(root); self.update(root); toast(`${M.site(st.site).short_ja} 圏の「${nh ? nh.name_ja : '代表地点'}」として表示します${changed ? '' : ''}`); };
    $('#psAddrBtn', root).onclick = () => applyAddr($('#psAddr', root).value.trim());
    $('#psAddr', root).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyAddr(e.target.value.trim()); } };
    $$('[data-ex]', root).forEach((b) => { b.onclick = () => { $('#psAddr', root).value = b.dataset.ex; applyAddr(b.dataset.ex); }; });
    $('#psSite', root).onchange = (e) => { st.site = e.target.value; st.homeIdx = 0; st.addr = ''; st.addrHow = ''; Store.set('site', st.site); self.form(root); self.update(root); };
    $('#psHome', root).onchange = (e) => { st.homeIdx = +e.target.value; const h = homes[st.homeIdx]; if (h && h.type) { st.home = h.type; $('#psType', root).value = h.type; if (h.floor) { st.floor = h.floor; $('#psFloor', root).value = h.floor; } } st.addr = ''; st.addrHow = ''; $('#psAddrHit', root).textContent = `代表地点「${h ? h.name_ja : ''}」を選択中。住所を入力すると、その住所に近い代表地点に切り替わります（デモ）。`; save(); };
    $('#psType', root).onchange = (e) => { st.home = e.target.value; save(); };
    $('#psFloor', root).onchange = (e) => { st.floor = clamp(+e.target.value || 1, 1, 80); save(); };
    $('#psMembers', root).onchange = (e) => { const t = e.target; const i = +t.dataset.m, k = t.dataset.k; if (k === 'cond') st.members[i].cond = t.checked; else if (k === 'age') st.members[i].age = clamp(+t.value || 0, 0, 110); else st.members[i].sex = t.value; save(); };
    $('#psMembers', root).onclick = (e) => { const b = e.target.closest('[data-del]'); if (!b) return; if (st.members.length <= 1) { toast('1 名以上必要です'); return; } st.members.splice(+b.dataset.del, 1); renderMembers(); save(); };
    $('#psAdd', root).onclick = () => { st.members.push({ sex: 'f', age: 30, cond: false }); renderMembers(); save(); };
    $('#psPets', root).onclick = (e) => { st.pets = !st.pets; e.currentTarget.setAttribute('aria-pressed', st.pets); save(); };
    $('#psCar', root).onclick = (e) => { st.car = !st.car; e.currentTarget.setAttribute('aria-pressed', st.car); save(); };
    $('#psLang', root).onclick = (e) => { st.lang = !st.lang; e.currentTarget.setAttribute('aria-pressed', st.lang); save(); };
    $('#psDays', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.days = +b.dataset.days; $$('#psDays button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); save(); };
  },
  show(root) { this.renderLive(root); },
  update(root) {
    const st = this.st; const site = M.site(st.site); const area = M.area(site.area); const reg = M.region(site.region); const c = M.country(site.country || reg.country);
    const plan = personalPlan(st); const self = this;
    const A = area ? (area._built || (area._built = buildArea(area))) : null;
    const home = area && area.homes && area.homes[st.homeIdx] ? area.homes[st.homeIdx] : null;
    const hxy = home ? localXY(area, home.lon, home.lat) : localXY(area, site.lon, site.lat);
    /* 住まいのリスク */
    const lv = (k) => hazardLevel(reg, k).level;
    const risks = [];
    const fl = lvInfo(lv('flood')).k, uf = lvInfo(lv('urban_flood')).k, eq = lvInfo(lv('quake')).k, cy = lvInfo(lv('cyclone')).k, hz = lvInfo(lv('haze')).k, ht = lvInfo(lv('heat')).k;
    if (fl >= 3 || uf >= 3) risks.push({ k: 'flood', lv: Math.max(fl, uf), ja: st.home === 'highrise' && st.floor >= 4 ? `浸水そのものより、長期の停電・断水・エレベーター停止と物流途絶が問題になります（${st.floor} 階）。` : st.home === 'house' ? '一戸建ては床上浸水の直接被害を受けます。早期の水平避難が前提です。' : '低層階は浸水の直接被害を受けます。上層階への垂直避難先を建物内で決めておきます。' });
    if (eq >= 2) risks.push({ k: 'quake', lv: eq, ja: st.home === 'highrise' ? '高層階は遠方の大地震でも長周期の揺れで家具が移動します。2025 年 3 月のミャンマー地震ではバンコクの高層建物が大きく揺れました。' : '揺れたら身を守り、収まってから建物を出て開けた場所へ。ガスの元栓・ブレーカーを確認。' });
    if (cy >= 3) risks.push({ k: 'cyclone', lv: cy, ja: '台風接近前に 72 時間分の水・食料と窓の対策。接近中は外出しない。' });
    if (hz >= 2 || ht >= 2) risks.push({ k: 'haze', lv: Math.max(hz, ht), ja: '乾季の煙霧（PM2.5）と暑熱。子ども・高齢者は外出制限と N95 マスク、室内は空気清浄機。' });
    const scenKeys = ['flood', 'quake']; if (!scenKeys.includes(st.scen)) st.scen = 'flood';
    const me = { x: hxy[0], y: hxy[1], label: home ? home.name_ja.split('・')[0] : '自宅' };
    const cons = plan.cons.find((x) => x.k === 'walk'); const speed = cons ? cons.speed : 4;
    let cands = [], best = null, within = null;
    if (A) { const from = nearestNode(A, me.x, me.y); cands = shelterCandidates(A, area, st.scen, from, speed); within = cands.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)); best = within || cands.find((x) => x.reach); }
    const outOfCond = best && !within && cons;
    const homeDepth = A ? { flood: zoneDepthAt(A, 'flood', hxy[0], hxy[1]), urban: zoneDepthAt(A, 'urban_flood', hxy[0], hxy[1]) } : { flood: 0, urban: 0 };
    const vertical = st.scen === 'flood' && st.home === 'highrise' && st.floor >= 4;
    const bestFor = (k) => { if (!A) return null; const from = nearestNode(A, me.x, me.y); const cs = shelterCandidates(A, area, k, from, speed); return cs.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)) || cs.find((x) => x.reach); };
    const floodBest = bestFor('flood'), quakeBest = bestFor('quake');
    const vert = st.home === 'highrise' && st.floor >= 4;
    this._ctx = { site, area, reg, home, me, plan, speed, floodBest, quakeBest, vert, homeDepth };
    const pname = (b) => esc(b.poi.name_ja || b.poi.name);
    $('#meAnswer', root).innerHTML = `<span class="k">答え</span><ul>
      <li><b>${esc(home ? home.name_ja : site.short_ja + ' 周辺')}</b>${st.addr ? `（入力住所「${esc(st.addr)}」に対応）` : ''}・${esc({ highrise: '高層コンド', lowrise: '低層アパート', house: '一戸建て' }[st.home] || st.home)} ${st.floor} 階・${plan.n} 人家族として計算。</li>
      <li><b>洪水のとき：</b>${vert ? `自宅 ${st.floor} 階に留まる垂直避難が第一候補。長期化なら ${floodBest ? pname(floodBest) + `（徒歩 ${walkMin(floodBest.len, speed)} 分）` : '徒歩圏の高層施設'} へ。` : floodBest ? `${pname(floodBest)} へ早めに移動（徒歩 ${walkMin(floodBest.len, speed)} 分）。` : '徒歩圏の高層施設を確認。'}<b>地震のとき：</b>${quakeBest ? `揺れが収まったら ${pname(quakeBest)} へ（徒歩 ${walkMin(quakeBest.len, speed)} 分）。` : '近くの広場へ。'}</li>
      <li><b>備蓄：</b>${plan.n} 人 × ${plan.days} 日で飲料水 ${plan.water} L・食料 ${plan.meals} 食${plan.infants ? '・粉ミルク／おむつ' : ''}${plan.elders ? '・高齢者用品' : ''}${plan.needs ? '・持病の薬 ' + Math.max(7, plan.days) + ' 日分' : ''}（内閣府の目安 3L/人/日）。</li>
      <li><b>日頃の登録：</b>在留届・たびレジ、家族の集合場所 3 段階と域外連絡先、緊急連絡先カード（下の行動チェック）。</li></ul>`;
    const condNotes = plan.cons.filter((x) => x.k !== 'walk');
    $('#psOut', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>住まいのリスク（${esc(reg.name_ja)}）</h2><span class="r">${srcTag('ThinkHazard', reg.th_url)}</span></div>${risks.length ? `<div style="display:flex;flex-direction:column;gap:8px">${risks.map((r) => `<div class="note ${r.lv >= 4 ? 'warn' : ''}">${ic(HAZ[r.k].icon)}<span><b>${esc(HAZ[r.k].short)}（${lvInfo(['unknown', 'Very low', 'Low', 'Medium', 'High'][r.lv]).ja}）：</b>${esc(r.ja)}</span></div>`).join('')}</div>` : '<div class="empty">この地域の主要ハザードは低水準です</div>'}
        <div class="note" style="margin-top:8px">${ic('pin')}<span><b>自宅地点（${esc(home ? home.name_ja : '代表地点')}）の想定浸水深：</b>河川洪水 ${homeDepth.flood > 0 ? homeDepth.flood + ' m' : '想定域外'}、都市型浸水 ${homeDepth.urban > 0 ? homeDepth.urban + ' m' : '想定域外'} ${asmTag('概略図の仮定')}。${homeDepth.flood >= 0.5 && st.home !== 'highrise' ? '<b>浸水想定域内の低層住居のため、垂直避難は提示しません。</b>' : ''}</span></div></div>
      <div class="card flush"><div style="padding:12px 16px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="font-size:15px;margin:0;font-weight:600">パーソナライズ避難行動：避難先と避難路</h2><div class="seg" id="psScen" role="group" aria-label="避難シナリオ">${scenKeys.map((k) => `<button data-scen="${k}" aria-pressed="${k === st.scen}">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</button>`).join('')}</div><span class="tag neutral">${esc(cons ? cons.ja : '')}</span></div>
        ${condNotes.length ? `<div style="padding:8px 16px 0;display:flex;flex-direction:column;gap:6px">${condNotes.map((x) => `<div class="note" style="padding:6px 10px">${ic(x.k === 'car' ? 'car' : 'home')}<span>${esc(x.ja)}</span></div>`).join('')}</div>` : ''}
        <div style="padding:10px 16px 12px">${vertical ? `<div class="note ok">${ic('home')}<span><b>第一候補は自宅に留まる「垂直避難」です。</b>${st.floor} 階は浸水しませんが、停電・断水・エレベーター停止が ${plan.days} 日以上続く前提で備蓄します。水や物流が長期に途絶する見込みなら、下の水平避難先へ早めに移動します。</span></div>` : best ? `<div class="note ${outOfCond ? 'warn' : 'ok'}">${ic('route')}<span><b>推奨避難先：${pname(best)}</b>（${fmt(best.len)} m・徒歩 ${walkMin(best.len, speed)} 分）。${esc(best.poi.why_ja || '')}${outOfCond ? `<br><b>条件（${esc(cons.ja)}）内に候補がなく、最寄りを表示しています。</b>移動手段（車・送迎）の確保が必要です。` : ''}</span></div>` : `<div class="note warn">${ic('alert')}<span>条件に合う避難先が見つかりません。徒歩圏の高層建物を個別に確認してください。</span></div>`}</div>
        <div class="map-box" style="border-radius:0;border:0;border-top:1px solid var(--line)"><svg id="psMap" role="img" aria-label="自宅周辺の避難経路"></svg><div class="attr">概略図・デモ</div></div>
        ${best ? `<div style="padding:10px 16px 14px;font-size:12.5px;color:var(--fg2)">代替：${cands.filter((x) => x.reach && x !== best).slice(0, 2).map((x) => `${esc(x.poi.name_ja || x.poi.name)}（${walkMin(x.len, speed)} 分）`).join('、') || 'なし'}。${st.lang ? '' : '現地語での会話が難しい場合は、日本語対応のある病院・日本人会・大使館の位置を家族全員が地図で確認しておきます。'}</div>` : ''}
      </div>`;
    $('#psScen', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.scen = b.dataset.scen; Store.set('personal', st); self.update(root); };
    if (A) renderAreaMap($('#psMap', root), A, area, { scenario: st.scen === 'quake' ? 'quake' : 'flood', zoneCls: st.scen === 'quake' ? 'sm-shake' : 'sm-flood', me, routes: best && !vertical ? [{ path: best.route.path }].concat(cands.filter((x) => x.reach && x !== best).slice(0, 2).map((x) => ({ path: x.route.path, cls: 'alt' }))) : [], dest: best && !vertical ? best.poi.name : null, site: { x: localXY(area, site.lon, site.lat)[0], y: localXY(area, site.lon, site.lat)[1], name: site.label + ' 拠点' }, onPoi: (n) => toast(n) });
    /* 備蓄 */
    $('#psStock', root).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>日頃の備え：備蓄量</h2><span class="r"><span class="tag neutral">${plan.n} 人・${plan.days} 日分</span>${srcTag('内閣府 防災情報', 'https://www.bousai.go.jp/kyoiku/keigen/gensai/kiroku/bichiku.html', '家庭での備蓄の目安：飲料水 3L/人/日、最低 3 日分、できれば 1 週間分')}</span><p>家族構成から自動計算。乳幼児・高齢者・女性・持病のある方の分は個別に追加しています。現地のスーパーで入手できるものは「ローリングストック」で回します。</p></div>
      <div class="stock">${plan.items.map((it) => `<div class="it"><b>${it.v}</b><span>${esc(it.k)}</span><span class="why">${esc(it.why)} ${it.asm ? asmTag() : it.src === 'naikakufu' ? srcTag('内閣府', 'https://www.bousai.go.jp/kyoiku/keigen/gensai/kiroku/bichiku.html') : it.src === 'sphere' ? srcTag('Sphere', 'https://spherestandards.org/handbook/') : it.src === 'mofa' ? srcTag('外務省', 'https://www.anzen.mofa.go.jp/') : it.src === 'who' ? srcTag('WHO', 'https://www.who.int/') : ''}</span></div>`).join('')}</div>`;
    /* 行動チェック */
    const g = M.guidance().filter((x) => x.audience !== 'company');
    const todo = [
      { b: '在留届・たびレジの登録', s: '緊急時に在外公館から領事メール・安否確認が届く。家族全員分', src: (D.contacts && D.contacts.mofa_services || []).find((m) => /在留届|ORR/.test(m.name_ja)) },
      { b: '家族の連絡ルールを決める', s: '集合場所 3 段階（自宅前→避難先→拠点）、日本の親族など「域外連絡先」を 1 名、学校の引き取りルール', src: null },
      { b: '緊急連絡先カードを作る', s: `救急 ${esc(((c.emergency_numbers || []).find((n) => /救急/.test(n.service_ja)) || {}).number || '—')}、警察 ${esc(((c.emergency_numbers || []).find((n) => /警察/.test(n.service_ja)) || {}).number || '—')}、大使館、かかりつけ病院、勤務先。紙で財布と子どものかばんへ。番号は第三者データ転記のため、赴任時に在外公館の公式サイトで確認`, src: null, warn: true },
      { b: '住まいの安全', s: st.home === 'highrise' ? '家具の固定、ガラス飛散防止、非常階段の位置、停電時の給水（高層階は断水しやすい）' : '止水板・土のう、2 階への持ち上げ、ブレーカーの位置、近所の高い建物', src: null },
      { b: '健康面の準備', s: '処方薬の英語名と予備、ワクチン（破傷風・A型肝炎など）、蚊対策、飲料水の消毒方法（煮沸 1 分）', src: g.find((x) => /飲料水の消毒/.test(x.category_ja || '') || /煮沸/.test(x.recommendation_ja || '')) },
      { b: '現金・書類', s: '現地通貨の小額紙幣、パスポートの写し、保険証券、緊急時の帰国手段（航空会社の連絡先）', src: null },
    ];
    $('#psTodo', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>日頃の備え：行動チェック</h2></div><div class="ready">${todo.map((t) => `<div class="it">${ic('check')}<div><b>${esc(t.b)}${t.warn ? ' <span class="tag warn">要確認</span>' : ''}</b><span>${t.s}</span>${t.src ? ' ' + srcTag(t.src.name_ja || t.src.source_name, t.src.url || t.src.source_url) : ''}</div></div>`).join('')}</div>`;
    /* 家族カード */
    const emb = (c.japanese_missions || [])[0];
    $('#psCard', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>家族防災カード</h2><p>この内容を印刷またはスクリーンショットして、家族全員が持ち歩けるようにします。</p></div>
      <div class="fam-card"><span class="eb">Family emergency card · ${esc(reg.name_ja)}</span><h3>${esc(home ? home.name_ja : site.name_ja)} の ${plan.n} 人家族</h3>
        <dl><dt>家族</dt><dd>${st.members.map((m) => `${m.age}歳${m.cond ? '（要配慮）' : ''}`).join('、')}${st.pets ? '、ペット' : ''}</dd>
        <dt>洪水のとき</dt><dd>${vert ? `自宅 ${st.floor} 階に留まる（垂直避難）。長期化なら ${floodBest ? pname(floodBest) + `（徒歩 ${walkMin(floodBest.len, speed)} 分）` : '高層施設'} へ` : floodBest ? `${pname(floodBest)}（徒歩 ${walkMin(floodBest.len, speed)} 分）へ早めに移動` : '徒歩圏の高層建物へ'}</dd>
        <dt>地震のとき</dt><dd>揺れが収まったら非常階段で外へ。${quakeBest ? `${pname(quakeBest)}（徒歩 ${walkMin(quakeBest.len, speed)} 分）に集合` : '開けた場所（公園・広場）に集合'}。余震に注意</dd>
        <dt>集合場所</dt><dd>① 自宅前 → ② ${quakeBest ? pname(quakeBest) : '近くの広場'}（洪水時は ${floodBest ? pname(floodBest) : '高層施設'}） → ③ ${esc(site.label)} 拠点（${esc(site.short_ja)}）</dd>
        <dt>緊急電話</dt><dd class="num">${(c.emergency_numbers || []).slice(0, 3).map((n) => `${esc(n.service_ja)} ${esc(n.number)}`).join(' / ') || '—'} <span class="tag warn" style="font-family:var(--f-body)">要確認</span></dd>
        <dt>在外公館</dt><dd>${emb ? `${esc(emb.name_ja)} ${esc(emb.phone || '')}` : '—'} <span class="tag warn">要確認</span></dd>
        <dt>域外連絡先</dt><dd>（日本の親族の氏名・電話番号を記入）</dd></dl>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="psCopy">${ic('doc')}テキストをコピー</button><span class="muted" style="font-size:11.5px;align-self:center">作成 ${new Date().toLocaleDateString('ja-JP')}・デモ。電話番号は第三者データからの転記で、在外公館の公式サイトで確認してから印刷してください</span></div></div>`;
    $('#psCopy', root).onclick = () => { const txt = $('.fam-card dl', root).innerText; copyText(txt, $('.fam-card dl', root)); };
    this.renderLive(root);
  },
  /* リアルタイム：住所（代表地点）が属する進行中イベントと地区を特定して表示 */
  renderLive(root) {
    const st = this.st; const cx = this._ctx || {}; const site = M.site(st.site); const box = $('#meLive', root); const evBox = $('#meEvents', root); const self = this;
    const scs = M.scenarios().filter((sc) => (sc.sites || []).some((s) => s.id === site.id) || (sc.supply_sites || []).includes(site.id) || sc.region === site.region);
    const sc = scs.find((s) => s.status !== 'watch') || scs[0];
    if (!sc) { box.innerHTML = `<div class="sec-h"><span class="no">05</span><h2>リアルタイム：あなたの地区の状況</h2></div><div class="note ok">${ic('check')}<span><b>進行中の災害・警報はありません。</b>${esc(site.short_ja)} 圏にはデモのシナリオが登録されていません。</span></div>`; evBox.innerHTML = ''; return; }
    const t = Live.t(sc); const watch = sc.status === 'watch';
    const did = (sc.area_id === site.area && sc.area_district) ? sc.area_district : (((sc.sites || []).find((s) => s.id === site.id) || {}).district || sc.default_district || ((sc.districts || [])[0] || {}).id);
    const parts = localLive(sc, t, did, { area: cx.area, home: cx.me });
    const d = parts.d; const r = parts.r; const util = (k) => { const u = r.util.find((x) => x.key === k); return u ? (u.per[did] ? u.per[did].avail : u.avail) : null; };
    const pname = (b) => esc(b.poi.name_ja || b.poi.name);
    /* あなたへの行動指示 */
    let act;
    if (watch) act = { cls: 'warn', icon: 'cloud', ja: `警報段階で、被害の報告は軽微です。${esc(((sc.actions || [])[0] || {}).ja || '')} 冠水した道路は車でも通らず、停電に備えて端末を充電してください。` };
    else if (!d) act = { cls: '', icon: 'info', ja: 'この地区のシナリオ値はありません。' };
    else if (sc.type === 'flood') {
      const depth = d.depth || 0; const high = st.home === 'highrise' && st.floor >= 4;
      const wm = cx.floodBest ? walkMin(cx.floodBest.len, cx.speed) : null;
      if (depth >= 0.3 && !high && (wm == null || wm > 60)) act = { cls: 'crit', icon: 'alert', ja: `地区の浸水深が ${depth} m。徒歩圏に到達できる避難先がなく${wm != null ? `（最寄り ${pname(cx.floodBest)} まで徒歩 ${wm} 分）` : ''}、水中を歩く水平避難は危険です。建物の上階か近隣の高い建物へ退避し、${esc(site.label)} 拠点と自治体の救助・ボートに連絡。飲料水と携帯の電源を確保してください。` };
      else if (depth >= 0.3 && !high) act = { cls: 'crit', icon: 'route', ja: `地区の浸水深が ${depth} m。${st.home === 'house' ? '一戸建て' : '低層階'}のため、${cx.floodBest ? `${pname(cx.floodBest)}（徒歩 ${walkMin(cx.floodBest.len, cx.speed)} 分）` : '近くの高層施設'} へ今すぐ移動してください。水が引く見込みは ${esc(fmtHours(d.recede_h || 0))} 頃。` };
      else if (depth >= 0.3) act = { cls: 'warn', icon: 'home', ja: `地区は浸水中（${depth} m）ですが ${st.floor} 階は浸水しません。自宅待機（垂直避難）を続け、エレベーター停止・断水に備えて備蓄 ${cx.plan.days} 日分を確認。電気 ${fmtPct(util('power'))}・水道 ${fmtPct(util('water'))} の復旧状況を目安に、長期化なら ${cx.floodBest ? pname(cx.floodBest) : '高層施設'} へ。` };
      else if (d.onset_h != null && t < d.onset_h) act = { cls: 'warn', icon: 'clock', ja: `この地区は約 ${fmt(d.onset_h - t)} 時間後に浸水が始まる見込み。${high ? '食料・水・現金を今日中に補充し、エレベーター停止に備えてください' : '車を高所へ移し、避難先への移動準備をしてください'}。` };
      else if (d.I > 0.05) act = { cls: '', icon: 'info', ja: `地区の浸水は軽微（${depth} m）。周辺道路の冠水と停電に注意し、外出は最小限に。` };
      else act = { cls: 'ok', icon: 'check', ja: 'この地区は現時点で浸水していません。物流の乱れに備え、備蓄を確認してください。' };
    } else {
      if (t < 72) act = { cls: 'crit', icon: 'quake', ja: `余震が続いています。建物の安全点検が済むまで ${cx.quakeBest ? `${pname(cx.quakeBest)}（徒歩 ${walkMin(cx.quakeBest.len, cx.speed)} 分）` : '近くの広場'} で待機。エレベーターは使わず、ガスの元栓を閉めてください。` };
      else act = { cls: 'warn', icon: 'home', ja: `建物の点検結果を確認してから帰宅。電気 ${fmtPct(util('power'))}・水道 ${fmtPct(util('water'))} の復旧状況を見て、飲料水を確保してください。` };
    }
    box.innerHTML = `<div class="sec-h"><span class="no">05</span><h2>リアルタイムレポーティング：${esc(d ? d.name_ja.split('（')[0] : site.short_ja)} の状況</h2><span class="r"><span class="tag ${watch ? 'warn' : 'crit'}">${watch ? '警報 警戒中' : '災害 発生中'}</span><button class="btn sm primary" id="meSafe">${ic('check')}安否を報告（デモ）</button></span><p>住所（代表地点）が属する地区の、ライフライン・天候・連絡先・医療の状況。時刻はリアルタイムレポーティング画面と共通です。</p></div>
      ${liveHead(sc, t, { compact: true, idp: 'me' })}
      <div class="note ${act.cls}">${ic(act.icon)}<span><b>あなたへの行動指示：</b>${act.ja}</span></div>
      <div class="status-grid">${parts.util}</div>
      <div class="grid c2">${parts.weather}${parts.contacts}</div>
      ${parts.hospitals ? `<div class="grid c2">${parts.hospitals}${parts.health}</div>` : parts.health}
      ${parts.mapHtml}`;
    parts.mountMap(box);
    evBox.innerHTML = `<div class="sec-h"><span class="no">06</span><h2>支援イベント</h2><span class="r"><span class="tag neutral">${parts.upcoming.length} 件</span></span><p>自宅地区で予定・実施中の給水・炊き出し・医療巡回・領事サービス。地図上の橙色のピンが場所です。</p></div>${parts.events}`;
    $('#meSafe', root).onclick = () => toast('安否報告を送信しました（デモ）：拠点の安否確認システムに「無事・自宅待機」と記録されます');
    const rng = $('#meRange', root); rng.oninput = (e) => { Live.setT(+e.target.value, sc); const tm = scenTime(sc, Live.t(sc)); $('#meClock', root).innerHTML = `${esc(tm.time)}<small>${esc(tm.date)}（${esc(tm.dow)}）現地時刻 · ${esc(fmtHours(Live.t(sc)))}</small>`; $('.lb-t', box).textContent = fmtHours(Live.t(sc)); };
    rng.onchange = () => self.renderLive(root);
    if (window.updateScales) setTimeout(window.updateScales, 20);
  },
};
