/* 起動 */
(function boot() {
  Theme.apply(Theme.get());
  const themeUI = () => { const v = Theme.get(); const b = $('#themeBtn'); b.innerHTML = ic(v === 'dark' ? 'moon' : v === 'light' ? 'sun' : 'half'); b.setAttribute('aria-label', `表示テーマ：${v === 'dark' ? 'ダーク（次はライト）' : v === 'light' ? 'ライト（次は端末設定）' : '端末設定（次はダーク）'}`); b.title = b.getAttribute('aria-label'); };
  themeUI(); document.addEventListener('themechange', themeUI);
  $('#themeBtn').onclick = () => Theme.cycle();
  /* 閲覧コンテキスト：組織の種類（企業／自治体）と閲覧者（管理者／従業員） */
  document.documentElement.dataset.org = Ctx.org; document.documentElement.dataset.persona = Ctx.persona;
  const syncSeg = () => { $$('#orgSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.org === Ctx.org)); $$('#personaSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.persona === Ctx.persona)); };
  syncSeg();
  $('#orgSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.org === Ctx.org) return; Ctx.set('org', b.dataset.org); syncSeg(); toast(b.dataset.org === 'gov' ? '自治体向けの表示：対象グループが「地域住民」「支援者・NGO」になります' : '企業向けの表示：対象グループが「現地雇用者・家族」「取引先・サプライチェーン」になります'); };
  $('#personaSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.persona === Ctx.persona) return; Ctx.set('persona', b.dataset.persona); syncSeg(); toast(b.dataset.persona === 'staff' ? '従業員向けの表示：対策本部向けの要請・物資・推奨アクションを隠します' : '管理者向けの表示：すべてのパネルを表示します'); };
  /* SVG（地図・図表）の文字・マーカーを表示倍率に反比例させる：--ms = 表示幅 / viewBox 幅 */
  const updateScales = () => { $$('.map-box>svg, .chart svg').forEach((svg) => { const vb = svg.viewBox && svg.viewBox.baseVal; if (!vb || !vb.width) return; const w = svg.clientWidth || svg.getBoundingClientRect().width; if (w) svg.parentElement.style.setProperty('--ms', (w / vb.width).toFixed(3)); }); };
  let scT; const scheduleScales = () => { clearTimeout(scT); scT = setTimeout(updateScales, 40); };
  window.addEventListener('resize', scheduleScales);
  new MutationObserver(scheduleScales).observe($('#main'), { childList: true, subtree: true });
  window.updateScales = updateScales;
  /* モバイル用ナビ */
  const navM = $('#navM');
  navM.innerHTML = $$('#nav a').map((a) => `<a href="${a.getAttribute('href')}" data-view="${a.dataset.view}" class="${a.classList.contains('live') ? 'live' : ''}"><span class="n">${a.querySelector('.n').textContent}</span>${a.textContent.replace(/^\d/, '').trim()}</a>`).join('');
  window.addEventListener('hashchange', route);
  /* 他画面から画面 1 のツリーノードへ（data-node）、画面 2 の特定イベントへ（data-golive）、地図の凡例の開閉 */
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-node]'); if (n && !n.closest('#v-risk')) { e.preventDefault(); const node = JSON.parse(n.dataset.node); App.views.risk.st.node = node; Store.set('riskNode', node); if (node.region) Store.set('region', node.region); if (node.site) Store.set('site', node.site); if (App.current === 'risk') App.views.risk.update($('#v-risk')); else location.hash = 'risk'; window.scrollTo({ top: 0 }); return; }
    const g = e.target.closest('[data-golive]'); if (g) { e.preventDefault(); Live.st.scen = g.dataset.golive; Store.set('liveScen', Live.st.scen); if (App.current === 'live') App.views.live.update($('#v-live')); else location.hash = 'live'; return; }
    const t = e.target.closest('.map-box .legend .t'); if (t) t.parentElement.classList.toggle('open');
  });
  route();
  /* 初回ヒント */
  if (!Store.get('seen2')) { Store.set('seen2', 1); setTimeout(() => toast('すべてデモデータです。右上で「企業／自治体」「管理者／従業員」の見え方を切り替えられます'), 600); }
})();
