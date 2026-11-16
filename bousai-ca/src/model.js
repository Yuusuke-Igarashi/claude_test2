/* Data model: regions, sites, personal plan and incident simulation (demo). Keeps sourced values and assumptions apart. */
const D = window.DATA || {};
/* Resolve a hazard level: region → country level → not retrieved (shared by the 3 screens) */
function hazardLevel(region, hzKey) {
  const th = HAZ[hzKey] ? HAZ[hzKey].th : hzKey;
  const v = region && region.hazards && region.hazards[th];
  if (v && v.level) return Object.assign({ scope: 'region' }, v);
  const c = D.regions && D.regions.countries && region && D.regions.countries[region.country];
  if (c && c.hazards && c.hazards[th] && c.hazards[th].level) return Object.assign({ scope: 'country' }, c.hazards[th]);
  return { level: 'unknown', scope: 'none' };
}
const M = {
  regions: () => (D.regions && D.regions.regions) || [],
  region: (id) => M.regions().find((r) => r.id === id) || M.regions()[0],
  sites: () => (D.sites && D.sites.sites) || [],
  site: (id) => M.sites().find((s) => s.id === id) || M.sites()[0],
  area: (id) => (D.areas && D.areas.areas || []).find((a) => a.area_id === id),
  country: (iso) => (D.contacts && D.contacts.countries || []).find((c) => c.iso3 === iso) || {},
  gem: (iso) => (D.gem && D.gem.countries[iso]) || null,
  scenarios: () => (D.scenarios && D.scenarios.scenarios) || [],
  scenario: (id) => M.scenarios().find((s) => s.id === id) || M.scenarios()[0],
  guidance: () => (D.guidance && D.guidance.items) || [],
  feeds: () => (D.feeds && D.feeds.feeds) || [],
};

/* ---------- Region: damage scale by return period (assumed model) ----------
 * Each region and hazard carries an "anchor" (a sourced past event or the GEM curve) and relative factors per return period,
 * from which affected population, downtime days and loss are derived. Everything is shown with an "assumption" label. */
const RPS = [10, 50, 100, 500, 1000];
function rpRows(region, hz) {
  const cfg = region.rp && region.rp[hz]; if (!cfg) return null;
  const gem = hz === 'quake' ? M.gem(region.country) : null;
  return RPS.map((rp) => {
    const k = cfg.k[String(rp)] ?? 0; /* 0..1 relative intensity (loss scales with k) */
    const kp = Math.pow(k, cfg.pop_exp ?? 2.5); /* affected population and downtime fall off steeply for small events (assumption) */
    const row = { rp, p: 1 / rp, scen: (cfg.scen && cfg.scen[String(rp)]) || '', depth: cfg.depth_max != null ? +(cfg.depth_max * k).toFixed(1) : null, area_pct: cfg.area_max != null ? Math.round(cfg.area_max * k) : null, pop: Math.round((region.pop_m || 0) * 1e6 * (cfg.pop_max || 0) * kp), downtime: Math.round((cfg.downtime_max || 0) * kp) };
    if (hz === 'quake' && gem) { const nat = gem.loss_curve_m[String(rp)] || 0; row.loss_nat = nat; row.loss = +(nat * (cfg.share || 0)).toFixed(1); row.loss_src = 'GEM'; }
    else row.loss = cfg.loss_max != null ? +(cfg.loss_max * k).toFixed(0) : null;
    return row;
  });
}

