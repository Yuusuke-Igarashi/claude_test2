/* Boot */
(function boot() {
  Theme.apply(Theme.get());
  const themeUI = () => { const v = Theme.get(); const b = $('#themeBtn'); b.innerHTML = ic(v === 'dark' ? 'moon' : v === 'light' ? 'sun' : 'half'); b.setAttribute('aria-label', `Theme: ${v === 'dark' ? 'dark (next: light)' : v === 'light' ? 'light (next: system)' : 'system (next: dark)'}`); b.title = b.getAttribute('aria-label'); };
  themeUI(); document.addEventListener('themechange', themeUI);
  $('#themeBtn').onclick = () => Theme.cycle();
  /* Viewing context: organization type (company / government) and viewer (manager / staff) */
  document.documentElement.dataset.org = Ctx.org; document.documentElement.dataset.persona = Ctx.persona;
  const syncSeg = () => { $$('#orgSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.org === Ctx.org)); $$('#personaSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.persona === Ctx.persona)); };
  syncSeg();
  $('#orgSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.org === Ctx.org) return; Ctx.set('org', b.dataset.org); syncSeg(); toast(b.dataset.org === 'gov' ? 'Government view: target groups are "Residents" and "Responders and NGOs"' : 'Company view: target groups are "Local staff and families" and "Customers and suppliers (supply chain)"'); };
  $('#personaSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.persona === Ctx.persona) return; Ctx.set('persona', b.dataset.persona); syncSeg(); toast(b.dataset.persona === 'staff' ? 'Staff view: crisis-team panels (requests, supplies, recommended actions) are hidden' : 'Manager view: all panels are shown'); };
  /* Scale SVG (map/chart) text and markers inversely to the display zoom: --ms = displayed width / viewBox width */
  const updateScales = () => { $$('.map-box>svg, .chart svg').forEach((svg) => { const vb = svg.viewBox && svg.viewBox.baseVal; if (!vb || !vb.width) return; const w = svg.clientWidth || svg.getBoundingClientRect().width; if (w) svg.parentElement.style.setProperty('--ms', (w / vb.width).toFixed(3)); }); };
  let scT; const scheduleScales = () => { clearTimeout(scT); scT = setTimeout(updateScales, 40); };
  window.addEventListener('resize', scheduleScales);
  new MutationObserver(scheduleScales).observe($('#main'), { childList: true, subtree: true });
  window.updateScales = updateScales;
  /* Mobile nav */
  const navM = $('#navM');
  navM.innerHTML = $$('#nav a').map((a) => `<a href="${a.getAttribute('href')}" data-view="${a.dataset.view}" class="${a.classList.contains('live') ? 'live' : ''}"><span class="n">${a.querySelector('.n').textContent}</span>${a.textContent.replace(/^\d/, '').trim()}</a>`).join('');
  window.addEventListener('hashchange', route);
  /* From other views: jump to a tree node in view 1 (data-node) or to a specific event in view 2 (data-golive); toggle the map legend */
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-node]'); if (n && !n.closest('#v-risk')) { e.preventDefault(); const node = JSON.parse(n.dataset.node); App.views.risk.st.node = node; Store.set('riskNode', node); if (node.region) Store.set('region', node.region); if (node.site) Store.set('site', node.site); if (App.current === 'risk') App.views.risk.update($('#v-risk')); else location.hash = 'risk'; window.scrollTo({ top: 0 }); return; }
    const g = e.target.closest('[data-golive]'); if (g) { e.preventDefault(); Live.st.scen = g.dataset.golive; Store.set('liveScen', Live.st.scen); if (App.current === 'live') App.views.live.update($('#v-live')); else location.hash = 'live'; return; }
    const t = e.target.closest('.map-box .legend .t'); if (t) t.parentElement.classList.toggle('open');
  });
  route();
  /* First-run hint */
  if (!Store.get('seen2')) { Store.set('seen2', 1); setTimeout(() => toast('All values are demo data. Use the switches at the top right to change Company/Government and Manager/Staff views'), 600); }
})();
