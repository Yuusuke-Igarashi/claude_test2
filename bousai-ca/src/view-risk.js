/* 画面1：地域・拠点のリスク（国・都市 → 拠点 → 対象グループ のツリー） */
const GROUPS_CORP = [
  { key: 'staff', ja: '現地雇用者・家族のリスク', short: '現地雇用者・家族', icon: 'users' },
  { key: 'supply', ja: 'お客様・取引先（サプライチェーン）のリスク', short: '取引先・サプライチェーン', icon: 'truck' },
];
const GROUPS_GOV = [
  { key: 'residents', ja: '地域住民のリスク', short: '地域住民', icon: 'home' },
  { key: 'ngo', ja: '支援者・NGO のリスク', short: '支援者・NGO', icon: 'handshake' },
];
const groupsFor = () => Ctx.isGov() ? GROUPS_GOV : GROUPS_CORP;
const regionOverall = (reg) => { const ks = ['flood', 'urban_flood', 'quake', 'cyclone', 'coastal', 'tsunami', 'volcano', 'landslide']; let m = 0; ks.forEach((k) => { m = Math.max(m, lvInfo(hazardLevel(reg, k).level).k); }); return m; };
const lvDot = (k) => `<i class="lvdot" style="background:var(--${['h0', 'h1', 'h2', 'h3', 'h5'][k] || 'h0'})"></i>`;

