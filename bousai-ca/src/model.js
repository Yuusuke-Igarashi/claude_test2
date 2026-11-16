/* データモデル：地域・拠点・個人・発災シミュレーション（デモ）。出典付きの値と仮定値を区別して保持する。 */
const D = window.DATA || {};
/* ハザード水準の解決：地域 → 国レベル → 未取得（3 画面で共用） */
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

/* ---------- 地域：確率年別の被害規模（仮定モデル） ----------
 * 各地域・各ハザードに「アンカー」（出典のある過去事象や GEM 曲線）と、再現期間ごとの相対係数を持たせ、
 * 影響人口・操業停止日数・損失を算出する。すべて「仮定」ラベルで表示する。 */
const RPS = [10, 50, 100, 500, 1000];
function rpRows(region, hz) {
  const cfg = region.rp && region.rp[hz]; if (!cfg) return null;
  const gem = hz === 'quake' ? M.gem(region.country) : null;
  return RPS.map((rp) => {
    const k = cfg.k[String(rp)] ?? 0; /* 0..1 相対強度（損失は k に比例） */
    const kp = Math.pow(k, cfg.pop_exp ?? 2.5); /* 影響人口・操業停止は小さな事象で急減する（仮定） */
    const row = { rp, p: 1 / rp, scen: (cfg.scen && cfg.scen[String(rp)]) || '', depth: cfg.depth_max != null ? +(cfg.depth_max * k).toFixed(1) : null, area_pct: cfg.area_max != null ? Math.round(cfg.area_max * k) : null, pop: Math.round((region.pop_m || 0) * 1e6 * (cfg.pop_max || 0) * kp), downtime: Math.round((cfg.downtime_max || 0) * kp) };
    if (hz === 'quake' && gem) { const nat = gem.loss_curve_m[String(rp)] || 0; row.loss_nat = nat; row.loss = +(nat * (cfg.share || 0)).toFixed(1); row.loss_src = 'GEM'; }
    else row.loss = cfg.loss_max != null ? +(cfg.loss_max * k).toFixed(0) : null;
    return row;
  });
}

