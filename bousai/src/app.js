/* 起動 */
(function boot() {
  Theme.apply(Theme.get());
  $('#themeBtn').onclick = () => Theme.cycle();
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
