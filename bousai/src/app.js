/* 起動 */
(function boot() {
  Theme.apply(Theme.get());
  const themeUI = () => { const v = Theme.get(); const b = $('#themeBtn'); b.innerHTML = ic(v === 'dark' ? 'moon' : v === 'light' ? 'sun' : 'half'); b.setAttribute('aria-label', `表示テーマ：${v === 'dark' ? 'ダーク（次はライト）' : v === 'light' ? 'ライト（次は端末設定）' : '端末設定（次はダーク）'}`); b.title = b.getAttribute('aria-label'); };
  themeUI(); document.addEventListener('themechange', themeUI);
  $('#themeBtn').onclick = () => Theme.cycle();
  /* SVG（地図・図表）の文字・マーカーを表示倍率に反比例させる：--ms = 表示幅 / viewBox 幅 */
  const updateScales = () => { $$('.map-box>svg, .chart svg').forEach((svg) => { const vb = svg.viewBox && svg.viewBox.baseVal; if (!vb || !vb.width) return; const w = svg.clientWidth || svg.getBoundingClientRect().width; if (w) svg.parentElement.style.setProperty('--ms', (w / vb.width).toFixed(3)); }); };
  let scT; const scheduleScales = () => { clearTimeout(scT); scT = setTimeout(updateScales, 40); };
  window.addEventListener('resize', scheduleScales);
  new MutationObserver(scheduleScales).observe($('#main'), { childList: true, subtree: true });
  window.updateScales = updateScales;
  /* モバイル用ナビ */
  const navM = $('#navM');
  navM.innerHTML = $$('#nav a').map((a) => `<a href="${a.getAttribute('href')}" data-view="${a.dataset.view}" class="${/live/.test(a.dataset.view) ? 'live' : ''}"><span class="n">${a.querySelector('.n').textContent}</span>${a.textContent.replace(/^\d/, '').trim()}</a>`).join('');
  window.addEventListener('hashchange', route);
  /* 地図の凡例：スマホ幅では見出しをタップで開閉 */
  document.addEventListener('click', (e) => { const t = e.target.closest('.map-box .legend .t'); if (t) t.parentElement.classList.toggle('open'); });
  document.addEventListener('themechange', () => { /* 地図・図表はトークン参照のため再描画不要 */ });
  /* 通し番号付きリンクのスムーズ化 */
  route();
  /* 初回ヒント */
  if (!Store.get('seen')) { Store.set('seen', 1); setTimeout(() => toast('すべてデモデータです。出典のある値はリンク、仮定値は「仮定」ラベルで示します'), 600); }
})();