/* ---------- 拠点：備えの評価 ---------- */
const PREP_CATS = [
  { key: 'info', label: '情報・警報', note: '警報の受信手段、現地当局・大使館情報の監視', w: 1.0 },
  { key: 'evac', label: '避難計画', note: '避難所・避難路の指定、シナリオ別の判断基準、訓練', w: 1.2 },
  { key: 'safety', label: '安否確認', note: '安否確認システム、家族を含む連絡網', w: 1.2 },
  { key: 'stock', label: '備蓄', note: '水・食料・医薬品・衛生用品（従業員×3〜7日）', w: 1.0 },
  { key: 'power', label: '電源・通信', note: '非常用電源、燃料、衛星電話・無線', w: 0.9 },
  { key: 'bcp', label: 'BCP・代替', note: '重要業務の RTO、代替拠点、データ退避、取引先連携', w: 1.1 },
  { key: 'people', label: '要配慮・家族', note: '駐在員家族・負傷者・妊婦・持病の把握と支援', w: 0.8 },
  { key: 'facility', label: '建物・設備', note: '耐震・止水板・設備の嵩上げ・危険物管理', w: 1.0 },
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

/* ---------- 個人：備蓄量と避難条件 ---------- */
function personalPlan(f) {
  const n = f.members.length; const days = f.days || 7;
  const infants = f.members.filter((m) => m.age <= 2).length, kids = f.members.filter((m) => m.age > 2 && m.age < 12).length, elders = f.members.filter((m) => m.age >= 65).length;
  const women = f.members.filter((m) => m.sex === 'f' && m.age >= 12 && m.age <= 55).length;
  const needs = f.members.filter((m) => m.cond).length;
  const water = Math.round(n * 3 * days); /* 3L/人/日（内閣府）*/
  const meals = n * 3 * days;
  const items = [
    { k: '飲料水', v: `${water}<small>L</small>`, why: `3L×${n}人×${days}日（内閣府の目安）`, src: 'naikakufu' },
    { k: '食料', v: `${meals}<small>食</small>`, why: `3食×${n}人×${days}日。火を使わず食べられるもの中心`, src: 'naikakufu' },
    { k: '経口補水・塩分', v: `${Math.max(1, Math.ceil(n * days / 3))}<small>袋</small>`, why: '高温多湿環境での脱水対策（仮定）', asm: true },
    { k: '常備薬', v: `${Math.max(7, days)}<small>日分</small>`, why: `処方薬は薬名を英語でメモ。持病${needs}名。日数は備蓄日数に合わせた仮定`, asm: true },
    { k: '現金（現地通貨）', v: `${n * 100}<small>USD相当</small>`, why: '停電時はカード・QR決済が使えない前提（仮定）', asm: true },
    { k: 'モバイル電源', v: `${Math.max(1, Math.ceil(n / 2))}<small>台</small>`, why: '1台で2人×3日を目安（仮定）', asm: true },
  ];
  if (infants) items.push({ k: '粉ミルク・おむつ', v: `${infants}<small>人分×${days}日</small>`, why: '液体ミルクは現地で入手しにくい前提', asm: true });
  if (women) items.push({ k: '生理用品', v: `${women}<small>人分×1周期</small>`, why: '支援物資で後回しになりやすい', src: 'sphere' });
  if (elders) items.push({ k: '高齢者用品', v: `${elders}<small>人分</small>`, why: '眼鏡・入れ歯・杖・紙パンツ、エレベーター停止時の移動手段', src: 'naikakufu' });
  if (f.pets) items.push({ k: 'ペット用', v: `${days}<small>日分</small>`, why: '多くの避難所は同伴不可。預け先を事前に決める', asm: true });
  items.push({ k: '書類の写し', v: '1<small>式</small>', why: 'パスポート・ビザ・労働許可・保険証・在留届控え（紙とクラウド）', src: 'mofa' });
  items.push({ k: 'N95/KF94 マスク', v: `${n * 5}<small>枚</small>`, why: '煙霧（PM2.5）・火山灰・粉じん対策。枚数は仮定', asm: true });
  /* 避難先の適合条件 */
  const cons = [];
  /* 徒歩の上限：分数 × 速度から距離を導く（表示と計算を一致させる） */
  const walkCap = (min, speed) => Math.round(min * speed * 1000 / 60);
  if (elders || needs) cons.push({ k: 'walk', ja: '徒歩 15 分以内・時速 3 km（高齢者・要配慮者あり）', maxWalk: walkCap(15, 3.0), speed: 3.0 });
  else if (infants || kids) cons.push({ k: 'walk', ja: '徒歩 25 分以内・時速 3.5 km（子ども連れ）', maxWalk: walkCap(25, 3.5), speed: 3.5 });
  else cons.push({ k: 'walk', ja: '徒歩 35 分以内・時速 4 km', maxWalk: walkCap(35, 4.0), speed: 4.0 });
  if (f.home === 'highrise' && f.floor >= 4) cons.push({ k: 'vertical', ja: `洪水時は自室（${f.floor}階）に留まる「垂直避難」が第一候補。ただし電気・水・エレベーター停止に備える` });
  if (f.home === 'lowrise' || f.home === 'house') cons.push({ k: 'horizontal', ja: '洪水時は早めに高層建物・高台へ「水平避難」。浸水後の移動は危険' });
  if (f.car) cons.push({ k: 'car', ja: '車は冠水 30cm で動かなくなる（FEMA）。洪水時の車避難は水が来る前だけ' });
  return { n, days, infants, kids, elders, women, needs, water, meals, items, cons };
}

/* ---------- 発災シミュレーション（デモ） ----------
 * t: 発災からの経過時間（時間）。各区の「被害強度」曲線と、安否確認・避難所・物資・ライフラインの応答曲線を返す。 */
const S = (x) => 1 / (1 + Math.exp(-x)); /* ロジスティック */
function floodCurve(t, peak, dur) { /* 0→1→0：ピーク peak、収束 dur */
  if (t <= 0) return 0; if (t <= peak) return S((t / peak) * 8 - 4) / S(4); const r = (t - peak) / dur; return Math.max(0, 1 - r * r);
}
function sim(sc, t) {
  const type = sc.type; const out = { t, districts: [], sites: [], shelters: [], supplies: [], util: {}, kpi: {}, log: [] };
  /* 区ごとの強度 I(t) 0..1 */
  out.districts = sc.districts.map((d) => {
    let I; if (type === 'flood') I = floodCurve(t - (d.onset_h || 0), d.peak_h || 48, d.recede_h || 120) * (d.exposure || 0); else I = (t >= 0 ? 1 : 0) * (d.exposure || 0) * (1 - 0.15 * Math.min(1, t / 168)); /* 地震：即時、以後わずかに低減（救助・解体） */
    const depth = type === 'flood' ? +(I * (sc.depth_max || 2)).toFixed(2) : null;
    const affected = Math.round(d.pop * (type === 'flood' ? clamp(I * 1.1, 0, 0.95) : clamp(I * 0.7, 0, 0.8)));
    const evac = Math.round(affected * (type === 'flood' ? 0.22 : 0.15) * (type === 'quake' ? S((t - 6) / 6) : 1));
    const jp = Math.round((d.jp || 0) * clamp(I * 1.1, 0, 0.95));
    const vuln = Math.round(affected * 0.14);
    /* 死者・負傷：確認済みの値として 0 から立ち上がる（地震は 3 日で 9 割、洪水は週〜月単位で累積） */
    const deadFinal = type === 'quake' ? d.pop * (d.exposure || 0) * (sc.fatality_rate || 0.002) : affected * 0.0002;
    const dead = Math.round(deadFinal * (type === 'quake' ? (t <= 0 ? 0 : 1 - Math.exp(-t / 18)) : (t <= 0 ? 0 : 1 - Math.exp(-t / 400))));
    const inj = type === 'quake' ? Math.round(dead * 3.3) : Math.round(affected * 0.001 * (t <= 0 ? 0 : 1 - Math.exp(-t / 120)));
    return Object.assign({}, d, { I, depth, affected, evac, jp, vuln, dead, inj, deadFinal: Math.round(deadFinal) });
  });
  /* 拠点 */
  out.sites = (sc.sites || []).map((s) => {
    const d = out.districts.find((x) => x.id === s.district) || { I: 0 }; const I = d.I * (s.exposure_mult || 1);
    const resp = clamp(1 - Math.exp(-Math.max(0, t) / (s.resp_tau || 6)), 0, 0.985) * (t >= 0 ? 1 : 0);
    const status = I > 0.6 ? 'crit' : I > 0.25 ? 'warn' : 'ok';
    const op = I > 0.6 ? '停止' : I > 0.25 ? '縮退' : t >= 0 && I > 0.05 ? '一部影響' : '稼働';
    return Object.assign({}, s, { I, status, op, resp, confirmed: Math.round(s.staff * resp), unconfirmed: s.staff - Math.round(s.staff * resp) });
  });
  /* 避難所 */
  const totalEvac = sum(out.districts, (d) => d.evac);
  out.shelters = (sc.shelters || []).map((sh) => { const d = out.districts.find((x) => x.id === sh.district) || { evac: 0 }; const open = t >= (sh.open_h || 0); const demand = Math.round(d.evac * (sh.share || 0.3)); const occ = open ? Math.min(Math.round(sh.cap * 1.25), demand) : 0; return Object.assign({}, sh, { occ, demand, over: Math.max(0, occ - sh.cap), rate: occ / sh.cap, open }); });
  /* 物資需給：需要＝避難者×単位、供給＝到着曲線 */
  out.supplies = (sc.supplies || []).map((it) => {
    const need = Math.round(totalEvac * it.per_person * (it.per_day ? Math.max(1, Math.ceil(Math.max(0, t) / 24)) : 1) + (it.base || 0));
    const got = Math.round(need * clamp(S((t - it.lead_h) / (it.ramp_h || 12)) * (it.cap || 1), 0, 1.2) + (it.stock || 0));
    return Object.assign({}, it, { need, got, rate: need ? got / need : 1 });
  });
  /* ライフライン（地域平均と区別） */
  const utilDef = sc.utilities || [];
  /* 復旧率は 0 から連続に立ち上がる正規化ロジスティック（地震：発災後 rest_h を中心に／洪水：ピーク後 rest_h から） */
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
/* 時系列（グラフ用） */
function simSeries(sc, key, step = 6, xMax = 168) { const v = []; for (let t = 0; t <= xMax; t += step) { const r = sim(sc, t); v.push([t, typeof key === 'function' ? key(r) : r.kpi[key]]); } return v; }
