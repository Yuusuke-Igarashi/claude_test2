/* 図表（SVG・ホバー付き）。色はトークンから、文字はテキスト色から。 */
const CAT = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

function chartTip(box) { let t = box.querySelector('.tip'); if (!t) { t = el('<div class="tip" hidden></div>'); box.appendChild(t); } return t; }
function placeTip(box, tip, cx, cy) {
  const r = box.getBoundingClientRect(); let x = cx - r.left + 12, y = cy - r.top - 10;
  if (x + tip.offsetWidth + 6 > r.width) x = Math.max(2, cx - r.left - tip.offsetWidth - 12); if (y < 2) y = 2;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1]; const raw = max / n; const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; const step = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * p; const t = []; for (let v = 0; v <= max + step * 0.999; v += step) t.push(v); return t;
}

/**
 * 再現期間曲線：x = 再現期間（対数）, y = 損失（線形）
 * series: [{name, color, points:[[rp, value]], dashed}]  yFmt: 値表示
 */
function rpChart(box, { series, yFmt = (v) => fmtUSD(v), yLabel = '損失', xLabel = '再現期間（年）', rps = [10, 50, 100, 500, 1000] }) {
  const W = 560, H = 280, ML = 70, MR = 16, MT = 18, MB = 42; const pw = W - ML - MR, ph = H - MT - MB;
  const lx = Math.log10(rps[0]) - 0.1, hx = Math.log10(rps[rps.length - 1]) + 0.1; const X = (rp) => ML + (Math.log10(rp) - lx) / (hx - lx) * pw;
  const maxV = Math.max(1e-9, ...series.flatMap((s) => s.points.map((p) => p[1]))); const ticks = niceTicks(maxV); const maxT = ticks[ticks.length - 1]; const Y = (v) => MT + ph - (v / maxT) * ph;
  let h = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}の再現期間曲線">`;
  ticks.forEach((t) => { h += `<line class="grid-l" x1="${ML}" x2="${W - MR}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${ML - 8}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yFmt(t))}</text>`; });
  rps.forEach((rp) => { h += `<text class="ax" x="${X(rp).toFixed(1)}" y="${H - MB + 16}" text-anchor="middle">${rp}</text><line class="axis-l" x1="${X(rp).toFixed(1)}" x2="${X(rp).toFixed(1)}" y1="${MT + ph}" y2="${MT + ph + 4}"/>`; });
  h += `<line class="axis-l" x1="${ML}" x2="${W - MR}" y1="${MT + ph}" y2="${MT + ph}"/><text class="ax-t" x="${ML + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(xLabel)}</text>`;
  const used = []; /* 端点ラベルの衝突回避 */
  const placeY = (y) => { let yy = y; for (let k = 0; k < 6; k++) { if (used.every((u) => Math.abs(u - yy) >= 13)) break; yy -= 13; } used.push(yy); return yy; };
  series.forEach((s, si) => {
    const col = s.color || CAT[si % CAT.length]; const pts = s.points.slice().sort((a, b) => a[0] - b[0]);
    const d = pts.map(([rp, v], i) => (i ? 'L' : 'M') + X(rp).toFixed(1) + ' ' + Y(v).toFixed(1)).join('');
    if (!s.dashed) h += `<path class="area" d="${d}L${X(pts[pts.length - 1][0]).toFixed(1)} ${MT + ph}L${X(pts[0][0]).toFixed(1)} ${MT + ph}Z" fill="${col}"/>`;
    h += `<path class="ln" d="${d}" stroke="${col}"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
    pts.forEach(([rp, v], i) => { h += `<circle class="pt" cx="${X(rp).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4.5" fill="${col}" data-s="${si}" data-i="${i}"/>`; if (i === pts.length - 1) { const ly = placeY(Y(v) - 8); h += `<text class="lbl on" x="${(X(rp) - 6).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`; } else if (i === 0 && si === 0) h += `<text class="lbl" x="${(X(rp) + 8).toFixed(1)}" y="${(Y(v) - 8).toFixed(1)}" text-anchor="start">${esc(yFmt(v))}</text>`; });
  });
  h += '</svg>';
  box.innerHTML = h; const tip = chartTip(box); const svg = box.querySelector('svg');
  svg.onmousemove = (e) => { const c = e.target.closest('circle.pt'); if (!c) { tip.hidden = true; return; } const s = series[+c.dataset.s]; const pts = s.points.slice().sort((a, b) => a[0] - b[0]); const [rp, v] = pts[+c.dataset.i]; tip.innerHTML = `<b>再現期間 ${rp} 年（年超過確率 ${(100 / rp).toFixed(rp >= 100 ? 1 : 0)}%）</b><div class="r"><i style="background:${s.color || CAT[+c.dataset.s % CAT.length]}"></i>${esc(s.name)}：${esc(yFmt(v))}</div>`; tip.hidden = false; placeTip(box, tip, e.clientX, e.clientY); };
  svg.onmouseleave = () => { tip.hidden = true; };
}

