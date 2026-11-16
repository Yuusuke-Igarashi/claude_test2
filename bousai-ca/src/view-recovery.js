/* Screen 3: Recovery monitoring — after the emergency, three timelines from one scenario:
 * region (local government), company (site and supply chain) and personal (public services in your district). Day d = days since onset. */
const logi = (d, half, k) => 1 / (1 + Math.exp(-(d - half) / Math.max(0.5, k)));
const fmtD = (d) => `D+${Math.round(d)}`;
const fmtDays = (d) => { d = Math.round(d); if (d < 14) return `D+${d}`; if (d < 84) return `W+${Math.round(d / 7)}`; return `M+${Math.round(d / 30)}`; };
const PERSP = [['region', 'home', 'Region (local government)'], ['company', 'building', 'Company (site & supply chain)'], ['personal', 'users', 'Personal (public services)']];
/* Service restoration day for a district: base days × (0.4 + spread × exposure); floods add part of the recession time. */
function svcDay(sc, svc, dist) { const I = dist ? (dist.exposure || 0) : 0.5; const rec = (sc.type === 'flood' && dist) ? ((dist.recede_h || 0) / 24) * 0.5 : 0; return rec + svc.base_d * (0.4 + (svc.spread || 2) * I); }
const svcFrac = (d, day) => logi(d, day, Math.max(0.7, day / 4));
function recCtx(sc) {
  const R = sc.recovery || {}; const dists = sc.districts || []; const svcs = R.services || [];
  const g = (typeof GD === 'function' ? GD() : { supply: {} });
  const nodes = (sc.supply_sites || []).flatMap((sid) => (g.supply[sid] || []));
  const nodeDay = (n) => { const dd = n.district ? dists.find((x) => x.id === n.district) : null; const I = dd ? (dd.exposure || 0) : 0.05; const rec = (sc.type === 'flood' && dd) ? ((dd.recede_h || 0) / 24) * 0.5 : 0; return rec + ((R.company && R.company.node_base_d) || 20) * (0.3 + 2 * I); };
  const siteI = (s) => { const dd = dists.find((x) => x.id === s.district); return (dd ? (dd.exposure || 0) : 0) * (s.exposure_mult || 1); };
  const capHalf = (R.company && R.company.cap_half_d) || 30, capK = (R.company && R.company.cap_k_d) || 8;
  const siteCap = (s, d) => { const I = siteI(s); const rec = (sc.type === 'flood') ? (((dists.find((x) => x.id === s.district) || {}).recede_h || 0) / 24) * 0.5 : 0; return I < 0.05 ? 1 : logi(d, rec + capHalf * (0.3 + I), capK * (0.5 + I)); };
  const staffAt = (s, d) => { const I = siteI(s); return I < 0.05 ? 1 : logi(d, 6 + 20 * I, 3 + 4 * I); };
  const ctx = {
    R, dists, svcs, nodes,
    svcAvg: (d) => { if (!svcs.length) return 1; const ds = dists.length ? dists : [null]; let sum = 0, w = 0; ds.forEach((dd) => { const pop = dd ? (dd.pop || 1) : 1; svcs.forEach((sv) => { sum += pop * svcFrac(d, svcDay(sc, sv, dd)); w += pop; }); }); return w ? sum / w : 1; },
    svcDist: (d, dd) => svcs.map((sv) => { const day = svcDay(sc, sv, dd); return { svc: sv, day, frac: svcFrac(d, day) }; }),
    sites: (sc.sites || []).map((s) => Object.assign({}, s, { I: siteI(s) })),
    siteCap, staffAt,
    siteCapAvg: (d) => { const ss = sc.sites || []; if (!ss.length) return 1; return sum(ss, (s) => siteCap(s, d)) / ss.length; },
    staffAvg: (d) => { const ss = sc.sites || []; if (!ss.length) return 1; return sum(ss, (s) => s.staff * staffAt(s, d)) / Math.max(1, sum(ss, (s) => s.staff)); },
    nodeDay,
    supplyAvail: (d) => { if (!nodes.length) return 1; const w = sum(nodes, (n) => n.share || 0.2); return sum(nodes, (n) => (n.share || 0.2) * svcFrac(d, nodeDay(n))) / Math.max(1e-9, w); },
  };
  return ctx;
}
function indVal(ind, d, ctx) {
  const k = ind.kind || 'logistic';
  if (k === 'logistic') return (ind.start || 0) + ((ind.end != null ? ind.end : 1) - (ind.start || 0)) * logi(d, ind.half_d, ind.k_d || ind.half_d / 4);
  if (k === 'decay') { const dl = ind.delay_d || 0; return (ind.floor || 0) + (ind.peak - (ind.floor || 0)) * (d <= dl ? 1 : Math.exp(-(d - dl) / (ind.tau_d || 30))); }
  if (k === 'points') { const p = ind.points || []; if (!p.length) return 0; if (d <= p[0][0]) return p[0][1]; for (let i = 1; i < p.length; i++) { if (d <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (d - x0) / Math.max(1e-9, x1 - x0); } } return p[p.length - 1][1]; }
  if (k === 'services') return ctx.svcAvg(d);
  if (k === 'site') return ctx.siteCapAvg(d);
  if (k === 'staff') return ctx.staffAvg(d);
  if (k === 'supply') return ctx.supplyAvail(d);
  return 0;
}
const indSeries = (ind, ctx, horizon) => { const v = []; const step = Math.max(1, Math.round(horizon / 60)); for (let d = 0; d <= horizon; d += step) v.push([d, indVal(ind, d, ctx)]); if (v[v.length - 1][0] !== horizon) v.push([horizon, indVal(ind, horizon, ctx)]); return v; };
const indFmt = (ind) => (v) => ind.unit === '%' ? `${Math.round(v * 100)}%` : ind.unit === 'USD M' ? fmtUSD(v) : `${fmtC(Math.round(v))}${ind.unit ? ' ' + ind.unit : ''}`;
const xTicksFor = (h) => { const step = h > 400 ? 90 : h > 120 ? 30 : h > 40 ? 7 : 5; const t = []; for (let d = 0; d <= h; d += step) t.push([d, h > 120 ? `M+${Math.round(d / 30)}` : h > 40 ? `W+${Math.round(d / 7)}` : `D+${d}`]); return t; };
const phaseAt = (R, d) => (R.phases || []).find((p) => d >= p.from_d && d < p.to_d) || (R.phases || [])[(R.phases || []).length - 1] || { key: 'all', ja: 'Recovery' };
const kpiTileR = (x) => `<div class="kpi ${x.c || ''}"><span class="v">${x.v}<small>${esc(x.u || '')}</small></span><span class="l">${esc(x.l)}</span><span class="s">${esc(x.s || '')}</span></div>`;
function msList(ms, d, sc) { const rows = (ms || []).slice().sort((a, b) => a.d - b.d); if (!rows.length) return '<div class="empty">No milestones defined</div>'; return `<div class="timeline">${rows.map((m) => { const st = m.d <= d ? 'done' : 'future'; const near = Math.abs(m.d - d) <= Math.max(1, d * 0.05); return `<div class="tl ${st === 'future' ? 'future' : (m.cls || '')}${near ? ' now' : ''}"><span class="t">${esc(fmtD(m.d))}${fmtDays(m.d) !== fmtD(m.d) ? `<b>${esc(fmtDays(m.d))}</b>` : ''}<b>${esc(m.who || '')}</b></span><span class="m"><b>${esc(m.ja)}${near ? ' <span class="tag acc">now</span>' : ''}</b><span>${esc(m.detail || '')}${m.src ? ` · ${esc(m.src)}` : ''}</span></span></div>`; }).join('')}</div>`; }
function checklist(R, persp, phase, root, sc) { const cl = ((R.checklists || {})[persp] || {})[phase.key] || []; if (!cl.length) return '<div class="empty">No checklist for this phase</div>'; return `<div class="chk-list">${cl.map((c, i) => { const key = `rc|${sc.id}|${persp}|${phase.key}|${i}`; const done = !!(App.views.recovery.st.done[key]); return `<div class="chk" data-done="${done ? 1 : 0}"><button class="box" data-rchk="${esc(key)}" aria-label="Mark done">${ic('check')}</button><span class="t"><b>${esc(typeof c === 'string' ? c : c.ja)}</b>${c.why ? `<span>${esc(c.why)}</span>` : ''}</span></div>`; }).join('')}</div>`; }