/* ---------- Site: preparedness assessment ---------- */
const PREP_CATS = [
  { key: 'info', label: 'Information & alerts', note: 'Channels for receiving warnings; monitoring local authorities and embassy advisories', w: 1.0 },
  { key: 'evac', label: 'Evacuation plan', note: 'Designated shelters and evacuation routes, decision criteria per scenario, drills', w: 1.2 },
  { key: 'safety', label: 'Safety confirmation', note: 'Safety confirmation system; contact tree including families', w: 1.2 },
  { key: 'stock', label: 'Stockpile', note: 'Water, food, medicines, hygiene supplies (staff × 3-7 days)', w: 1.0 },
  { key: 'power', label: 'Power & communications', note: 'Backup power, fuel, satellite phones and radios', w: 0.9 },
  { key: 'bcp', label: 'BCP & alternatives', note: 'RTO for critical operations, alternate site, off-site data backup, coordination with business partners', w: 1.1 },
  { key: 'people', label: 'Vulnerable people & families', note: 'Identify and support expatriate families, the injured, pregnant staff and people with chronic conditions', w: 0.8 },
  { key: 'facility', label: 'Building & equipment', note: 'Seismic resistance, flood barriers, raised equipment, hazardous-materials control', w: 1.0 },
];
function siteScore(site) {
  const cats = PREP_CATS.map((c) => {
    const items = (site.prep && site.prep[c.key]) || [];
    const got = sum(items, (it) => it.s === 1 ? 1 : it.s === 0.5 ? 0.5 : 0); const max = items.length || 1;
    return Object.assign({}, c, { items, score: Math.round(got / max * 100), got, max });
  });
  const total = Math.round(sum(cats, (c) => c.score * c.w) / sum(cats, (c) => c.w));
  const gaps = cats.flatMap((c) => c.items.filter((it) => it.s !== 1).map((it) => Object.assign({ cat: c.label, catKey: c.key }, it))).sort((a, b) => (a.pri || 3) - (b.pri || 3));
  return { total, cats, gaps };
}

/* ---------- Personal: stockpile quantities and evacuation constraints ---------- */
function personalPlan(f) {
  const n = f.members.length; const days = f.days || 7;
  const infants = f.members.filter((m) => m.age <= 2).length, kids = f.members.filter((m) => m.age > 2 && m.age < 12).length, elders = f.members.filter((m) => m.age >= 65).length;
  const women = f.members.filter((m) => m.sex === 'f' && m.age >= 12 && m.age <= 55).length;
  const needs = f.members.filter((m) => m.cond).length;
  const water = Math.round(n * 3 * days); /* 3 L/person/day: Sphere minimum for drinking water (Ready.gov: about 1 gallon per person per day incl. hygiene) */
  const meals = n * 3 * days;
  const items = [
    { k: 'Drinking water', v: `${water}<small>L</small>`, why: `3 L × ${n} people × ${days} days (Sphere minimum for drinking; Ready.gov: about 1 gallon/person/day incl. hygiene)`, src: 'readygov' },
    { k: 'Food', v: `${meals}<small>meals</small>`, why: `3 meals × ${n} people × ${days} days; mainly items that need no cooking`, src: 'readygov' },
    { k: 'Oral rehydration salts', v: `${Math.max(1, Math.ceil(n * days / 3))}<small>sachets</small>`, why: 'Dehydration risk in extreme summer heat (assumption)', asm: true },
    { k: 'Regular medicines', v: `${Math.max(7, days)}<small>days</small>`, why: `Keep a list of prescription drugs by generic (INN) name. ${needs} member(s) with a chronic condition. Days follow the stockpile period (assumption)`, asm: true },
    { k: 'Cash (local currency)', v: `${n * 100}<small>USD equiv.</small>`, why: 'Assumes card and QR payments fail during power outages (assumption)', asm: true },
    { k: 'Power banks', v: `${Math.max(1, Math.ceil(n / 2))}<small>units</small>`, why: 'Rule of thumb: one unit covers 2 people for 3 days (assumption)', asm: true },
  ];
  if (infants) items.push({ k: 'Infant formula & diapers', v: `${infants}<small>infant(s) × ${days} days</small>`, why: 'Assumes ready-to-feed liquid formula is hard to find locally', asm: true });
  if (women) items.push({ k: 'Menstrual hygiene products', v: `${women}<small>person(s) × 1 cycle</small>`, why: 'Often overlooked in relief supplies', src: 'sphere' });
  if (elders) items.push({ k: 'Supplies for older adults', v: `${elders}<small>person(s)</small>`, why: 'Glasses, dentures, cane, incontinence pads; a way to get around when elevators stop', src: 'readygov' });
  if (f.pets) items.push({ k: 'Pet supplies', v: `${days}<small>days</small>`, why: 'Most shelters do not accept pets; arrange a place for them in advance', asm: true });
  items.push({ k: 'Copies of documents', v: '1<small>set</small>', why: 'Passport, visa, work permit, insurance card, proof of embassy registration (paper and cloud)', src: 'embassy' });
  items.push({ k: 'N95/KF94 masks', v: `${n * 5}<small>pcs</small>`, why: 'Winter smog (PM2.5), wildfire smoke and dust storms. Quantity is an assumption', asm: true });
  /* Suitability constraints for evacuation destinations */
  const cons = [];
  /* Walking limit: derive the distance from minutes × speed (keeps display and calculation consistent) */
  const walkCap = (min, speed) => Math.round(min * speed * 1000 / 60);
  if (elders || needs) cons.push({ k: 'walk', ja: 'Within a 15-min walk at 3 km/h (older adults or people needing assistance)', maxWalk: walkCap(15, 3.0), speed: 3.0 });
  else if (infants || kids) cons.push({ k: 'walk', ja: 'Within a 25-min walk at 3.5 km/h (with children)', maxWalk: walkCap(25, 3.5), speed: 3.5 });
  else cons.push({ k: 'walk', ja: 'Within a 35-min walk at 4 km/h', maxWalk: walkCap(35, 4.0), speed: 4.0 });
  if (f.home === 'highrise' && f.floor >= 4) cons.push({ k: 'vertical', ja: `In a flood, staying in your home (floor ${f.floor}) is the first option (vertical evacuation), but prepare for power, water and elevator outages` });
  if (f.home === 'lowrise' || f.home === 'house') cons.push({ k: 'horizontal', ja: 'In a flood, move early to a high-rise building or higher ground (horizontal evacuation); moving through floodwater is dangerous' });
  if (f.car) cons.push({ k: 'car', ja: 'Cars stall in about 30 cm of water (FEMA); evacuate by car only before the water arrives' });
  return { n, days, infants, kids, elders, women, needs, water, meals, items, cons };
}

