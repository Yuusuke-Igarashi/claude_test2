/* Screen 3: Recovery monitoring — after the emergency, three timelines from one scenario:
 * region (local government), company (site and supply chain) and personal (public services in your district). Day d = days since onset.
 * Includes a what-if simulator: preparedness levers change recovery speed and cost against the baseline, and the gaps become a preparation list. */
const logi = (d, half, k) => 1 / (1 + Math.exp(-(d - half) / Math.max(0.5, k)));
const fmtD = (d) => `D+${Math.round(d)}`;
const fmtDays = (d) => { d = Math.round(d); if (d < 14) return `D+${d}`; if (d < 84) return `W+${Math.round(d / 7)}`; return `M+${Math.round(d / 30)}`; };
const PERSP = [['region', 'home', 'Region (local government)'], ['company', 'building', 'Company (site & supply chain)'], ['personal', 'users', 'Personal (public services)']];

/* ---------- What-if levers (per perspective). `rec` = value used when the simulator asks "what if this were in place". ---------- */
const LEVERS = {
  region: [
    { key: 'severity', ja: 'Event severity (multiplies exposure)', type: 'range', min: 0.5, max: 1.5, step: 0.1, def: 1, unit: '×', note: '1.0 = the scenario as written' },
    { key: 'early_warning', ja: 'Mass alert and early warning in place', type: 'check', def: false, rec: true, note: 'cell broadcast / SMS, sirens, drills', by: 'before the event', cost_ja: 'low (system exists in KZ; coverage and drills)' },
    { key: 'retrofit_pct', ja: 'Vulnerable buildings retrofitted or flood-proofed', type: 'range', min: 0, max: 100, step: 10, def: 0, rec: 50, unit: '%', note: '1960-80s blocks, schools, hospitals', by: 'multi-year programme', cost_ja: 'high' },
    { key: 'prepositioned', ja: 'Pre-positioned stocks and standby contracts', type: 'check', def: false, rec: true, note: 'water, pumps, generators, debris removal', by: 'before the season', cost_ja: 'medium' },
    { key: 'temp_housing', ja: 'Temporary housing capacity', type: 'number', min: 0, max: 60000, step: 1000, def: 0, rec: 15000, unit: 'people', note: 'modular units, host-family scheme', by: 'contracts before; delivery by W+6', cost_ja: 'medium-high' },
    { key: 'compensation_days', ja: 'Compensation paid within', type: 'number', min: 15, max: 365, step: 5, def: 90, rec: 45, unit: 'days', note: 'budget reserve, eGov claims, staff', by: 'rules and budget before the event', cost_ja: 'medium (budget reserve)' },
    { key: 'flood_defence', ja: 'Dikes raised and drainage upgraded', type: 'check', def: false, rec: true, only: 'flood', note: 'riverside districts', by: 'before the spring season', cost_ja: 'high' },
  ],
  company: [
    { key: 'severity', ja: 'Event severity (multiplies exposure)', type: 'range', min: 0.5, max: 1.5, step: 0.1, def: 1, unit: '×', note: '1.0 = the scenario as written' },
    { key: 'retrofit', ja: 'Office and warehouse fixed for the hazard', type: 'check', def: false, rec: true, note: 'non-structural seismic fixing, raised platform, flood barriers', by: 'before the event', cost_ja: 'medium' },
    { key: 'backup_h', ja: 'Backup power autonomy', type: 'number', min: 0, max: 168, step: 12, def: 0, rec: 72, unit: 'h', note: 'generator fuel or batteries for server room and cool/warm room', by: 'before the event', cost_ja: 'medium' },
    { key: 'remote_pct', ja: 'Staff able to work remotely', type: 'range', min: 0, max: 100, step: 10, def: 30, rec: 80, unit: '%', note: 'laptops, VPN, cloud data', by: 'before the event', cost_ja: 'low-medium' },
    { key: 'alt_site', ja: 'Alternate site agreed in another city', type: 'check', def: false, rec: true, note: 'desks, data, authority to relocate', by: 'before the event', cost_ja: 'low (agreement) to medium' },
    { key: 'inventory_days', ja: 'Safety stock of critical inputs', type: 'number', min: 0, max: 60, step: 5, def: 10, rec: 21, unit: 'days', note: 'covers supplier outages', by: 'before the season', cost_ja: 'medium (working capital)' },
    { key: 'second_source', ja: 'Second source for single-source suppliers and routes', type: 'check', def: false, rec: true, note: 'qualified supplier, alternative corridor', by: 'before the event', cost_ja: 'low-medium' },
    { key: 'insurance_pct', ja: 'Property and business-interruption insurance cover', type: 'range', min: 0, max: 100, step: 10, def: 50, rec: 80, unit: '%', note: 'share of direct damage and half of interruption losses recovered', by: 'policy renewal', cost_ja: 'premium' },
    { key: 'family_support', ja: 'Family support programme ready', type: 'check', def: false, rec: true, note: 'housing, schooling, cash advances, counselling', by: 'before the event', cost_ja: 'low to set up' },
  ],
  personal: [
    { key: 'severity', ja: 'Event severity (multiplies exposure)', type: 'range', min: 0.5, max: 1.5, step: 0.1, def: 1, unit: '×', note: '1.0 = the scenario as written' },
    { key: 'stock_days', ja: 'Household stock (water, food, medicines)', type: 'number', min: 0, max: 30, step: 1, def: 3, rec: 7, unit: 'days', note: '3 L water per person per day', by: 'now', cost_ja: 'low' },
    { key: 'home_insurance', ja: 'Home and contents insurance', type: 'check', def: false, rec: true, note: 'covers most repair costs', by: 'policy renewal', cost_ja: 'premium' },
    { key: 'evac_plan', ja: 'Family plan, meeting points and go-bag', type: 'check', def: false, rec: true, note: 'documents, cash, medicines ready', by: 'now', cost_ja: 'low' },
    { key: 'remote_work', ja: 'Able to work remotely', type: 'check', def: true, rec: true, note: 'protects income while the site is down', by: 'before the event', cost_ja: 'low' },
    { key: 'embassy_reg', ja: 'Registered with embassy and company safety-check system', type: 'check', def: false, rec: true, note: 'faster support and information', by: 'now', cost_ja: 'none' },
    { key: 'power_bank', ja: 'Power bank, battery lamp, camping stove, warm clothing', type: 'check', def: false, rec: true, note: 'bridges power and heating outages', by: 'now', cost_ja: 'low' },
  ],
};
const leversFor = (persp, sc) => LEVERS[persp].filter((lv) => !lv.only || lv.only === sc.type);
const leverDefaults = (persp, sc) => Object.fromEntries(leversFor(persp, sc).map((lv) => [lv.key, lv.def]));
/* Lever values → model factors */
function simFactors(persp, p, sc) {
  const F = { sev: +(p.severity || 1), expMul: 1, svcMul: 1, capHalfMul: 1, capFloor: 0, staffFloor: 0, staffHalfMul: 1, invDays: 0, supplyFloor: 0, nodeMul: 1, shelterPeakMul: 1, shelterTauMul: 1, compHalf: null, housingHalfMul: 1, bizHalfMul: 1, normalMul: 1, damageMul: 1, insurance: 0, emergMul: 1, infraMul: 1 };
  if (persp === 'region') {
    const r = (p.retrofit_pct || 0) / 100; const quake = sc.type === 'quake'; const fd = sc.type === 'flood' && p.flood_defence;
    F.expMul = (quake ? 1 - 0.5 * r : 1 - 0.2 * r) * (fd ? 0.7 : 1);
    F.svcMul = (p.early_warning ? 0.92 : 1) * (p.prepositioned ? 0.8 : 1) * (1 - 0.3 * r) * (fd ? 0.75 : 1);
    F.shelterPeakMul = (p.early_warning ? 0.85 : 1) * (fd ? 0.7 : 1) * (quake ? 1 - 0.4 * r : 1 - 0.15 * r);
    F.compHalf = p.compensation_days != null ? +p.compensation_days : null;
    F.housingHalfMul = (1 - 0.4 * r) * (1 - 0.2 * Math.max(0, (90 - (p.compensation_days || 90)) / 90)) * (p.prepositioned ? 0.9 : 1);
    F.bizHalfMul = (p.prepositioned ? 0.85 : 1) * (1 - 0.2 * r);
    F.damageMul = (quake ? 1 - 0.5 * r : 1 - 0.2 * r) * (fd ? 0.6 : 1); F.infraMul = (1 - 0.3 * r) * (fd ? 0.8 : 1); F.emergMul = (p.prepositioned ? 0.85 : 1) * (p.early_warning ? 0.9 : 1);
    F.tempHousing = +(p.temp_housing || 0);
  } else if (persp === 'company') {
    F.capHalfMul = (p.retrofit ? 0.6 : 1) * (1 - Math.min(0.25, (p.backup_h || 0) / 400)) * (p.alt_site ? 0.75 : 1);
    F.capFloor = p.alt_site ? 0.4 : 0; F.staffFloor = (p.remote_pct || 0) / 100; F.staffHalfMul = p.family_support ? 0.7 : 1;
    F.invDays = +(p.inventory_days || 0); F.supplyFloor = p.second_source ? 0.5 : 0; F.nodeMul = p.second_source ? 0.85 : 1;
    F.damageMul = p.retrofit ? 0.5 : 1; F.insurance = (p.insurance_pct || 0) / 100; F.familySupport = !!p.family_support;
  } else {
    F.normalMul = (p.evac_plan ? 0.85 : 1) * (p.power_bank ? 0.9 : 1); F.stockDays = +(p.stock_days || 0);
  }
  return F;
}
/* Service restoration day for a district: base days × (0.4 + spread × exposure); floods add part of the recession time. */
function svcDay(sc, svc, dist, F) { F = F || {}; const I = clamp((dist ? (dist.exposure || 0) : 0.5) * (F.sev || 1) * (F.expMul || 1), 0, 1); const rec = (sc.type === 'flood' && dist) ? ((dist.recede_h || 0) / 24) * 0.5 : 0; return (rec + svc.base_d * (0.4 + (svc.spread || 2) * I)) * (F.svcMul || 1); }
const svcFrac = (d, day) => logi(d, day, Math.max(0.7, day / 4));
function recCtx(sc, F) {
  F = F || {}; const R = sc.recovery || {}; const dists = sc.districts || []; const svcs = R.services || [];
  const g = (typeof GD === 'function' ? GD() : { supply: {} });
  const nodes = (sc.supply_sites || []).flatMap((sid) => (g.supply[sid] || []));
  const expOf = (dd) => clamp((dd ? (dd.exposure || 0) : 0) * (F.sev || 1) * (F.expMul || 1), 0, 1);
  const recOf = (dd) => (sc.type === 'flood' && dd) ? ((dd.recede_h || 0) / 24) * 0.5 : 0;
  const nodeDay = (n) => { const dd = n.district ? dists.find((x) => x.id === n.district) : null; const I = dd ? expOf(dd) : 0.05 * (F.sev || 1); return (recOf(dd) + ((R.company && R.company.node_base_d) || 20) * (0.3 + 2 * I)) * (F.nodeMul || 1); };
  const nodeAvail = (n, d) => { if (n.kind === 'supplier' && d < (F.invDays || 0)) return 1; const f = svcFrac(d, nodeDay(n)); return n.single ? Math.max(F.supplyFloor || 0, f) : f; };
  const siteI = (s) => { const dd = dists.find((x) => x.id === s.district); return expOf(dd) * (s.exposure_mult || 1); };
  const capHalf = (R.company && R.company.cap_half_d) || 30, capK = (R.company && R.company.cap_k_d) || 8;
  const siteCap = (s, d) => { const I = siteI(s); if (I < 0.05) return 1; const c = logi(d, (recOf(dists.find((x) => x.id === s.district)) + capHalf * (0.3 + I)) * (F.capHalfMul || 1), capK * (0.5 + I)); return d >= 3 ? Math.max(c, F.capFloor || 0) : c; };
  const staffAt = (s, d) => { const I = siteI(s); if (I < 0.05) return 1; const v = logi(d, (6 + 20 * I) * (F.staffHalfMul || 1), 3 + 4 * I); return d >= 2 ? Math.max(v, F.staffFloor || 0) : v; };
  const ctx = {
    R, F, dists, svcs, nodes, expOf,
    svcAvg: (d) => { if (!svcs.length) return 1; const ds = dists.length ? dists : [null]; let s = 0, w = 0; ds.forEach((dd) => { const pop = dd ? (dd.pop || 1) : 1; svcs.forEach((sv) => { s += pop * svcFrac(d, svcDay(sc, sv, dd, F)); w += pop; }); }); return w ? s / w : 1; },
    svcDist: (d, dd) => svcs.map((sv) => { const day = svcDay(sc, sv, dd, F); return { svc: sv, day, frac: svcFrac(d, day) }; }),
    svcDistAvg: (d, dd) => { if (!svcs.length) return 1; return sum(svcs, (sv) => svcFrac(d, svcDay(sc, sv, dd, F))) / svcs.length; },
    sites: (sc.sites || []).map((s) => Object.assign({}, s, { I: siteI(s) })),
    siteCap, staffAt, nodeDay, nodeAvail,
    siteCapAvg: (d) => { const ss = sc.sites || []; if (!ss.length) return 1; return sum(ss, (s) => siteCap(s, d)) / ss.length; },
    staffAvg: (d) => { const ss = sc.sites || []; if (!ss.length) return 1; return sum(ss, (s) => s.staff * staffAt(s, d)) / Math.max(1, sum(ss, (s) => s.staff)); },
    supplyAvail: (d) => { if (!nodes.length) return 1; const w = sum(nodes, (n) => n.share || 0.2); return sum(nodes, (n) => (n.share || 0.2) * nodeAvail(n, d)) / Math.max(1e-9, w); },
  };
  return ctx;
}
function indVal(ind, d, ctx) {
  const k = ind.kind || 'logistic'; const F = ctx.F || {};
  if (k === 'logistic') { let half = ind.half_d; if (ind.key === 'comp' && F.compHalf) half = F.compHalf; if (ind.key === 'housing' || ind.key === 'rebuilt' || ind.key === 'dried') half *= F.housingHalfMul || 1; if (ind.key === 'biz' || ind.key === 'schools') half *= F.bizHalfMul || 1; if (ind.key === 'normal') half *= F.normalMul || 1; return (ind.start || 0) + ((ind.end != null ? ind.end : 1) - (ind.start || 0)) * logi(d, half, ind.k_d || half / 4); }
  if (k === 'decay') { const dl = ind.delay_d || 0; let peak = ind.peak, tau = ind.tau_d || 30; if (ind.key === 'shelter' || ind.key === 'disp') { peak *= (F.shelterPeakMul || 1) * (F.sev || 1); tau *= 1 - Math.min(0.5, (F.tempHousing || 0) / Math.max(1, peak)); } return (ind.floor || 0) + (peak - (ind.floor || 0)) * (d <= dl ? 1 : Math.exp(-(d - dl) / tau)); }
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
const kpiTileR = (x) => `<div class="kpi ${x.c || ''}"><span class="v">${x.v}<small>${esc(x.u || '')}</small></span><span class="l">${esc(x.l)}</span>${x.d || ''}<span class="s">${esc(x.s || '')}</span></div>`;
function msList(ms, d, sc) { const rows = (ms || []).slice().sort((a, b) => a.d - b.d); if (!rows.length) return '<div class="empty">No milestones defined</div>'; return `<div class="timeline">${rows.map((m) => { const st = m.d <= d ? 'done' : 'future'; const near = Math.abs(m.d - d) <= Math.max(1, d * 0.05); return `<div class="tl ${st === 'future' ? 'future' : (m.cls || '')}${near ? ' now' : ''}"><span class="t">${esc(fmtD(m.d))}${fmtDays(m.d) !== fmtD(m.d) ? `<b>${esc(fmtDays(m.d))}</b>` : ''}<b>${esc(m.who || '')}</b></span><span class="m"><b>${esc(m.ja)}${near ? ' <span class="tag acc">now</span>' : ''}</b><span>${esc(m.detail || '')}${m.src ? ` · ${esc(m.src)}` : ''}</span></span></div>`; }).join('')}</div>`; }
function checklist(R, persp, phase, root, sc) { const cl = ((R.checklists || {})[persp] || {})[phase.key] || []; if (!cl.length) return '<div class="empty">No checklist for this phase</div>'; return `<div class="chk-list">${cl.map((c, i) => { const key = `rc|${sc.id}|${persp}|${phase.key}|${i}`; const done = !!(App.views.recovery.st.done[key]); return `<div class="chk" data-done="${done ? 1 : 0}"><button class="box" data-rchk="${esc(key)}" aria-label="Mark done">${ic('check')}</button><span class="t"><b>${esc(typeof c === 'string' ? c : c.ja)}</b>${c.why ? `<span>${esc(c.why)}</span>` : ''}</span></div>`; }).join('')}</div>`; }

/* ---------- Outcomes: recovery speed (days to threshold) and cost, for one lever setting ---------- */
const firstDay = (H, f) => { for (let d = 0; d <= H; d++) if (f(d)) return d; return null; };
const integ = (H, f) => { let s = 0; for (let d = 0; d <= H; d++) s += Math.max(0, 1 - f(d)); return s; };
function outcomes(sc, persp, p, opts = {}) {
  const R = sc.recovery || {}; const H = R.horizon_d || 90; const F = simFactors(persp, p, sc); const ctx = recCtx(sc, F); const SIM = (R.simulator || {})[persp] || {};
  const inds = (R.indicators || {})[persp] || []; const findInd = (keys) => inds.find((i) => keys.includes(i.key));
  const speed = []; let cost = 0; const parts = []; let mainD = null;
  const dayOf = (label, f, note) => { const d = firstDay(H, f); speed.push({ ja: label, d, note }); return d; };
  if (persp === 'region') {
    mainD = dayOf('Public services ≥ 90% (population-weighted)', (d) => ctx.svcAvg(d) >= 0.9);
    const sh = findInd(['shelter', 'disp']); if (sh) dayOf(`${sh.ja} below ${fmtC(sh.target || 2000)}`, (d) => indVal(sh, d, ctx) <= (sh.target || 2000));
    const hs = findInd(['housing', 'rebuilt', 'dried']); if (hs) dayOf(`${hs.ja} ≥ 50%`, (d) => indVal(hs, d, ctx) >= 0.5);
    const bz = findInd(['biz', 'schools']); if (bz) dayOf(`${bz.ja} ≥ 90%`, (d) => indVal(bz, d, ctx) >= 0.9);
    const affected = sum(ctx.dists, (dd) => (dd.pop || 0) * ctx.expOf(dd) * 0.7);
    const emerg = affected * (SIM.per_capita_usd || 0) * F.emergMul / 1e6; const housing = (SIM.dwellings || 0) * (SIM.repair_usd || 0) * F.sev * F.damageMul / 1e6; const infra = (SIM.infra_m || 0) * F.sev * F.infraMul;
    const tempH = (F.tempHousing || 0) * (SIM.temp_housing_usd || 2500) / 1e6;
    parts.push(['Emergency response (shelter, relief, rescue)', emerg], ['Housing repair and rebuilding', housing], ['Infrastructure and utilities', infra]); if (tempH) parts.push(['Temporary housing programme', tempH]);
    cost = emerg + housing + infra + tempH;
  } else if (persp === 'company') {
    mainD = dayOf('Site capacity ≥ 90% (all sites)', (d) => ctx.siteCapAvg(d) >= 0.9);
    dayOf('Staff at work ≥ 90%', (d) => ctx.staffAvg(d) >= 0.9);
    dayOf('Supply chain availability ≥ 90%', (d) => ctx.supplyAvail(d) >= 0.9);
    const direct = (SIM.direct_damage_m || 0) * F.sev * F.damageMul; const bi = (SIM.daily_loss_m || 0) * integ(H, (d) => ctx.siteCapAvg(d)); const sup = (SIM.supply_daily_m || 0) * integ(H, (d) => ctx.supplyAvail(d)); const support = F.familySupport ? (SIM.family_support_m || 0.05) : 0; const recov = F.insurance * (direct + 0.5 * bi);
    parts.push(['Direct damage (building, equipment, stock)', direct], ['Business interruption (lost margin while capacity is down)', bi], ['Supply-chain disruption', sup]); if (support) parts.push(['Family support programme', support]); parts.push(['Insurance recovery', -recov]);
    cost = direct + bi + sup + support - recov;
  } else {
    const did = opts.district; const dd = ctx.dists.find((x) => x.id === did) || ctx.dists[0] || null;
    mainD = dayOf(`Services in ${dd ? dd.name_ja.split('(')[0].trim() : 'the city'} ≥ 90%`, (d) => ctx.svcDistAvg(d, dd) >= 0.9);
    const nm = findInd(['normal']); if (nm) dayOf('Daily life ≥ 80% normal', (d) => indVal(nm, d, ctx) >= 0.8);
    const outDays = (() => { const ks = ctx.svcs.filter((s) => ['power', 'water', 'heating'].includes(s.key)); if (!ks.length) return 0; return Math.max(...ks.map((s) => svcDay(sc, s, dd, F))); })();
    const covered = Math.min(outDays, F.stockDays || 0); speed.push({ ja: 'Days without basic services covered by household stock', d: null, text: `${Math.round(covered)} of ${Math.round(outDays)} days${outDays > (F.stockDays || 0) ? ` (gap ${Math.round(outDays - (F.stockDays || 0))} days)` : ''}` });
    const me = (App.views.me && App.views.me.st) || {}; const hh = (me.members || []).length || 4; const home = me.home || 'highrise';
    const I = dd ? ctx.expOf(dd) : 0.3; const repair = ((home === 'house' ? SIM.repair_house_usd : SIM.repair_apt_usd) || 0) * I * (p.home_insurance ? 0.3 : 1);
    const shelterDays = Math.max(0, outDays - (F.stockDays || 0)) * (p.evac_plan ? 0.7 : 1) * (p.power_bank ? 0.8 : 1); const shelter = shelterDays * (SIM.shelter_day_usd || 0) * hh;
    const site = M.sites().find((s) => s.id === me.site) || M.sites().find((s) => s.id === sc.area_site); const scSite = ctx.sites.find((s) => s.id === (site && site.id));
    const workDays = scSite ? (firstDay(H, (d) => ctx.staffAt(scSite, d) >= 0.9) || H) : 0; const income = workDays * (SIM.daily_wage_usd || 0) * (p.remote_work ? 0.3 : 1);
    parts.push(['Home repairs net of insurance', repair / 1e6], ['Shelter and extra living costs', shelter / 1e6], ['Lost income', income / 1e6]);
    cost = (repair + shelter + income) / 1e6;
  }
  return { speed, mainD, cost, parts, F, ctx, H };
}
function prepList(sc, persp, p, cur, opts) {
  const items = [];
  leversFor(persp, sc).forEach((lv) => {
    if (lv.key === 'severity' || lv.rec == null) return;
    const on = lv.type === 'check' ? !!p[lv.key] : (+p[lv.key] || 0) >= lv.rec;
    if (on) { items.push({ kind: 'have', ja: lv.ja + (lv.type !== 'check' ? ` (${p[lv.key]}${lv.unit || ''})` : ''), by: lv.by || '', gainD: 0, gainC: 0 }); return; }
    const p2 = Object.assign({}, p, { [lv.key]: lv.rec }); const o2 = outcomes(sc, persp, p2, opts);
    const gainD = (cur.mainD == null ? cur.H : cur.mainD) - (o2.mainD == null ? o2.H : o2.mainD); const gainC = cur.cost - o2.cost;
    items.push({ kind: 'todo', ja: lv.ja + (lv.type !== 'check' ? ` → ${lv.rec}${lv.unit || ''}` : ''), by: lv.by || 'before the event', cost_ja: lv.cost_ja, gainD, gainC });
  });
  const todo = items.filter((x) => x.kind === 'todo').sort((a, b) => (b.gainD - a.gainD) || (b.gainC - a.gainC)); const have = items.filter((x) => x.kind === 'have');
  /* timeline-driven preparation */
  const tl = []; const ctx = cur.ctx; const H = cur.H;
  if (persp === 'company') {
    const inv = cur.F.invDays || 0; const supD = cur.speed.find((s) => /Supply/.test(s.ja)); const sD = supD && supD.d != null ? supD.d : null;
    if (sD != null && inv < sD) tl.push({ d: Math.max(0, inv - 5), ja: `Reorder from alternative sources before safety stock runs out at ${fmtD(inv)} (supply chain back at ${fmtD(sD)})` });
    if (cur.mainD != null) tl.push({ d: Math.max(1, Math.round(cur.mainD * 0.3)), ja: `Decide on repair vs. relocation; engineer sign-off before re-entry (capacity back to 90% at ${fmtD(cur.mainD)})` });
    const st = cur.speed.find((s) => /Staff/.test(s.ja)); if (st && st.d != null) tl.push({ d: 2, ja: `Daily family check-ins and support until staff are back at work (${fmtD(st.d)})` });
    tl.push({ d: 7, ja: 'Customer and insurer communication: interim delivery plan and claim file with photos' });
  } else if (persp === 'region') {
    const sh = cur.speed.find((s) => /below/.test(s.ja)); if (sh && sh.d != null) tl.push({ d: Math.round(sh.d * 0.4), ja: `Temporary housing and host-family scheme in place before shelters empty (${fmtD(sh.d)})` });
    tl.push({ d: 7, ja: 'Damage certification teams and the compensation document list published' });
    if (cur.mainD != null) tl.push({ d: Math.round(cur.mainD * 0.5), ja: `Utility restoration schedule by district published; services ≥ 90% expected ${fmtD(cur.mainD)}` });
    const hs = cur.speed.find((s) => /50%/.test(s.ja)); if (hs && hs.d != null) tl.push({ d: Math.round(hs.d * 0.5), ja: `Reconstruction contracts and materials secured for the housing programme (50% by ${fmtD(hs.d)})` });
  } else {
    const gap = cur.speed.find((s) => /covered/.test(s.ja)); if (gap && /gap/.test(gap.text || '')) tl.push({ d: 0, ja: `Close the stock gap now (${gap.text}) or arrange a host family / hotel plan` });
    if (cur.mainD != null) tl.push({ d: Math.round(cur.mainD * 0.5), ja: `Expect basic services back around ${fmtD(cur.mainD)}; plan school, work and medical routines until then` });
    tl.push({ d: 7, ja: 'Photograph damage and file the compensation / insurance claim within the first week' });
  }
  return { todo, have, tl: tl.sort((a, b) => a.d - b.d) };
}

App.views.recovery = {
  st: { scen: null, day: null, persp: Store.get('rcPersp', 'region'), dist: null, done: Store.get('rcDone', {}), sim: Store.get('rcSim', {}), simOpen: Store.get('rcSimOpen', true) },
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">03 · Recovery monitoring</span><span class="aud">${ic('users')}Audience: managers of companies and local governments, and staff</span></div>
          <h1>Track the way back: <em>from emergency to normal</em></h1>
          <p class="q"><b>Question:</b> After the live phase, how fast do the region, the company and daily life recover, what has to happen by when, and what would change if we were better prepared? One scenario, three timelines, and a what-if simulator that turns preparedness levers into recovery speed, cost and a preparation list.</p>
        </div>
        <div class="vh-r"><span class="tag asm">Recovery curves and costs are model assumptions</span><span class="tag neutral">Milestones cite real analog events where available</span></div>
      </div>
      <div class="card" id="rcCtl"></div>
      <div class="tabs" role="tablist" id="rcTabs"></div>
      <div class="tabpanel" id="rcPanel"></div>`;
    root.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-persp]'); if (tb) { self.st.persp = tb.dataset.persp; Store.set('rcPersp', self.st.persp); self.renderTabs(root); self.renderPanel(root); return; }
      const ck = e.target.closest('[data-rchk]'); if (ck) { const k = ck.dataset.rchk; self.st.done[k] = !self.st.done[k]; Store.set('rcDone', self.st.done); ck.closest('.chk').dataset.done = self.st.done[k] ? 1 : 0; return; }
      const mb = e.target.closest('[data-more]'); if (mb) { const tl = $('#' + mb.dataset.more, root); tl.classList.toggle('collapsed-ms'); mb.textContent = tl.classList.contains('collapsed-ms') ? 'Show more' : 'Show less'; return; }
      const rs = e.target.closest('[data-simreset]'); if (rs) { const sc = self.scenario(); self.st.sim[sc.id + '|' + self.st.persp] = leverDefaults(self.st.persp, sc); Store.set('rcSim', self.st.sim); self.renderPanel(root); return; }
      const tg = e.target.closest('[data-simtoggle]'); if (tg) { self.st.simOpen = !self.st.simOpen; Store.set('rcSimOpen', self.st.simOpen); self.renderPanel(root); return; }
    });
    root.addEventListener('input', (e) => { const lv = e.target.closest('[data-lv]'); if (!lv) return; const sc = self.scenario(); const key = sc.id + '|' + self.st.persp; const p = self.st.sim[key] || (self.st.sim[key] = leverDefaults(self.st.persp, sc)); p[lv.dataset.lv] = lv.type === 'checkbox' ? lv.checked : +lv.value; Store.set('rcSim', self.st.sim); const out = lv.closest('.lever') && lv.closest('.lever').querySelector('output'); if (out) out.textContent = lv.type === 'checkbox' ? '' : lv.value + (lv.dataset.unit || ''); cancelAnimationFrame(self._raf2); self._raf2 = requestAnimationFrame(() => self.renderPanel(root, true)); });
    document.addEventListener('ctxchange', () => { if (App.current === 'recovery') self.renderPanel(root); });
    this.update(root);
  },
  show(root) { if (typeof Live !== 'undefined' && Live.st.scen && Live.st.scen !== this.st.scen) { this.st.scen = Live.st.scen; this.st.day = null; } this.update(root); },
  scenario() { let sc = M.scenario(this.st.scen || (typeof Live !== 'undefined' ? Live.st.scen : null)); if (!sc) sc = M.scenarios()[0]; this.st.scen = sc.id; return sc; },
  params(sc, persp) { const key = sc.id + '|' + persp; const d = leverDefaults(persp, sc); const p = Object.assign({}, d, this.st.sim[key] || {}); return p; },
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
  renderSim(sc, persp, p, cur, base, opts) {
    const lvs = leversFor(persp, sc); const pr = prepList(sc, persp, p, cur, opts);
    const row = (lv) => { const v = p[lv.key]; const ctrl = lv.type === 'check' ? `<input type="checkbox" data-lv="${lv.key}"${v ? ' checked' : ''}>` : lv.type === 'range' ? `<input type="range" data-lv="${lv.key}" data-unit="${esc(lv.unit || '')}" min="${lv.min}" max="${lv.max}" step="${lv.step}" value="${v}"><output>${v}${esc(lv.unit || '')}</output>` : `<input type="number" data-lv="${lv.key}" data-unit="${esc(lv.unit || '')}" min="${lv.min}" max="${lv.max}" step="${lv.step}" value="${v}"><output>${esc(lv.unit || '')}</output>`; return `<label class="lever ${lv.type}">${lv.type === 'check' ? ctrl : ''}<span class="lt"><b>${esc(lv.ja)}</b><small>${esc(lv.note || '')}</small></span>${lv.type !== 'check' ? `<span class="lc">${ctrl}</span>` : ''}</label>`; };
    const dd = (a, b) => { if (a == null || b == null) return ''; const x = b - a; return x === 0 ? '<span class="d">±0</span>' : `<span class="d ${x > 0 ? 'up' : 'dn'}">${x > 0 ? '+' : '−'}${Math.abs(Math.round(x))} d</span>`; };
    const dc = (a, b) => { const x = b - a; if (Math.abs(x) < Math.max(0.0005, Math.abs(a) * 0.005)) return '<span class="d">±0</span>'; return `<span class="d ${x > 0 ? 'up' : 'dn'}">${x > 0 ? '+' : '−'}${fmtUSD(Math.abs(x))}</span>`; };
    const fd = (v, H) => v == null ? `> ${fmtD(H)}` : fmtD(v);
    return `<div class="card sim"><div class="card-h"><h2>${ic('gauge')}Scenario simulator: what if we were prepared?</h2><span class="r"><button class="btn sm" data-simreset>Reset to baseline</button><button class="btn sm" data-simtoggle>${this.st.simOpen ? 'Hide levers' : 'Show levers'}</button></span><span class="sub">Tick the measures you have (or set the numbers) and read how recovery speed and cost move against the baseline scenario. The gaps become the preparation list, ranked by effect on the main recovery indicator.</span></div>
      <div class="grid c2 sim-grid">
        <div class="lever-grid"${this.st.simOpen ? '' : ' hidden'}>${lvs.map(row).join('')}</div>
        <div class="stack">
          <div class="tbl-wrap"><table class="sim-table"><thead><tr><th>Outcome</th><th class="n">Baseline</th><th class="n">Your scenario</th><th class="n">Change</th></tr></thead><tbody>
            ${cur.speed.map((s, i) => { const b = base.speed[i] || {}; return `<tr><td>${esc(s.ja)}${s.note ? `<span class="sub">${esc(s.note)}</span>` : ''}</td>${s.text != null ? `<td class="n" colspan="3">${esc(s.text)}</td>` : `<td class="n">${fd(b.d, base.H)}</td><td class="n"><b>${fd(s.d, cur.H)}</b></td><td class="n">${dd(b.d == null ? base.H : b.d, s.d == null ? cur.H : s.d)}</td>`}</tr>`; }).join('')}
            <tr class="tot"><td><b>Recovery cost (${persp === 'personal' ? 'household' : persp === 'region' ? 'public' : 'company, net of insurance'})</b><span class="sub">${cur.parts.map(([n, v]) => `${esc(n)}: ${v < 0 ? '−' : ''}${fmtUSD(Math.abs(v))}`).join(' · ')}</span></td><td class="n">${fmtUSD(base.cost)}</td><td class="n"><b>${fmtUSD(cur.cost)}</b></td><td class="n">${dc(base.cost, cur.cost)}</td></tr>
          </tbody></table></div>
          <div class="card-h" style="margin-top:4px"><h3>What to prepare, biggest effect first</h3><span class="r"><span class="tag neutral">${pr.todo.length} gaps · ${pr.have.length} in place</span></span></div>
          <div class="prep-list">${pr.todo.slice(0, 6).map((t) => `<div class="prep"><span class="pk">${ic('alert')}</span><div><b>${esc(t.ja)}</b><span>${t.gainD > 0 ? `−${Math.round(t.gainD)} days to recovery` : 'no change in days'}${Math.abs(t.gainC) >= 0.0005 ? ` · ${t.gainC > 0 ? '−' : '+'}${fmtUSD(Math.abs(t.gainC))} cost` : ''} · when: ${esc(t.by)}${t.cost_ja ? ` · effort: ${esc(t.cost_ja)}` : ''}</span></div></div>`).join('')}${pr.have.length ? `<div class="prep have"><span class="pk">${ic('check')}</span><div><b>In place</b><span>${pr.have.map((h) => esc(h.ja)).join(' · ')}</span></div></div>` : ''}</div>
          <div class="card-h" style="margin-top:4px"><h3>Timeline-driven actions for this scenario</h3></div>
          <div class="timeline">${pr.tl.map((t) => `<div class="tl"><span class="t">${esc(fmtD(t.d))}<b>${esc(fmtDays(t.d))}</b></span><span class="m"><b>${esc(t.ja)}</b></span></div>`).join('') || '<div class="empty">—</div>'}</div>
        </div></div>
      ${(sc.recovery.simulator && sc.recovery.simulator.note_ja) ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(sc.recovery.simulator.note_ja)}</span></div>` : ''}</div>`;
  },
  renderPanel(root, keepScroll) {
    const sc = this.scenario(); const R = sc.recovery; const box = $('#rcPanel', root);
    if (!R) { box.innerHTML = `<div class="note">${ic('info')}<span>No recovery timeline is defined for this event.</span></div>`; return; }
    const d = this.st.day; const H = R.horizon_d || 90; const persp = this.st.persp; const p = this.params(sc, persp);
    const dists = sc.districts || []; if (persp === 'personal') { const did = this.st.dist && dists.find((x) => x.id === this.st.dist) ? this.st.dist : (sc.area_district && dists.find((x) => x.id === sc.area_district) ? sc.area_district : (dists[0] || {}).id); this.st.dist = did; }
    const opts = { district: this.st.dist };
    const cur = outcomes(sc, persp, p, opts); const base = outcomes(sc, persp, leverDefaults(persp, sc), opts); const ctx = cur.ctx; const ctx0 = base.ctx; const ph = phaseAt(R, d);
    const inds = (R.indicators || {})[persp] || [];
    const kpis = inds.slice(0, 6).map((ind) => { const v = indVal(ind, d, ctx); const v0 = indVal(ind, d, ctx0); const f = indFmt(ind); const good = ind.good === 'low' ? v <= (ind.target != null ? ind.target : 0.1) : v >= (ind.target != null ? ind.target : 0.9); const diff = v - v0; const dl = Math.abs(diff) > (ind.unit === '%' ? 0.005 : 0.5) ? `<span class="d ${(diff > 0) === (ind.good !== 'low') ? 'dn' : 'up'}">${diff > 0 ? '+' : '−'}${ind.unit === '%' ? Math.round(Math.abs(diff) * 100) + ' pt' : f(Math.abs(diff))} vs baseline</span>` : ''; return { v: f(v), u: '', l: ind.ja, c: good ? 'ok' : ind.good === 'low' ? (v > (ind.peak || 1) * 0.5 ? 'crit' : 'warn') : (v < 0.5 ? 'crit' : 'warn'), s: ind.note || '', d: dl }; });
    const pctInds = inds.filter((i) => i.unit === '%').slice(0, 4);
    const chartSeries = pctInds.map((ind, si) => ({ name: ind.ja, color: ind.color || CAT[si % CAT.length], values: indSeries(ind, ctx, H) })).concat(pctInds.map((ind, si) => ({ name: ind.ja + ' (baseline)', color: ind.color || CAT[si % CAT.length], values: indSeries(ind, ctx0, H), dash: true })));
    let body = '';
    if (persp === 'region') {
      const ds = ctx.dists.slice().sort((a, b) => (b.exposure || 0) - (a.exposure || 0));
      body = `<div class="card"><div class="card-h"><h2>Public services by district</h2><span class="r">${asmTag('Model')}</span><span class="sub">Restoration day = base days × (0.4 + spread × district exposure)${sc.type === 'flood' ? ', plus half of the flood recession time' : ''}, scaled by the simulator levers. Green = restored (≥ 90%), amber = partly, red = not yet; the label is the expected restoration day.</span></div>
        ${ds.length ? `<div class="tbl-wrap"><table class="svc-table"><thead><tr><th>District</th><th class="n">Exposure</th>${ctx.svcs.map((s) => `<th>${ic(s.icon || 'bolt')}${esc(s.ja)}</th>`).join('')}</tr></thead><tbody>${ds.map((dd) => `<tr><td><b>${esc(dd.name_ja.split('(')[0])}</b><span class="sub">pop ${fmtC(dd.pop)}</span></td><td class="n">${fmtPct(ctx.expOf(dd))}</td>${ctx.svcDist(d, dd).map((x) => `<td><span class="tag ${x.frac >= 0.9 ? 'ok' : x.frac >= 0.4 ? 'warn' : 'crit'}" title="${esc(x.svc.ja)}: ${Math.round(x.frac * 100)}% at ${esc(fmtD(d))}">${x.frac >= 0.9 ? 'restored' : fmtD(x.day)}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="empty">No districts in this event (warning stage); city-wide services only.</div>`}</div>`;
    } else if (persp === 'company') {
      const sites = ctx.sites; const nodes = ctx.nodes;
      body = `<div class="grid c2">
        <div class="card"><div class="card-h"><h2>Sites</h2><span class="r"><span class="tag neutral">${esc(fmtD(d))}</span></span></div><div class="tbl-wrap"><table><thead><tr><th>Site</th><th class="n">Exposure</th><th class="n">Capacity</th><th class="n">Staff at work</th><th>Status</th></tr></thead><tbody>${sites.map((s) => { const c = ctx.siteCap(s, d), st = ctx.staffAt(s, d); return `<tr><td><b>${esc(s.label)} ${esc(s.short_ja || s.name_ja)}</b><span class="sub">${esc(s.district_ja || '')}</span></td><td class="n">${fmtPct(s.I)}</td><td class="n"><b>${fmtPct(c)}</b></td><td class="n">${fmtPct(st)}</td><td><span class="tag ${c >= 0.9 ? 'ok' : c >= 0.5 ? 'warn' : 'crit'}">${c >= 0.9 ? 'Normal operation' : c >= 0.5 ? 'Reduced' : 'Suspended / relocated'}</span></td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">No sites in this event</td></tr>'}</tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Supply chain nodes</h2><span class="r">${asmTag('Relationships assumed')}</span><span class="sub">Reopen day = base × (0.3 + 2 × exposure of the node's district). Safety stock covers supplier outages for the set number of days; a second source puts a floor under single-source nodes.</span></div><div class="tbl-wrap"><table class="sc-table"><thead><tr><th>Node</th><th>Kind</th><th class="n">Share</th><th>Availability now</th></tr></thead><tbody>${nodes.map((n) => { const day = ctx.nodeDay(n); const f = ctx.nodeAvail(n, d); return `<tr><td><b>${esc(n.name_ja.split('(')[0].trim())}</b>${n.single ? '<span class="sub" style="color:var(--crit)">single source</span>' : ''}</td><td><span class="tag neutral">${esc(n.kind)}</span></td><td class="n">${n.share != null ? fmtPct(n.share) : '—'}</td><td><span class="tag ${f >= 0.9 ? 'ok' : f >= 0.4 ? 'warn' : 'crit'}">${f >= 0.9 ? 'available' : `${Math.round(f * 100)}% · reopens ${fmtD(day)}`}</span></td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">No supply chain registered</td></tr>'}</tbody></table></div></div></div>`;
    } else {
      const dd = dists.find((x) => x.id === this.st.dist) || null; const rows = ctx.svcDist(d, dd);
      body = `<div class="card"><div class="card-h"><h2>Public services in ${esc(dd ? dd.name_ja.split('(')[0] : (sc.city_ja || 'the city'))}</h2><span class="r">${dists.length ? `<select id="rcDist" aria-label="District">${dists.map((x) => `<option value="${esc(x.id)}"${x.id === this.st.dist ? ' selected' : ''}>${esc(x.name_ja.split('(')[0])}</option>`).join('')}</select>` : ''}</span><span class="sub">What is back, what is still out, and the expected day. Expected days are model values; check the local authority and utility channels.</span></div>
        <div class="status-grid">${rows.map((x) => { const cls = x.frac >= 0.9 ? 'ok' : x.frac >= 0.4 ? 'warn' : 'crit'; return `<div class="st ${cls}"><div class="h">${ic(x.svc.icon || 'bolt')}${esc(x.svc.ja)}</div><div class="pct">${Math.round(x.frac * 100)}%</div><div class="track"><i style="width:${Math.round(x.frac * 100)}%;background:var(--${cls})"></i></div><div class="eta">${x.frac >= 0.9 ? 'Restored' : `Expected around ${fmtD(x.day)} (${fmtDays(x.day)})`}${x.svc.note ? ' · ' + esc(x.svc.note) : ''}</div></div>`; }).join('') || '<div class="empty">No services defined</div>'}</div></div>`;
    }
    const ms = (R.milestones || {})[persp] || []; const nMs = ms.length; const y = keepScroll ? window.scrollY : null;
    box.innerHTML = `${this.renderSim(sc, persp, p, cur, base, opts)}
      <div class="kpis">${kpis.map(kpiTileR).join('')}</div>
      <div class="grid map"><div class="card"><div class="card-h"><h2>Recovery indicators over time</h2><span class="r"><span class="tag neutral">${esc(fmtD(d))} · ${esc(ph.ja)}</span></span></div><div class="chart" id="rcChart"></div><div class="chart-cap">${pctInds.map((ind, si) => `<span><i class="ln" style="background:${ind.color || CAT[si % CAT.length]}"></i>${esc(ind.ja)}</span>`).join('')}<span><i class="ln" style="background:var(--fg2);opacity:.5"></i>dotted = baseline scenario</span></div>${R.note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(R.note_ja)}</span></div>` : ''}</div>
        <div class="stack"><div class="card"><div class="card-h"><h2>Milestones · ${esc(PERSP.find((x) => x[0] === persp)[2])}</h2><span class="r"><span class="tag neutral">${ms.filter((m) => m.d <= d).length}/${nMs} reached</span></span></div><div id="rcMs" class="${nMs > 9 ? 'collapsed-ms' : ''}">${msList(ms, d, sc)}</div>${nMs > 9 ? '<button class="btn sm" data-more="rcMs">Show more</button>' : ''}</div></div></div>
      ${body}
      <div class="grid c2"><div class="card"><div class="card-h"><h2>Checklist for this phase · ${esc(ph.ja)}</h2><span class="r"><span class="tag neutral">${esc(fmtD(ph.from_d || 0))} to ${esc(fmtD(ph.to_d || H))}</span></span><span class="sub">Tick items as they are done (saved on this device).</span></div>${checklist(R, persp, ph, root, sc)}</div>
        <div class="card"><div class="card-h"><h2>References and assumptions</h2></div><ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--fg2)">${(R.refs || []).map((r) => `<li>${r.url ? `<a class="cite" href="${esc(r.url)}" target="_blank" rel="noopener">${ic('link')}${esc(r.name)}</a>` : esc(r.name)}${r.confirmed_by ? ` <span class="tag ${r.confirmed_by === 'page_read' ? 'neutral' : 'warn'}">${esc(r.confirmed_by)}</span>` : ''}</li>`).join('') || '<li>No references listed</li>'}</ul>${(R.assumptions_ja || []).length ? `<div class="card-h" style="margin-top:12px"><h3>Assumptions</h3></div><ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--fg2)">${R.assumptions_ja.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div></div>`;
    if (chartSeries.length) lineChart($('#rcChart', root), { now: d, xMax: H, xTicks: xTicksFor(H), xFmt: (x) => fmtD(x), yLabel: 'Recovery indicators', series: chartSeries, yFmt: (v) => `${Math.round(v * 100)}%`, height: 230 });
    else $('#rcChart', root).innerHTML = '<div class="empty">No percentage indicators for this perspective</div>';
    const ds = $('#rcDist', root); if (ds) ds.onchange = (e) => { this.st.dist = e.target.value; this.renderPanel(root); };
    if (y != null) window.scrollTo({ top: y });
    if (window.updateScales) setTimeout(window.updateScales, 20);
  },
};