App.views.recovery = {
  st: { scen: null, day: null, persp: Store.get('rcPersp', 'region'), dist: null, done: Store.get('rcDone', {}) },
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">03 · Recovery monitoring</span><span class="aud">${ic('users')}Audience: managers of companies and local governments, and staff</span></div>
          <h1>Track the way back: <em>from emergency to normal</em></h1>
          <p class="q"><b>Question:</b> After the live phase, how fast do the region, the company and daily life recover, what has to happen by when, and where is recovery lagging? One scenario, three timelines: local government, company (site and supply chain) and personal (public services in your district).</p>
        </div>
        <div class="vh-r"><span class="tag asm">Recovery curves are model assumptions</span><span class="tag neutral">Milestones cite real analog events where available</span></div>
      </div>
      <div class="card" id="rcCtl"></div>
      <div class="tabs" role="tablist" id="rcTabs"></div>
      <div class="tabpanel" id="rcPanel"></div>`;
    root.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-persp]'); if (tb) { self.st.persp = tb.dataset.persp; Store.set('rcPersp', self.st.persp); self.renderTabs(root); self.renderPanel(root); return; }
      const ck = e.target.closest('[data-rchk]'); if (ck) { const k = ck.dataset.rchk; self.st.done[k] = !self.st.done[k]; Store.set('rcDone', self.st.done); ck.closest('.chk').dataset.done = self.st.done[k] ? 1 : 0; return; }
      const mb = e.target.closest('[data-more]'); if (mb) { const tl = $('#' + mb.dataset.more, root); tl.classList.toggle('collapsed'); mb.textContent = tl.classList.contains('collapsed') ? 'Show more' : 'Show less'; }
    });
    document.addEventListener('ctxchange', () => { if (App.current === 'recovery') self.renderPanel(root); });
    this.update(root);
  },
  show(root) { if (typeof Live !== 'undefined' && Live.st.scen && Live.st.scen !== this.st.scen) { this.st.scen = Live.st.scen; this.st.day = null; } this.update(root); },
  scenario() { let sc = M.scenario(this.st.scen || (typeof Live !== 'undefined' ? Live.st.scen : null)); if (!sc) sc = M.scenarios()[0]; this.st.scen = sc.id; return sc; },
  update(root) { this.renderCtl(root); this.renderTabs(root); this.renderPanel(root); },
  renderCtl(root) {
    const sc = this.scenario(); const R = sc.recovery || { horizon_d: 90, phases: [] }; const H = R.horizon_d || 90; const self = this;
    if (this.st.day == null || this.st.day > H) this.st.day = Math.min(H, R.default_d != null ? R.default_d : Math.round(H / 6));
    const d = this.st.day; const ph = phaseAt(R, d); const tm = scenTime(sc, d * 24);
    $('#rcCtl', root).innerHTML = `<div class="rc-ctl">
      <div class="f"><label for="rcScen">Event</label><select id="rcScen">${M.scenarios().map((s) => `<option value="${s.id}"${s.id === sc.id ? ' selected' : ''}>${esc(s.short_ja || s.name_ja)}</option>`).join('')}</select><span class="sub">${esc(sc.country_ja || '')} · ${esc(sc.city_ja || '')} · onset ${esc(scenTime(sc, 0).full)}</span></div>
      <div class="f t"><div class="row"><span>Days since onset (slider spans ${H >= 360 ? Math.round(H / 30) + ' months' : H >= 60 ? Math.round(H / 7) + ' weeks' : H + ' days'})</span><b id="rcDayLbl">${esc(fmtD(d))} · ${esc(fmtDays(d))} · ${esc(tm.date)}</b></div><input type="range" id="rcDay" min="0" max="${H}" step="1" value="${d}" aria-label="Days since onset"><div class="phase-band">${(R.phases || []).map((p) => `<span class="${p.key === ph.key ? 'on' : ''}" style="flex:${Math.max(1, p.to_d - p.from_d)}" title="${esc(p.ja)}: ${esc(fmtD(p.from_d))} to ${esc(fmtD(p.to_d))}">${esc(p.ja)}</span>`).join('')}</div></div>
      <div class="f"><label>Phase now</label><span class="tag acc" style="align-self:flex-start">${esc(ph.ja)}</span><span class="sub">${esc(ph.desc || '')}</span></div></div>`;
    $('#rcScen', root).onchange = (e) => { self.st.scen = e.target.value; if (typeof Live !== 'undefined') { Live.st.scen = e.target.value; Store.set('liveScen', e.target.value); } self.st.day = null; self.st.dist = null; self.update(root); };
    $('#rcDay', root).oninput = (e) => { self.st.day = +e.target.value; const t2 = scenTime(sc, self.st.day * 24); $('#rcDayLbl', root).textContent = `${fmtD(self.st.day)} · ${fmtDays(self.st.day)} · ${t2.date}`; cancelAnimationFrame(self._raf); self._raf = requestAnimationFrame(() => { self.renderPanel(root); const p2 = phaseAt(R, self.st.day); $$('.phase-band span', root).forEach((el) => el.classList.toggle('on', el.title.startsWith(p2.ja + ':'))); }); };
  },
  renderTabs(root) { $('#rcTabs', root).innerHTML = PERSP.map(([k, i, l]) => `<button class="tab" role="tab" data-persp="${k}" aria-selected="${this.st.persp === k}">${ic(i)}${l}</button>`).join(''); },
  renderPanel(root) {
    const sc = this.scenario(); const R = sc.recovery; const box = $('#rcPanel', root);
    if (!R) { box.innerHTML = `<div class="note">${ic('info')}<span>No recovery timeline is defined for this event.</span></div>`; return; }
    const d = this.st.day; const H = R.horizon_d || 90; const ctx = recCtx(sc); const ph = phaseAt(R, d); const persp = this.st.persp;
    const inds = (R.indicators || {})[persp] || [];
    const kpis = inds.slice(0, 6).map((ind) => { const v = indVal(ind, d, ctx); const f = indFmt(ind); const good = ind.good === 'low' ? v <= (ind.target != null ? ind.target : 0.1) : v >= (ind.target != null ? ind.target : 0.9); return { v: f(v), u: '', l: ind.ja, c: good ? 'ok' : ind.good === 'low' ? (v > (ind.peak || 1) * 0.5 ? 'crit' : 'warn') : (v < 0.5 ? 'crit' : 'warn'), s: ind.note || '' }; });
    const chartSeries = inds.filter((i) => i.unit === '%').slice(0, 5).map((ind, si) => ({ name: ind.ja, color: ind.color || CAT[si % CAT.length], values: indSeries(ind, ctx, H) }));
    let body = '';
    if (persp === 'region') {
      const dists = ctx.dists.slice().sort((a, b) => (b.exposure || 0) - (a.exposure || 0));
      body = `<div class="card"><div class="card-h"><h2>Public services by district</h2><span class="r">${asmTag('Model')}</span><span class="sub">Restoration day = base days × (0.4 + spread × district exposure)${sc.type === 'flood' ? ', plus half of the flood recession time' : ''}. Green = restored (≥ 90%), amber = partly, red = not yet; the label is the expected restoration day.</span></div>
        ${dists.length ? `<div class="tbl-wrap"><table class="svc-table"><thead><tr><th>District</th><th class="n">Exposure</th>${ctx.svcs.map((s) => `<th>${ic(s.icon || 'bolt')}${esc(s.ja)}</th>`).join('')}</tr></thead><tbody>${dists.map((dd) => `<tr><td><b>${esc(dd.name_ja.split('(')[0])}</b><span class="sub">pop ${fmtC(dd.pop)}</span></td><td class="n">${fmtPct(dd.exposure || 0)}</td>${ctx.svcDist(d, dd).map((x) => `<td><span class="tag ${x.frac >= 0.9 ? 'ok' : x.frac >= 0.4 ? 'warn' : 'crit'}" title="${esc(x.svc.ja)}: ${Math.round(x.frac * 100)}% at ${esc(fmtD(d))}">${x.frac >= 0.9 ? 'restored' : fmtD(x.day)}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="empty">No districts in this event (warning stage); city-wide services only.</div>`}</div>`;
    } else if (persp === 'company') {
      const sites = ctx.sites; const nodes = ctx.nodes;
      body = `<div class="grid c2">
        <div class="card"><div class="card-h"><h2>Sites</h2><span class="r"><span class="tag neutral">${esc(fmtD(d))}</span></span></div><div class="tbl-wrap"><table><thead><tr><th>Site</th><th class="n">Exposure</th><th class="n">Capacity</th><th class="n">Staff at work</th><th>Status</th></tr></thead><tbody>${sites.map((s) => { const c = ctx.siteCap(s, d), st = ctx.staffAt(s, d); return `<tr><td><b>${esc(s.label)} ${esc(s.short_ja || s.name_ja)}</b><span class="sub">${esc(s.district_ja || '')}</span></td><td class="n">${fmtPct(s.I)}</td><td class="n"><b>${fmtPct(c)}</b></td><td class="n">${fmtPct(st)}</td><td><span class="tag ${c >= 0.9 ? 'ok' : c >= 0.5 ? 'warn' : 'crit'}">${c >= 0.9 ? 'Normal operation' : c >= 0.5 ? 'Reduced' : 'Suspended / relocated'}</span></td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">No sites in this event</td></tr>'}</tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Supply chain nodes</h2><span class="r">${asmTag('Relationships assumed')}</span><span class="sub">Reopen day = base × (0.3 + 2 × exposure of the node's district); nodes outside the event area reopen quickly.</span></div><div class="tbl-wrap"><table class="sc-table"><thead><tr><th>Node</th><th>Kind</th><th class="n">Share</th><th>Reopen</th></tr></thead><tbody>${nodes.map((n) => { const day = ctx.nodeDay(n); const f = svcFrac(d, day); return `<tr><td><b>${esc(n.name_ja.split('(')[0].trim())}</b>${n.single ? '<span class="sub" style="color:var(--crit)">single source</span>' : ''}</td><td><span class="tag neutral">${esc(n.kind)}</span></td><td class="n">${n.share != null ? fmtPct(n.share) : '—'}</td><td><span class="tag ${f >= 0.9 ? 'ok' : f >= 0.4 ? 'warn' : 'crit'}">${f >= 0.9 ? 'open' : `${Math.round(f * 100)}% · ${fmtD(day)}`}</span></td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">No supply chain registered</td></tr>'}</tbody></table></div></div></div>`;
    } else {
      const dists = ctx.dists; const did = this.st.dist && dists.find((x) => x.id === this.st.dist) ? this.st.dist : (sc.area_district && dists.find((x) => x.id === sc.area_district) ? sc.area_district : (dists[0] || {}).id); this.st.dist = did;
      const dd = dists.find((x) => x.id === did) || null; const rows = ctx.svcDist(d, dd);
      body = `<div class="card"><div class="card-h"><h2>Public services in ${esc(dd ? dd.name_ja.split('(')[0] : (sc.city_ja || 'the city'))}</h2><span class="r">${dists.length ? `<select id="rcDist" aria-label="District">${dists.map((x) => `<option value="${esc(x.id)}"${x.id === did ? ' selected' : ''}>${esc(x.name_ja.split('(')[0])}</option>`).join('')}</select>` : ''}</span><span class="sub">What is back, what is still out, and the expected day. Expected days are model values; check the local authority and utility channels.</span></div>
        <div class="status-grid">${rows.map((x) => { const cls = x.frac >= 0.9 ? 'ok' : x.frac >= 0.4 ? 'warn' : 'crit'; return `<div class="st ${cls}"><div class="h">${ic(x.svc.icon || 'bolt')}${esc(x.svc.ja)}</div><div class="pct">${Math.round(x.frac * 100)}%</div><div class="track"><i style="width:${Math.round(x.frac * 100)}%;background:var(--${cls})"></i></div><div class="eta">${x.frac >= 0.9 ? 'Restored' : `Expected around ${fmtD(x.day)} (${fmtDays(x.day)})`}${x.svc.note ? ' · ' + esc(x.svc.note) : ''}</div></div>`; }).join('') || '<div class="empty">No services defined</div>'}</div></div>`;
    }
    const ms = (R.milestones || {})[persp] || []; const nMs = ms.length;
    box.innerHTML = `<div class="kpis">${kpis.map(kpiTileR).join('')}</div>
      <div class="grid map"><div class="card"><div class="card-h"><h2>Recovery indicators over time</h2><span class="r"><span class="tag neutral">${esc(fmtD(d))} · ${esc(ph.ja)}</span></span></div><div class="chart" id="rcChart"></div><div class="chart-cap">${chartSeries.map((s) => `<span><i class="ln" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}<span><i class="ln" style="background:var(--fg2);opacity:.5"></i>dotted = projection</span></div>${R.note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(R.note_ja)}</span></div>` : ''}</div>
        <div class="stack"><div class="card"><div class="card-h"><h2>Milestones · ${esc(PERSP.find((p) => p[0] === persp)[2])}</h2><span class="r"><span class="tag neutral">${ms.filter((m) => m.d <= d).length}/${nMs} reached</span></span></div><div id="rcMs" class="${nMs > 9 ? 'collapsed-ms' : ''}">${msList(ms, d, sc)}</div>${nMs > 9 ? '<button class="btn sm" data-more="rcMs">Show more</button>' : ''}</div></div></div>
      ${body}
      <div class="grid c2"><div class="card"><div class="card-h"><h2>Checklist for this phase · ${esc(ph.ja)}</h2><span class="r"><span class="tag neutral">${esc(fmtD(ph.from_d || 0))} to ${esc(fmtD(ph.to_d || H))}</span></span><span class="sub">Tick items as they are done (saved on this device).</span></div>${checklist(R, persp, ph, root, sc)}</div>
        <div class="card"><div class="card-h"><h2>References and assumptions</h2></div><ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--fg2)">${(R.refs || []).map((r) => `<li>${r.url ? `<a class="cite" href="${esc(r.url)}" target="_blank" rel="noopener">${ic('link')}${esc(r.name)}</a>` : esc(r.name)}${r.confirmed_by ? ` <span class="tag ${r.confirmed_by === 'page_read' ? 'neutral' : 'warn'}">${esc(r.confirmed_by)}</span>` : ''}</li>`).join('') || '<li>No references listed</li>'}</ul>${(R.assumptions_ja || []).length ? `<div class="card-h" style="margin-top:12px"><h3>Assumptions</h3></div><ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--fg2)">${R.assumptions_ja.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div></div>`;
    if (chartSeries.length) lineChart($('#rcChart', root), { now: d, xMax: H, xTicks: xTicksFor(H), xFmt: (x) => fmtD(x), yLabel: 'Recovery indicators', series: chartSeries, yFmt: (v) => `${Math.round(v * 100)}%`, height: 230 });
    else $('#rcChart', root).innerHTML = '<div class="empty">No percentage indicators for this perspective</div>';
    const ds = $('#rcDist', root); if (ds) ds.onchange = (e) => { this.st.dist = e.target.value; this.renderPanel(root); };
    if (window.updateScales) setTimeout(window.updateScales, 20);
  },
};