App.views.risk = {
  st: { node: Store.get('riskNode', { type: 'region', region: 'th-bkk' }) },
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">01 · Risk by region, site and group</span><span class="aud">${ic('users')}想定読者：リスク管理責任者（管理者）と従業員</span></div>
          <h1>地域のリスクを、<em>拠点と人</em>まで掘り下げる</h1>
          <p class="q"><b>問い：</b>どの国・都市に、どの災害が、どの頻度・規模で起こりうるか。各拠点は何をどう備えるべきか。拠点に連なる人と取引先は、どこで・どれだけ曝露しているか。</p>
        </div>
        <div class="vh-r"><span class="tag asm">仮定値はラベルで区別</span><span class="tag src">出典付きの値はリンク</span></div>
      </div>
      <div class="tree-m" id="treeM"></div>
      <div class="tree-wrap">
        <nav class="tree" id="riskTree" aria-label="地域・拠点・グループ"></nav>
        <div class="stack" id="riskContent"></div>
      </div>`;
    root.addEventListener('click', (e) => { const n = e.target.closest('[data-node]'); if (!n) return; e.preventDefault(); self.go(JSON.parse(n.dataset.node), root); });
    document.addEventListener('ctxchange', () => { if (App.current === 'risk') self.update(root); });
    this.update(root);
  },
  show(root) { this.update(root); },
  go(node, root) { this.st.node = node; Store.set('riskNode', node); if (node.region) Store.set('region', node.region); if (node.site) Store.set('site', node.site); this.update(root); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  nodeData() { const n = this.st.node; const reg = M.region(n.region); const site = n.site ? M.site(n.site) : null; return { n, reg, site }; },
  update(root) {
    const { n, reg, site } = this.nodeData(); const self = this;
    const regions = M.regions(); const sites = M.sites();
    const withSites = regions.filter((r) => sites.some((s) => s.region === r.id)); const others = regions.filter((r) => !sites.some((s) => s.region === r.id));
    const groups = groupsFor();
    const regionNode = (r) => `<li><button class="node d1" data-node='${JSON.stringify({ type: 'region', region: r.id })}' aria-current="${n.type === 'region' && n.region === r.id}">${lvDot(regionOverall(r))}<span>${esc(COUNTRY_JA[r.country] || r.country)}・${esc(r.name_ja)}</span><span class="cnt">${sites.filter((s) => s.region === r.id).length ? sites.filter((s) => s.region === r.id).length + ' 拠点' : ''}</span></button>
      ${sites.filter((s) => s.region === r.id).map((s) => `<ul><li><button class="node d2" data-node='${JSON.stringify({ type: 'site', region: r.id, site: s.id })}' aria-current="${n.type === 'site' && n.site === s.id}">${ic('building')}<span>${esc(s.label)}　${esc(s.short_ja)}</span><span class="cnt">${siteScore(s).total}</span></button>
        ${(n.site === s.id) ? `<ul>${groups.map((g) => `<li><button class="node d3" data-node='${JSON.stringify({ type: 'group', region: r.id, site: s.id, group: g.key })}' aria-current="${n.type === 'group' && n.site === s.id && n.group === g.key}">${ic(g.icon)}<span>${esc(g.short)}</span></button></li>`).join('')}</ul>` : ''}</li></ul>`).join('')}</li>`;
    $('#riskTree', root).innerHTML = `<div class="th">${Ctx.isGov() ? '自治体' : '企業'} · 地域 → 拠点 → 対象</div><ul>${withSites.map(regionNode).join('')}</ul><div class="grp-t">${ic('globe')}拠点のない地域</div><ul>${others.map(regionNode).join('')}</ul>`;
    /* モバイル用：セレクト */
    const grpOpts = (n.site ? groups : []);
    $('#treeM', root).innerHTML = `<div class="f"><label for="tmReg">国・都市</label><select id="tmReg">${regions.map((r) => `<option value="${r.id}"${r.id === n.region ? ' selected' : ''}>${esc(COUNTRY_JA[r.country] || r.country)}・${esc(r.name_ja)}</option>`).join('')}</select></div>
      <div class="f"><label for="tmSite">拠点</label><select id="tmSite"><option value="">（地域全体）</option>${sites.filter((s) => s.region === n.region).map((s) => `<option value="${s.id}"${s.id === n.site ? ' selected' : ''}>${esc(s.label)} ${esc(s.short_ja)}</option>`).join('')}</select></div>
      <div class="f"><label for="tmGrp">対象グループ</label><select id="tmGrp" ${n.site ? '' : 'disabled'}><option value="">（拠点全体）</option>${grpOpts.map((g) => `<option value="${g.key}"${g.key === n.group ? ' selected' : ''}>${esc(g.short)}</option>`).join('')}</select></div>`;
    $('#tmReg', root).onchange = (e) => self.go({ type: 'region', region: e.target.value }, root);
    $('#tmSite', root).onchange = (e) => self.go(e.target.value ? { type: 'site', region: n.region, site: e.target.value } : { type: 'region', region: n.region }, root);
    $('#tmGrp', root).onchange = (e) => self.go(e.target.value ? { type: 'group', region: n.region, site: n.site, group: e.target.value } : { type: 'site', region: n.region, site: n.site }, root);
    /* パンくず */
    const crumb = `<div class="crumb"><a href="#risk" data-node='${JSON.stringify({ type: 'region', region: reg.id })}'>${esc(COUNTRY_JA[reg.country] || reg.country)}・${esc(reg.name_ja)}</a>${site ? `${ic('chev')}<a href="#risk" data-node='${JSON.stringify({ type: 'site', region: reg.id, site: site.id })}'>${esc(site.label)} ${esc(site.short_ja)}</a>` : ''}${n.type === 'group' ? `${ic('chev')}<b>${esc((groups.find((g) => g.key === n.group) || {}).ja || n.group)}</b>` : ''}</div>`;
    const content = $('#riskContent', root); content.innerHTML = crumb + '<div class="subview" id="subview"></div>';
    const sub = $('#subview', content);
    if (n.type === 'region') {
      Store.set('region', reg.id); App.views.region.st.region = reg.id; App.views.region.init(sub);
      /* この都市の拠点 */
      const rs = sites.filter((s) => s.region === reg.id);
      sub.insertAdjacentHTML('beforeend', `<section class="sec"><div class="sec-h"><span class="no">06</span><h2>この都市の拠点</h2><p>拠点を選ぶと、避難計画・備えの評価と、拠点に連なる${Ctx.isGov() ? '住民・支援者' : '人・取引先'}のリスクに進みます。</p></div>${rs.length ? `<div class="group-strip">${rs.map((s) => { const sc = siteScore(s); return `<button class="gcard" data-node='${JSON.stringify({ type: 'site', region: reg.id, site: s.id })}'>${ic('building')}<div><b>${esc(s.label)} ${esc(s.name_ja)}</b><span>${esc(s.type_ja)}・従業員 ${fmt(s.staff)} 名</span><span class="num">備えスコア ${sc.total}</span></div></button>`; }).join('')}</div>` : `<div class="note">${ic('info')}<span>この地域に登録された拠点はありません。拠点を追加すると、避難計画と備えの評価が使えます。</span></div>`}</section>`);
    } else if (n.type === 'site') {
      Store.set('site', site.id); App.views.site.st.site = site.id; App.views.site.st.custom = null; App.views.site.st.dest = null; App.views.site.init(sub);
      /* 下位グループへの導線 */
      const gs = groups.map((g) => { const info = groupSummary(g.key, site, reg); return `<button class="gcard" data-node='${JSON.stringify({ type: 'group', region: reg.id, site: site.id, group: g.key })}'>${ic(g.icon)}<div><b>${esc(g.ja)}</b><span>${esc(info.sub)}</span><span class="num">${esc(info.num)}</span></div></button>`; }).join('');
      sub.insertAdjacentHTML('beforeend', `<section class="sec"><div class="sec-h"><span class="no">06</span><h2>この拠点に連なる人と組織のリスク</h2><p>${Ctx.isGov() ? '自治体として守るべき住民と、連携する支援者・NGO の曝露と能力を確認します。' : '従業員とその家族、取引先・物流のどこがどの災害に曝露しているかを確認します。'}</p></div><div class="group-strip">${gs}</div></section>`);
    } else {
      renderGroup(sub, n.group, site, reg);
    }
    if (window.updateScales) setTimeout(window.updateScales, 30);
  },
};