/**
 * 縦棒（カテゴリ×1系列、または積み上げ）。cats:[label], series:[{name,color,values}]
 */
function barChart(box, { cats, series, yFmt = (v) => fmt(v), yLabel = '', height = 240, stacked = false, labels = true, hl = -1 }) {
  const W = 560, H = height, ML = 56, MR = 12, MT = 16, MB = 40; const pw = W - ML - MR, ph = H - MT - MB; const n = cats.length;
  const tot = cats.map((_, i) => stacked ? sum(series, (s) => s.values[i]) : Math.max(...series.map((s) => s.values[i] || 0)));
  const ticks = niceTicks(Math.max(1e-9, ...tot)); const maxT = ticks[ticks.length - 1]; const Y = (v) => MT + ph - (v / maxT) * ph;
  const bw = pw / n; const gw = Math.min(46, bw * 0.62); const sw = stacked ? gw : gw / series.length;
  let h = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">`;
  ticks.forEach((t) => { h += `<line class="grid-l" x1="${ML}" x2="${W - MR}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${ML - 8}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yFmt(t))}</text>`; });
  cats.forEach((c, i) => {
    const cx = ML + bw * i + bw / 2; h += `<text class="ax" x="${cx.toFixed(1)}" y="${H - MB + 16}" text-anchor="middle">${esc(c)}</text>`;
    let acc = 0;
    series.forEach((s, si) => { const v = s.values[i] || 0; const col = s.color || CAT[si % CAT.length]; const x = stacked ? cx - gw / 2 : cx - gw / 2 + sw * si; const y0 = stacked ? Y(acc + v) : Y(v); const hgt = Math.max(0, (stacked ? Y(acc) : Y(0)) - y0); h += `<rect class="bar-r" x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(sw - 2).toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}" opacity="${hl >= 0 && hl !== i ? .35 : 1}" data-i="${i}" data-s="${si}"/>`; acc += v; });
    if (labels && (hl < 0 || hl === i)) h += `<text class="lbl${hl === i ? ' on' : ''}" x="${cx.toFixed(1)}" y="${(Y(tot[i]) - 5).toFixed(1)}" text-anchor="middle">${yFmt(tot[i])}</text>`;
  });
  h += `<line class="axis-l" x1="${ML}" x2="${W - MR}" y1="${MT + ph}" y2="${MT + ph}"/></svg>`;
  box.innerHTML = h; const tip = chartTip(box); const svg = box.querySelector('svg');
  svg.onmousemove = (e) => { const r = e.target.closest('rect.bar-r'); if (!r) { tip.hidden = true; return; } const i = +r.dataset.i; tip.innerHTML = `<b>${esc(cats[i])}</b>` + series.map((s, si) => `<div class="r"><i style="background:${s.color || CAT[si % CAT.length]}"></i>${esc(s.name)}：${yFmt(s.values[i] || 0)}</div>`).join(''); tip.hidden = false; placeTip(box, tip, e.clientX, e.clientY); };
  svg.onmouseleave = () => { tip.hidden = true; };
}

/**
 * 時系列（発災からの時間）。series:[{name,color,values:[[t,v]]}], now: 現在時刻 t, xFmt
 */
