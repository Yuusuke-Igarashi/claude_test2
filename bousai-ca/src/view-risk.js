/* View 1: risk by region and site (tree: country/city → site → target group) */
const GROUPS_CORP = [
  { key: 'staff', ja: 'Local staff and families', short: 'Staff & families', icon: 'users' },
  { key: 'supply', ja: 'Customers and suppliers (supply chain)', short: 'Supply chain', icon: 'truck' },
];
const GROUPS_GOV = [
  { key: 'residents', ja: 'Residents', short: 'Residents', icon: 'home' },
  { key: 'ngo', ja: 'Responders and NGOs', short: 'Responders & NGOs', icon: 'handshake' },
];
const groupsFor = () => Ctx.isGov() ? GROUPS_GOV : GROUPS_CORP;
const regionOverall = (reg) => { const ks = ['flood', 'urban_flood', 'quake', 'landslide', 'heat', 'cold', 'water', 'haze']; let m = 0; ks.forEach((k) => { m = Math.max(m, lvInfo(hazardLevel(reg, k).level).k); }); return m; };
const lvDot = (k) => `<i class="lvdot" style="background:var(--${['h0', 'h1', 'h2', 'h3', 'h5'][k] || 'h0'})"></i>`;

App.views.risk = {
  st: { node: Store.get('riskNode', { type: 'region', region: 'kz-alm' }) },
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">01 · Risk by region, site and group</span><span class="aud">${ic('users')}Audience: risk managers and staff</span></div>
          <h1>Drill down from regional risk to <em>sites and people</em></h1>
          <p class="q"><b>Question:</b> which hazards can hit which country or city, how often and at what scale? What should each site prepare, and how? Where, and how much, are the people and partners connected to each site exposed?</p>
        </div>
        <div class="vh-r"><span class="tag asm">Assumed values are labelled</span><span class="tag src">Sourced values are linked</span></div>
      </div>
      <div class="tree-m" id="treeM"></div>
      <div class="tree-wrap">
        <nav class="tree" id="riskTree" aria-label="Region, site and group"></nav>
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
    const regionNode = (r) => `<li><button class="node d1" data-node='${JSON.stringify({ type: 'region', region: r.id })}' aria-current="${n.type === 'region' && n.region === r.id}">${lvDot(regionOverall(r))}<span>${esc(COUNTRY_JA[r.country] || r.country)} · ${esc(r.name_ja)}</span><span class="cnt">${sites.filter((s) => s.region === r.id).length ? sites.filter((s) => s.region === r.id).length + (sites.filter((s) => s.region === r.id).length === 1 ? ' site' : ' sites') : ''}</span></button>
      ${sites.filter((s) => s.region === r.id).map((s) => `<ul><li><button class="node d2" data-node='${JSON.stringify({ type: 'site', region: r.id, site: s.id })}' aria-current="${n.type === 'site' && n.site === s.id}">${ic('building')}<span>${esc(s.label)} ${esc(s.short_ja)}</span><span class="cnt">${siteScore(s).total}</span></button>
        ${(n.site === s.id) ? `<ul>${groups.map((g) => `<li><button class="node d3" data-node='${JSON.stringify({ type: 'group', region: r.id, site: s.id, group: g.key })}' aria-current="${n.type === 'group' && n.site === s.id && n.group === g.key}">${ic(g.icon)}<span>${esc(g.short)}</span></button></li>`).join('')}</ul>` : ''}</li></ul>`).join('')}</li>`;
    $('#riskTree', root).innerHTML = `<div class="th">${Ctx.isGov() ? 'Government' : 'Company'} · Region → Site → Group</div><ul>${withSites.map(regionNode).join('')}</ul><div class="grp-t">${ic('globe')}Regions without sites</div><ul>${others.map(regionNode).join('')}</ul>`;
    /* Mobile: select boxes */
    const grpOpts = (n.site ? groups : []);
    $('#treeM', root).innerHTML = `<div class="f"><label for="tmReg">Region</label><select id="tmReg">${regions.map((r) => `<option value="${r.id}"${r.id === n.region ? ' selected' : ''}>${esc(COUNTRY_JA[r.country] || r.country)} · ${esc(r.name_ja)}</option>`).join('')}</select></div>
      <div class="f"><label for="tmSite">Site</label><select id="tmSite"><option value="">(whole region)</option>${sites.filter((s) => s.region === n.region).map((s) => `<option value="${s.id}"${s.id === n.site ? ' selected' : ''}>${esc(s.label)} ${esc(s.short_ja)}</option>`).join('')}</select></div>
      <div class="f"><label for="tmGrp">Group</label><select id="tmGrp" ${n.site ? '' : 'disabled'}><option value="">(whole site)</option>${grpOpts.map((g) => `<option value="${g.key}"${g.key === n.group ? ' selected' : ''}>${esc(g.short)}</option>`).join('')}</select></div>`;
    $('#tmReg', root).onchange = (e) => self.go({ type: 'region', region: e.target.value }, root);
    $('#tmSite', root).onchange = (e) => self.go(e.target.value ? { type: 'site', region: n.region, site: e.target.value } : { type: 'region', region: n.region }, root);
    $('#tmGrp', root).onchange = (e) => self.go(e.target.value ? { type: 'group', region: n.region, site: n.site, group: e.target.value } : { type: 'site', region: n.region, site: n.site }, root);
    /* Breadcrumb */
    const crumb = `<div class="crumb"><a href="#risk" data-node='${JSON.stringify({ type: 'region', region: reg.id })}'>${esc(COUNTRY_JA[reg.country] || reg.country)} · ${esc(reg.name_ja)}</a>${site ? `${ic('chev')}<a href="#risk" data-node='${JSON.stringify({ type: 'site', region: reg.id, site: site.id })}'>${esc(site.label)} ${esc(site.short_ja)}</a>` : ''}${n.type === 'group' ? `${ic('chev')}<b>${esc((groups.find((g) => g.key === n.group) || {}).ja || n.group)}</b>` : ''}</div>`;
    const content = $('#riskContent', root); content.innerHTML = crumb + '<div class="subview" id="subview"></div>';
    const sub = $('#subview', content);
    if (n.type === 'region') {
      Store.set('region', reg.id); App.views.region.st.region = reg.id; App.views.region.init(sub);
      /* Sites in this region */
      const rs = sites.filter((s) => s.region === reg.id);
      sub.insertAdjacentHTML('beforeend', `<section class="sec"><div class="sec-h"><span class="no">06</span><h2>Sites in this region</h2><p>Select a site to see its evacuation plan and preparedness assessment, then the risk to the ${Ctx.isGov() ? 'residents and responders' : 'people and partners'} connected to it.</p></div>${rs.length ? `<div class="group-strip">${rs.map((s) => { const sc = siteScore(s); return `<button class="gcard" data-node='${JSON.stringify({ type: 'site', region: reg.id, site: s.id })}'>${ic('building')}<div><b>${esc(s.label)} ${esc(s.name_ja)}</b><span>${esc(s.type_ja)} · ${fmt(s.staff)} staff</span><span class="num">Preparedness score ${sc.total}</span></div></button>`; }).join('')}</div>` : `<div class="note">${ic('info')}<span>No sites are registered in this region. Add a site to use the evacuation plan and preparedness assessment.</span></div>`}</section>`);
    } else if (n.type === 'site') {
      Store.set('site', site.id); App.views.site.st.site = site.id; App.views.site.st.custom = null; App.views.site.st.dest = null; App.views.site.init(sub);
      /* Links to the groups below */
      const gs = groups.map((g) => { const info = groupSummary(g.key, site, reg); return `<button class="gcard" data-node='${JSON.stringify({ type: 'group', region: reg.id, site: site.id, group: g.key })}'>${ic(g.icon)}<div><b>${esc(g.ja)}</b><span>${esc(info.sub)}</span><span class="num">${esc(info.num)}</span></div></button>`; }).join('');
      sub.insertAdjacentHTML('beforeend', `<section class="sec"><div class="sec-h"><span class="no">06</span><h2>Risk to the people and organizations connected to this site</h2><p>${Ctx.isGov() ? 'Check the exposure of the residents the government must protect, and the capacity of the responders and NGOs it works with.' : 'Check where staff and their families, suppliers and logistics are exposed, and to which hazards.'}</p></div><div class="group-strip">${gs}</div></section>`);
    } else {
      renderGroup(sub, n.group, site, reg);
    }
    if (window.updateScales) setTimeout(window.updateScales, 30);
  },
};