/* ---------- Incident simulation (demo) ----------
 * t: hours since onset. Returns each district's damage-intensity curve plus the response curves for safety confirmation, shelters, supplies and utilities. */
const S = (x) => 1 / (1 + Math.exp(-x)); /* logistic */
function floodCurve(t, peak, dur) { /* 0→1→0: peaks at peak, fades out over dur */
  if (t <= 0) return 0; if (t <= peak) return S((t / peak) * 8 - 4) / S(4); const r = (t - peak) / dur; return Math.max(0, 1 - r * r);
}
function sim(sc, t) {
  const type = sc.type; const out = { t, districts: [], sites: [], shelters: [], supplies: [], util: {}, kpi: {}, log: [] };
  /* Intensity per district I(t) 0..1 */
  out.districts = sc.districts.map((d) => {
    let I; if (type === 'flood') I = floodCurve(t - (d.onset_h || 0), d.peak_h || 48, d.recede_h || 120) * (d.exposure || 0); else I = (t >= 0 ? 1 : 0) * (d.exposure || 0) * (1 - 0.15 * Math.min(1, t / 168)); /* earthquake: immediate, then a slight decline (rescue, demolition) */
    const depth = type === 'flood' ? +(I * (sc.depth_max || 2)).toFixed(2) : null;
    const affected = Math.round(d.pop * (type === 'flood' ? clamp(I * 1.1, 0, 0.95) : clamp(I * 0.7, 0, 0.8)));
    const evac = Math.round(affected * (type === 'flood' ? 0.22 : 0.15) * (type === 'quake' ? S((t - 6) / 6) : 1));
    const jp = Math.round((d.jp || 0) * clamp(I * 1.1, 0, 0.95));
    const vuln = Math.round(affected * 0.14);
    /* Deaths and injuries: rise from 0 as confirmed figures (earthquake: 90% within 3 days; flood: accumulates over weeks to months) */
    const deadFinal = type === 'quake' ? d.pop * (d.exposure || 0) * (sc.fatality_rate || 0.002) : affected * 0.0002;
    const dead = Math.round(deadFinal * (type === 'quake' ? (t <= 0 ? 0 : 1 - Math.exp(-t / 18)) : (t <= 0 ? 0 : 1 - Math.exp(-t / 400))));
    const inj = type === 'quake' ? Math.round(dead * 3.3) : Math.round(affected * 0.001 * (t <= 0 ? 0 : 1 - Math.exp(-t / 120)));
    return Object.assign({}, d, { I, depth, affected, evac, jp, vuln, dead, inj, deadFinal: Math.round(deadFinal) });
  });
  /* Sites */
  out.sites = (sc.sites || []).map((s) => {
    const d = out.districts.find((x) => x.id === s.district) || { I: 0 }; const I = d.I * (s.exposure_mult || 1);
    const resp = clamp(1 - Math.exp(-Math.max(0, t) / (s.resp_tau || 6)), 0, 0.985) * (t >= 0 ? 1 : 0);
    const status = I > 0.6 ? 'crit' : I > 0.25 ? 'warn' : 'ok';
    const op = I > 0.6 ? 'Down' : I > 0.25 ? 'Degraded' : t >= 0 && I > 0.05 ? 'Partly affected' : 'Operating';
    return Object.assign({}, s, { I, status, op, resp, confirmed: Math.round(s.staff * resp), unconfirmed: s.staff - Math.round(s.staff * resp) });
  });
  /* Shelters */
  const totalEvac = sum(out.districts, (d) => d.evac);
  out.shelters = (sc.shelters || []).map((sh) => { const d = out.districts.find((x) => x.id === sh.district) || { evac: 0 }; const open = t >= (sh.open_h || 0); const demand = Math.round(d.evac * (sh.share || 0.3)); const occ = open ? Math.min(Math.round(sh.cap * 1.25), demand) : 0; return Object.assign({}, sh, { occ, demand, over: Math.max(0, occ - sh.cap), rate: occ / sh.cap, open }); });
  /* Supply and demand: demand = evacuees × unit, supply = arrival curve */
  out.supplies = (sc.supplies || []).map((it) => {
    const need = Math.round(totalEvac * it.per_person * (it.per_day ? Math.max(1, Math.ceil(Math.max(0, t) / 24)) : 1) + (it.base || 0));
    const got = Math.round(need * clamp(S((t - it.lead_h) / (it.ramp_h || 12)) * (it.cap || 1), 0, 1.2) + (it.stock || 0));
    return Object.assign({}, it, { need, got, rate: need ? got / need : 1 });
  });
  /* Utilities (population-weighted region average and per district) */
  const utilDef = sc.utilities || [];
  /* Recovery rate is a normalized logistic rising continuously from 0 (earthquake: centred on rest_h after onset / flood: from rest_h after the peak) */
  const rise = (x, x0) => { const s0 = S(x0); return clamp((S(x) - s0) / (1 - s0), 0, 1); };
  out.util = utilDef.map((u) => {
    const per = out.districts.map((d) => { const outage = type === 'flood' ? clamp((d.depth || 0) / (u.th_m || 0.3), 0, 1) : clamp(d.I * (u.q_mult || 1), 0, 1); const tau = u.rest_tau || 24; let rest; if (type === 'flood') { const tr = (d.peak_h || 0) + (u.rest_h || 24); rest = t > tr ? rise((t - tr) / tau, 0) : 0; } else { const x0 = (0 - (u.rest_h || 24)) / tau; rest = t <= 0 ? 0 : rise((t - (u.rest_h || 24)) / tau, x0); } return { id: d.id, avail: clamp(1 - outage * (1 - rest), 0, 1) }; });
    const pop = sum(out.districts, (d) => d.pop); const avail = sum(out.districts, (d, i) => d.pop * per[i].avail) / pop;
    return Object.assign({}, u, { avail, per: by(per, 'id') });
  });
  /* KPI */
  out.kpi = { affected: sum(out.districts, (d) => d.affected), evac: totalEvac, jp: sum(out.districts, (d) => d.jp), dead: sum(out.districts, (d) => d.dead), deadFinal: sum(out.districts, (d) => d.deadFinal), inj: sum(out.districts, (d) => d.inj), vuln: sum(out.districts, (d) => d.vuln), staff: sum(out.sites, (s) => s.staff), confirmed: sum(out.sites, (s) => s.confirmed), sitesDown: out.sites.filter((s) => s.status === 'crit').length, shelterOcc: sum(out.shelters, (s) => s.occ), shelterCap: sum(out.shelters.filter((s) => s.open), (s) => s.cap), shelterOver: sum(out.shelters, (s) => s.over), fulfil: out.supplies.length ? sum(out.supplies, (s) => Math.min(1, s.rate)) / out.supplies.length : 1 };
  out.log = (sc.timeline || []).filter((e) => e.t <= t);
  out.upcoming = (sc.timeline || []).filter((e) => e.t > t).slice(0, 3);
  return out;
}
/* Time series (for charts) */
function simSeries(sc, key, step = 6, xMax = 168) { const v = []; for (let t = 0; t <= xMax; t += step) { const r = sim(sc, t); v.push([t, typeof key === 'function' ? key(r) : r.kpi[key]]); } return v; }