function lineChart(box, { series, now, yFmt = (v) => fmt(v), xFmt = (t) => fmtHours(t), height = 200, xMax = 168, yLabel = '' }) {
  const W = 560, H = height, ML = 54, MR = 12, MT = 14, MB = 34; const pw = W - ML - MR, ph = H - MT - MB;
  const maxV = Math.max(1e-9, ...series.flatMap((s) => s.values.map((p) => p[1]))); const ticks = niceTicks(maxV, 3); const maxT = ticks[ticks.length - 1];
  const X = (t) => ML + (t / xMax) * pw, Y = (v) => MT + ph - (v / maxT) * ph;
  let h = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">`;
  ticks.forEach((t) => { h += `<line class="grid-l" x1="${ML}" x2="${W - MR}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${ML - 8}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yFmt(t))}</text>`; });
  for (let d = 0; d <= xMax / 24; d++) h += `<text class="ax" x="${X(d * 24).toFixed(1)}" y="${H - MB + 16}" text-anchor="${d * 24 >= xMax ? 'end' : d === 0 ? 'start' : 'middle'}">D+${d}</text>`;
  series.forEach((s, si) => { const col = s.color || CAT[si % CAT.length]; const past = s.values.filter((p) => p[0] <= now), fut = s.values.filter((p) => p[0] >= now); const d = (arr) => arr.map(([t, v], i) => (i ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(v).toFixed(1)).join(''); if (past.length > 1) { h += `<path class="area" d="${d(past)}L${X(past[past.length - 1][0]).toFixed(1)} ${MT + ph}L${X(past[0][0]).toFixed(1)} ${MT + ph}Z" fill="${col}"/><path class="ln" d="${d(past)}" stroke="${col}"/>`; } if (fut.length > 1) h += `<path class="ln" d="${d(fut)}" stroke="${col}" stroke-dasharray="3 4" opacity=".55"/>`; const cur = s.values.reduce((b, p) => Math.abs(p[0] - now) < Math.abs(b[0] - now) ? p : b, s.values[0]); const flip = X(cur[0]) > W - 70; h += `<circle class="pt" cx="${X(cur[0]).toFixed(1)}" cy="${Y(cur[1]).toFixed(1)}" r="4.5" fill="${col}"/><text class="lbl on" x="${(X(cur[0]) + (flip ? -7 : 7)).toFixed(1)}" y="${(Y(cur[1]) - 6).toFixed(1)}" text-anchor="${flip ? 'end' : 'start'}">${yFmt(cur[1])}</text>`; });
  h += `<line class="hover-l" x1="${X(now).toFixed(1)}" x2="${X(now).toFixed(1)}" y1="${MT}" y2="${MT + ph}"/><text class="ax" x="${X(now).toFixed(1)}" y="${MT - 3}" text-anchor="middle">${esc(xFmt(now))}</text>`;
  h += `<line class="axis-l" x1="${ML}" x2="${W - MR}" y1="${MT + ph}" y2="${MT + ph}"/></svg>`;
  box.innerHTML = h; const tip = chartTip(box); const svg = box.querySelector('svg');
  svg.onmousemove = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse()); const t = clamp((q.x - ML) / pw * xMax, 0, xMax); tip.innerHTML = `<b>${esc(xFmt(t))}</b>` + series.map((s, si) => { const cur = s.values.reduce((b, p) => Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b, s.values[0]); return `<div class="r"><i style="background:${s.color || CAT[si % CAT.length]}"></i>${esc(s.name)}：${yFmt(cur[1])}</div>`; }).join(''); tip.hidden = false; placeTip(box, tip, e.clientX, e.clientY); };
  svg.onmouseleave = () => { tip.hidden = true; };
}

/* 横棒リスト（HTML） rows:[{label, value, max, color, text}] */
function miniBars(rows) {
  const max = Math.max(1e-9, ...rows.map((r) => r.max ?? r.value));
  return `<div class="mini-bars">${rows.map((r) => `<div class="row"><span>${esc(r.label)}</span><span class="track"><i style="width:${clamp(r.value / (r.max ?? max) * 100, 0, 100).toFixed(1)}%;background:${r.color || 'var(--accent)'}"></i></span><span class="v">${esc(r.text ?? fmt(r.value))}</span></div>`).join('')}</div>`;
}
