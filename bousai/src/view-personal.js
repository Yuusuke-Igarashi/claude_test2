/* 画面3：個人版 家族の備え */
App.views.personal = {
  st: Object.assign({ site: Store.get('site', 'bkk-hq'), homeIdx: 0, home: 'highrise', floor: 18, members: [{ sex: 'm', age: 42, cond: false }, { sex: 'f', age: 39, cond: false }, { sex: 'f', age: 7, cond: false }, { sex: 'm', age: 1, cond: false }], pets: false, car: true, lang: false, days: 7, scen: 'flood' }, Store.get('personal', {})),
  init(root) {
    const st = this.st; const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">03 · Family readiness</span><span class="aud">${ic('home')}想定読者：駐在員とその家族</span></div>
          <h1>わが家の避難先と、<em>日頃の備え</em>を決める</h1>
          <p class="q"><b>問い：</b>家族構成と住まいの条件から、災害の種類ごとに「どこへ・どう逃げるか」と「何を・どれだけ備えるか」。</p>
        </div>
        <div class="vh-r"><span class="tag neutral">入力はこの端末にのみ保存</span></div>
      </div>
      <div class="answer" id="psAnswer"></div>
      <div class="grid side personal">
        <div class="card" id="psForm"></div>
        <div style="display:flex;flex-direction:column;gap:14px" id="psOut"></div>
      </div>
      <section class="sec" id="psStock"></section>
      <section class="sec" id="psTodo"></section>
      <section class="sec" id="psCard"></section>`;
    this.form(root); this.update(root);
  },
  form(root) {
    const st = this.st; const self = this; const site = M.site(st.site); const area = M.area(site.area);
    const homes = (area && area.homes) || [];
    $('#psForm', root).innerHTML = `<div class="card-h"><h2>家族と住まい</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="fld"><label for="psSite">勤務先の拠点（居住都市）</label><select id="psSite">${M.sites().map((s) => `<option value="${s.id}">${esc(s.name_ja)}</option>`).join('')}</select></div>
        <div class="fld"><label for="psHome">居住エリア</label><select id="psHome">${homes.map((h, i) => `<option value="${i}">${esc(h.name_ja)}</option>`).join('') || '<option value="0">（代表地点）</option>'}</select></div>
        <div class="two"><div class="fld"><label for="psType">住居タイプ</label><select id="psType"><option value="highrise">高層コンドミニアム</option><option value="lowrise">低層アパート（〜4階）</option><option value="house">一戸建て</option></select></div><div class="fld"><label for="psFloor">居住階</label><input type="number" id="psFloor" min="1" max="80" value="${st.floor}"></div></div>
        <div class="fld"><label>家族（本人を含む）</label><div class="members" id="psMembers"></div><button class="btn sm" id="psAdd" style="align-self:flex-start;margin-top:4px">${ic('users')}家族を追加</button></div>
        <div class="pills"><button class="pill" id="psPets" aria-pressed="${st.pets}">${ic('heart')}ペットあり</button><button class="pill" id="psCar" aria-pressed="${st.car}">${ic('car')}自家用車あり</button><button class="pill" id="psLang" aria-pressed="${st.lang}">${ic('globe')}現地語で会話できる</button></div>
        <div class="fld"><label for="psDays">備蓄日数（内閣府：最低 3 日、推奨 1 週間）</label><div class="seg" id="psDays"><button data-days="3" aria-pressed="${st.days === 3}">3日</button><button data-days="7" aria-pressed="${st.days === 7}">7日</button><button data-days="14" aria-pressed="${st.days === 14}">14日（物流途絶を想定）</button></div></div>
      </div>`;
    $('#psSite', root).value = st.site; $('#psHome', root).value = st.homeIdx; $('#psType', root).value = st.home;
    const renderMembers = () => { $('#psMembers', root).innerHTML = st.members.map((m, i) => `<div class="member"><select data-m="${i}" data-k="sex" aria-label="性別"><option value="m"${m.sex === 'm' ? ' selected' : ''}>男性</option><option value="f"${m.sex === 'f' ? ' selected' : ''}>女性</option><option value="x"${m.sex === 'x' ? ' selected' : ''}>その他</option></select><input type="number" min="0" max="110" value="${m.age}" data-m="${i}" data-k="age" aria-label="年齢" placeholder="年齢"><label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" data-m="${i}" data-k="cond"${m.cond ? ' checked' : ''}>持病・要配慮</label><button class="icon-btn del" data-del="${i}" aria-label="削除">${ic('x')}</button></div>`).join(''); };
    renderMembers();
    const save = () => { Store.set('personal', st); self.update(root); };
    $('#psSite', root).onchange = (e) => { st.site = e.target.value; st.homeIdx = 0; Store.set('site', st.site); self.form(root); self.update(root); };
    $('#psHome', root).onchange = (e) => { st.homeIdx = +e.target.value; const h = homes[st.homeIdx]; if (h && h.type) { st.home = h.type; $('#psType', root).value = h.type; if (h.floor) { st.floor = h.floor; $('#psFloor', root).value = h.floor; } } save(); };
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
  show(root) { const s = Store.get('site', this.st.site); if (s !== this.st.site) { this.st.site = s; this.st.homeIdx = 0; this.form(root); this.update(root); } },
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
    const me = { x: hxy[0], y: hxy[1], label: home ? home.name_ja : '自宅' };
    const cons = plan.cons.find((x) => x.k === 'walk'); const speed = cons ? cons.speed : 4;
    let cands = [], best = null, within = null;
    if (A) { const from = nearestNode(A, me.x, me.y); cands = shelterCandidates(A, area, st.scen, from, speed); within = cands.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)); best = within || cands.find((x) => x.reach); }
    const outOfCond = best && !within && cons;
    /* 自宅地点の想定浸水深（概略図のゾーンから） */
    const homeDepth = A ? { flood: zoneDepthAt(A, 'flood', hxy[0], hxy[1]), urban: zoneDepthAt(A, 'urban_flood', hxy[0], hxy[1]) } : { flood: 0, urban: 0 };
    const vertical = st.scen === 'flood' && st.home === 'highrise' && st.floor >= 4;
    const floodBest = (() => { if (!A) return null; const from = nearestNode(A, me.x, me.y); const cs = shelterCandidates(A, area, 'flood', from, speed); return cs.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)) || cs.find((x) => x.reach); })();
    const quakeBest = (() => { if (!A) return null; const from = nearestNode(A, me.x, me.y); const cs = shelterCandidates(A, area, 'quake', from, speed); return cs.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)) || cs.find((x) => x.reach); })();
    const vert = st.home === 'highrise' && st.floor >= 4;
    $('#psAnswer', root).innerHTML = `<span class="k">答え</span><ul>
      <li><b>洪水のとき：</b>${vert ? `自宅 ${st.floor} 階に留まる垂直避難が第一候補。長期化なら ${floodBest ? esc(floodBest.poi.name_ja || floodBest.poi.name) + `（徒歩 ${walkMin(floodBest.len, speed)} 分）` : '徒歩圏の高層施設'} へ。` : floodBest ? `${esc(floodBest.poi.name_ja || floodBest.poi.name)} へ早めに移動（徒歩 ${walkMin(floodBest.len, speed)} 分）。` : '徒歩圏の高層施設を確認。'}<b>地震のとき：</b>${quakeBest ? `揺れが収まったら ${esc(quakeBest.poi.name_ja || quakeBest.poi.name)} へ（徒歩 ${walkMin(quakeBest.len, speed)} 分）。` : '近くの広場へ。'}</li>
      <li><b>備蓄：</b>${plan.n} 人 × ${plan.days} 日で飲料水 ${plan.water} L・食料 ${plan.meals} 食${plan.infants ? '・粉ミルク／おむつ' : ''}${plan.elders ? '・高齢者用品' : ''}${plan.needs ? '・持病の薬 ' + Math.max(7, plan.days) + ' 日分' : ''}（内閣府の目安 3L/人/日）。</li>
      <li><b>日頃の登録：</b>在留届・たびレジ、家族の集合場所 3 段階と域外連絡先、緊急連絡先カード（下の行動チェック）。</li></ul>`;
    const condNotes = plan.cons.filter((x) => x.k !== 'walk');
    $('#psOut', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>住まいのリスク（${esc(reg.name_ja)}）</h2><span class="r">${srcTag('ThinkHazard', reg.th_url)}</span></div>${risks.length ? `<div style="display:flex;flex-direction:column;gap:8px">${risks.map((r) => `<div class="note ${r.lv >= 4 ? 'warn' : ''}">${ic(HAZ[r.k].icon)}<span><b>${esc(HAZ[r.k].short)}（${lvInfo(['unknown', 'Very low', 'Low', 'Medium', 'High'][r.lv]).ja}）：</b>${esc(r.ja)}</span></div>`).join('')}</div>` : '<div class="empty">この地域の主要ハザードは低水準です</div>'}
        <div class="note" style="margin-top:8px">${ic('pin')}<span><b>自宅地点（${esc(home ? home.name_ja : '代表地点')}）の想定浸水深：</b>河川洪水 ${homeDepth.flood > 0 ? homeDepth.flood + ' m' : '想定域外'}、都市型浸水 ${homeDepth.urban > 0 ? homeDepth.urban + ' m' : '想定域外'} ${asmTag('概略図の仮定')}。住居：${esc({ highrise: '高層コンド', lowrise: '低層アパート', house: '一戸建て' }[st.home] || st.home)} ${st.floor} 階。${homeDepth.flood >= 0.5 && st.home !== 'highrise' ? '<b>浸水想定域内の低層住居のため、垂直避難は提示しません。</b>' : ''}</span></div></div>
      <div class="card flush"><div style="padding:12px 16px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="font-size:15px;margin:0;font-weight:600">避難先と避難路</h2><div class="seg" id="psScen">${scenKeys.map((k) => `<button data-scen="${k}" aria-pressed="${k === st.scen}">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</button>`).join('')}</div><span class="tag neutral">${esc(cons ? cons.ja : '')}</span></div>
        ${condNotes.length ? `<div style="padding:8px 16px 0;display:flex;flex-direction:column;gap:6px">${condNotes.map((x) => `<div class="note" style="padding:6px 10px">${ic(x.k === 'car' ? 'car' : 'home')}<span>${esc(x.ja)}</span></div>`).join('')}</div>` : ''}
        <div style="padding:10px 16px 12px">${vertical ? `<div class="note ok">${ic('home')}<span><b>第一候補は自宅に留まる「垂直避難」です。</b>${st.floor} 階は浸水しませんが、停電・断水・エレベーター停止が ${plan.days} 日以上続く前提で備蓄します。水や物流が長期に途絶する見込みなら、下の水平避難先へ早めに移動します。</span></div>` : best ? `<div class="note ${outOfCond ? 'warn' : 'ok'}">${ic('route')}<span><b>推奨避難先：${esc(best.poi.name_ja || best.poi.name)}</b>（${fmt(best.len)} m・徒歩 ${walkMin(best.len, speed)} 分）。${esc(best.poi.why_ja || '')}${outOfCond ? `<br><b>条件（${esc(cons.ja)}）内に候補がなく、最寄りを表示しています。</b>移動手段（車・送迎）の確保が必要です。` : ''}</span></div>` : `<div class="note warn">${ic('alert')}<span>条件に合う避難先が見つかりません。徒歩圏の高層建物を個別に確認してください。</span></div>`}</div>
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
        <dt>洪水のとき</dt><dd>${vert ? `自宅 ${st.floor} 階に留まる（垂直避難）。長期化なら ${floodBest ? esc(floodBest.poi.name_ja || floodBest.poi.name) + `（徒歩 ${walkMin(floodBest.len, speed)} 分）` : '高層施設'} へ` : floodBest ? `${esc(floodBest.poi.name_ja || floodBest.poi.name)}（徒歩 ${walkMin(floodBest.len, speed)} 分）へ早めに移動` : '徒歩圏の高層建物へ'}</dd>
        <dt>地震のとき</dt><dd>揺れが収まったら非常階段で外へ。${quakeBest ? `${esc(quakeBest.poi.name_ja || quakeBest.poi.name)}（徒歩 ${walkMin(quakeBest.len, speed)} 分）に集合` : '開けた場所（公園・広場）に集合'}。余震に注意</dd>
        <dt>集合場所</dt><dd>① 自宅前 → ② ${quakeBest ? esc(quakeBest.poi.name_ja || quakeBest.poi.name) : '近くの広場'}（洪水時は ${floodBest ? esc(floodBest.poi.name_ja || floodBest.poi.name) : '高層施設'}） → ③ ${esc(site.label)} 拠点（${esc(site.short_ja)}）</dd>
        <dt>緊急電話</dt><dd class="num">${(c.emergency_numbers || []).slice(0, 3).map((n) => `${esc(n.service_ja)} ${esc(n.number)}`).join(' / ') || '—'} <span class="tag warn" style="font-family:var(--f-body)">要確認</span></dd>
        <dt>在外公館</dt><dd>${emb ? `${esc(emb.name_ja)} ${esc(emb.phone || '')}` : '—'} <span class="tag warn">要確認</span></dd>
        <dt>域外連絡先</dt><dd>（日本の親族の氏名・電話番号を記入）</dd></dl>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="psCopy">${ic('doc')}テキストをコピー</button><span class="muted" style="font-size:11.5px;align-self:center">作成 ${new Date().toLocaleDateString('ja-JP')}・デモ。電話番号は第三者データからの転記で、在外公館の公式サイトで確認してから印刷してください</span></div></div>`;
    $('#psCopy', root).onclick = (e) => { const txt = $('.fam-card dl', root).innerText; copyText(txt, $('.fam-card dl', root)); };
  },
};
