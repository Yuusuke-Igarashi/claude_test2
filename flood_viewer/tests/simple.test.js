// Browser tests for the simple viewer (road links + XRAIN only): dist/flood_viewer_simple_standalone.html.
// Prerequisites: `npm run data` (sample files in sample/output) and `npm run build`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, createReadStream, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildSimple, TARGET } from "../build_simple.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "sample", "output");
const SHOTS = join(here, "shots");
const HTML = "flood_viewer_simple_standalone.html";
const T_18 = 24; // 18:00 + 24 * 15 min = 00:00 (the sample axis crosses midnight)
const REQUIRED = ["tokyo_20240821_network.geojson", "baseline_speed.csv", "event_speed.csv", "baseline_count.csv", "event_count.csv"];
// a wet cell of the synthetic rain at the 00:30 slot (index 26), see sample/make_rain.py
const WET = [139.70 + 0.1 * (0.2 + 0.6 * 26 / 47), 35.71 - 0.06 * (0.5 + 0.15 * Math.sin(26 / 6))];

let server, base, browser;
const errors = [];
// expected noise: basemap tiles offline, optional files absent (404), file:// fetch fallback (CORS or "URL scheme not supported")
const NOISE = /gsi\.go\.jp|ERR_TUNNEL|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|404|CORS|ERR_FAILED|fetch failed|Fetch API cannot load|URL scheme "file"|is_target/;

// Independent reference: count error cells per time column straight from error.csv (values = level 0..3,
// only links with an error). level 0 = any level; 1..3 = exactly that level.
function errorCountsFromCsv(level = 0) {
  const lines = readFileSync(join(DATA, "error.csv"), "utf8").trim().split(/\r?\n/);
  const T = lines[0].split(",").length - 1;
  const counts = new Array(T).fill(0);
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    for (let c = 0; c < T; c++) { const v = parseInt(cells[c + 1], 10); if (level ? v === level : v >= 1) counts[c]++; }
  }
  return counts;
}

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".csv": "text/csv", ".geojson": "application/geo+json", ".json": "application/json", ".tif": "image/tiff" };
  return createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("?")[0].replace(/^\//, "")) || HTML;
    if (name.includes("..")) { res.writeHead(400); res.end(); return; }
    for (const dir of [DIST, DATA]) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) {
        res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
        createReadStream(p).pipe(res);
        return;
      }
    }
    res.writeHead(404); res.end("not found");
  });
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { const t = m.text(); if (NOISE.test(t)) return; if (m.type() === "error") errors.push("console.error: " + t); });
  return page;
}
async function openViewer() {
  const page = await newPage();
  await page.goto(`${base}/${HTML}`);
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  await page.waitForTimeout(500);
  return page;
}
async function openPicker() {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  return page;
}
const status = (page) => page.evaluate(() => ({
  time: document.getElementById("timeLabel").textContent,
  target: +document.getElementById("stTarget").textContent.replace(/,/g, ""),
  error: +document.getElementById("stError").textContent.replace(/,/g, ""),
  levels: [1, 2, 3].map((l) => +document.getElementById("stL" + l).textContent.replace(/,/g, "")),
}));
// nearest link of class `cls` to the viewport centre (screen coords)
const findLink = (page, cls, t) => page.evaluate(([cls, t]) => {
  const T = S.T, c0 = map.getCenter(); let best = null;
  for (let r = 0; r < S.ids.length; r++) {
    if (S.cls[r * T + t] !== cls || S.fids[r] < 0) continue;   // cls: 0 other, 1 target, 2/3/4 = error level 1/2/3
    const c = S.gj.features[S.fids[r]].geometry.coordinates;
    const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    if (!map.getBounds().contains(mid)) continue;
    const d = Math.hypot(mid[0] - c0.lng, mid[1] - c0.lat);
    if (!best || d < best.d) { const p = map.project(mid); best = { d, id: S.gj.features[S.fids[r]].properties.id, x: p.x, y: p.y }; }
  }
  return best;
}, [cls, t]);
async function hover(page, pt) {
  const box = await page.locator("#map").boundingBox();
  await page.mouse.move(box.x + pt.x - 3, box.y + pt.y - 3); await page.waitForTimeout(150);
  await page.mouse.move(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(400);
}

before(async () => {
  for (const f of [...REQUIRED, "error.csv"]) assert.ok(existsSync(join(DATA, f)), `missing sample file ${f} (run: npm run data)`);
  assert.ok(existsSync(join(DATA, "error_geojson", "error_L1_20240821_1800.geojson")), "missing sample error_geojson/ (run: npm run data)");
  assert.ok(existsSync(join(DIST, HTML)), `missing dist/${HTML} (run: npm run build)`);
  mkdirSync(SHOTS, { recursive: true });
  server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch);
});
after(async () => { await browser?.close(); server?.close(); });

test("flood_viewer_simple.html is the build of its template and flood_viewer.html, without the full viewer's tabs and overlays", () => {
  assert.equal(readFileSync(TARGET, "utf8"), buildSimple(), "flood_viewer_simple.html is stale: run npm run build and commit it");
  const html = readFileSync(join(DIST, HTML), "utf8");
  for (const id of ["modeTraj", "modeGrid", "probeInput", "gridInput", "kadenInput", "snsInput", "kadenOpt", "snsOpt", "gridOpts", "trajOpts", "snsCallout"]) assert.doesNotMatch(html, new RegExp(` id="${id}"`), id);
  for (const fn of ["updateTraj", "updateKaden", "updateSns", "updateGrid", "setMode", "parseSns", "parseKaden", "parseTraj", "alignAxisToPeriod"]) assert.doesNotMatch(html, new RegExp(`function ${fn}\\(`), fn);
  for (const fn of ["parseMatrix", "recompute", "parseGeoTiff", "paintRain", "updateRain", "drawChart", "showChart", "periodSpan"]) assert.match(html, new RegExp(`\\nfunction ${fn}\\(`), fn + " copied from the full viewer");
  assert.match(html, /GENERATED FILE/);
});

test("loads over http: the thresholds reproduce error.csv, the axis is the CSV order dated by the network file name, only the link and rain layers", async () => {
  const page = await openViewer();
  const info = await page.evaluate(() => ({ N: S.ids.length, T: S.T, check: $("pCheck").textContent, title: document.querySelector("#topbar h1").textContent, docTitle: document.title,
    layers: map.getStyle().layers.map((l) => l.id), axis: [S.axisStart, S.axisDate, S.axisSource], label: $("timeLabel").textContent, adj: S.adjPrev[24], stat: getComputedStyle($("statTraffic")).display,
    inputs: [$("axisDate").value, $("axisStart").value, $("axisStart").options.length], nb: S.nbParams, slot: [slotMin(), $("pSlot1").textContent, $("pSlot2").textContent, $("roL2").textContent] }));
  assert.equal(info.T, 48);
  assert.ok(info.N > 1000);
  assert.match(info.check, /不一致: 0 セル/, "in-page error computation must match error.csv at default thresholds");
  assert.match(info.check, /レベル 0〜3 で照合/);
  assert.deepEqual(info.axis, ["18:00", "20240821", "viewer.json"], "period from viewer.json (tomtom_run.ipynb)");
  assert.deepEqual(info.nb, { minCount: 2.5, minSpeed: 10, corrob: true, levels: [{ speed: 0.75, count: 0.75, op: "or" }, { speed: 0.6, count: 0.6, op: "or" }, { speed: 0.5, count: 0.5, op: "or" }] }, "thresholds of viewer.json are the defaults");
  assert.deepEqual(info.slot, [15, "15", "15", "台数 /窓"], "window length from the CSV columns in the ⚙ labels");
  assert.equal(info.title, "冠水候補 2024-08-21 18:00〜08-22 06:00", "title from the axis: 48 slots of 15 min from the start"); assert.equal(info.docTitle, info.title);
  assert.equal(info.label, "08-21 18:00", "time label carries the slot's date");
  assert.deepEqual(info.inputs, ["2024-08-21", "18:00", 48]);
  assert.deepEqual(info.layers, ["base", "rain", "links-base", "links-error", "links-hover", "links-hit"]);
  assert.equal(info.adj, 1, "23:45 -> 00:00 counts as consecutive"); assert.notEqual(info.stat, "none");
  const ref = errorCountsFromCsv(), refL = [1, 2, 3].map((l) => errorCountsFromCsv(l));
  for (const t of [0, T_18, 47]) {
    await page.evaluate((t) => applyTime(t), t);
    const st = await status(page);
    assert.equal(st.error, ref[t], `error count at t=${t} matches error.csv`);
    assert.deepEqual(st.levels, refL.map((c) => c[t]), `per-level counts at t=${t} match error.csv`);
  }
  assert.equal((await status(page)).time, "08-22 05:45", "after midnight the label shows the next day");
  assert.ok(refL[0][T_18] > 0 && refL[2][T_18] > 0, "sample has level-1 and level-3 errors at 00:00");
  await page.evaluate((t) => applyTime(t), T_18);
  await page.screenshot({ path: join(SHOTS, "simple_traffic.png") });
  await page.close();
});

test("slider, play and keyboard change the time", async () => {
  const page = await openViewer();
  await page.locator("#slider").fill(String(T_18));
  assert.equal((await status(page)).time, "08-22 00:00");
  await page.mouse.move(700, 450);
  await page.keyboard.press("ArrowRight");
  assert.equal((await status(page)).time, "08-22 00:15");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await status(page)).time, "08-22 00:00");
  await page.keyboard.press("Space"); await page.waitForTimeout(1500); await page.keyboard.press("Space");
  const after = await page.evaluate(() => ({ t: S.t, playing: S.playing, btn: $("playBtn").textContent }));
  assert.ok(after.t > T_18 + 1, "playback advanced"); assert.equal(after.playing, false); assert.equal(after.btn, "▶ 再生");
  await page.close();
});

test("time axis: the start column rotates the CSV columns, the date gives the slot dates, both editable", async () => {
  const page = await openViewer();
  const ref = errorCountsFromCsv();
  // a whole-day CSV built for a period starting at 12:00 is the real case; the sample (18:00 … 05:45) is rotated to 00:00 here
  await page.selectOption("#axisStart", "00:00"); await page.waitForTimeout(300);
  const rot = await page.evaluate(() => ({ times: [S.times[0], S.times[23], S.times[24], S.times[47]], adj: [S.adjPrev[0], S.adjPrev[1], S.adjPrev[24], S.adjPrev[25]], title: document.title,
    label: $("timeLabel").textContent, t: S.t, check: $("pCheck").textContent, orig: S.orig.times[0], copy: S.bs !== S.orig.bs }));
  assert.deepEqual(rot.times, ["00:00", "05:45", "18:00", "23:45"], "the columns before the start follow after the wrap of the clock");
  assert.deepEqual(rot.adj, [0, 1, 0, 1], "05:45 -> 18:00 is not consecutive, 18:00 -> 18:15 is");
  assert.equal(rot.title, "冠水候補 2024-08-21 00:00〜08-21 12:00");
  assert.deepEqual([rot.t, rot.label], [24, "08-21 18:00"], "the clock time on screen is kept (18:00 moved to slot 24, same day: the clock did not wrap)");
  // error.csv is reordered the same way, but the ends of the axis moved: 23:45 -> 00:00 is no longer consecutive, so cells the
  // notebook confirmed only across that boundary (it used the CSV order) differ; everything away from the ends still matches
  assert.match(rot.check, /不一致: [1-9]\d* セル/, "cross-check reports the boundary cells: " + rot.check);
  assert.equal(rot.orig, "18:00", "the CSV order is kept aside"); assert.equal(rot.copy, true);
  for (const [t, c] of [[2, 26], [24, 0], [30, 6], [46, 22]]) {
    await page.evaluate((t) => applyTime(t), t);
    assert.equal((await status(page)).error, ref[c], `slot ${t} holds the ${c < 24 ? "" : "next-day "}column ${c} of the CSV`);
  }
  await page.selectOption("#axisStart", "18:00"); await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ t0: S.times[0], same: S.bs === S.orig.bs && S.errRef === S.orig.errRef, t: S.t, label: $("timeLabel").textContent, title: document.title, check: $("pCheck").textContent }));
  assert.deepEqual(back, { t0: "18:00", same: true, t: 22, label: "08-21 23:30", title: "冠水候補 2024-08-21 18:00〜08-22 06:00", check: back.check }, "23:30 stays on screen: column 22 of the CSV order");
  assert.match(back.check, /不一致: 0 セル/, "back in the CSV order the cross-check matches again");
  await page.evaluate(() => applyTime(0));
  assert.equal((await status(page)).error, ref[0]);
  // no date: CSV order, title from the file name, labels without a date, no rain
  await page.fill("#axisDate", ""); await page.waitForTimeout(300);
  const none = await page.evaluate(() => ({ date: S.axisDate, title: document.title, label: $("timeLabel").textContent, rain: $("rainVal").textContent, cur: S.rain.cur, key: rainDateFor(0) }));
  assert.deepEqual(none, { date: null, title: "Tokyo 2024-08-21 Flood Candidates", label: "18:00", rain: "（開始の日付を入れると降雨を表示）", cur: null, key: null });
  await page.fill("#axisDate", "2024-08-22"); await page.waitForTimeout(300);
  const moved = await page.evaluate(() => ({ date: S.axisDate, title: document.title, label: $("timeLabel").textContent, d: [0, 23, 24, 47].map(rainDateFor) }));
  assert.deepEqual(moved, { date: "20240822", title: "冠水候補 2024-08-22 18:00〜08-23 06:00", label: "08-22 18:00", d: ["20240822", "20240822", "20240823", "20240823"] });
  // the anomaly file names of a period 12:00 -> next day 12:00 give its start (any level, any order)
  const det = await page.evaluate(() => {
    const names = ["readme.txt", "error.csv"];
    for (const [d, hours] of [["20260814", [0, 12]], ["20260813", [12, 24]]]) for (let h = hours[0]; h < hours[1]; h++) for (const m of [45, 30, 15, 0]) names.push(`error_L${1 + (h % 3)}_${d}_${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}.geojson`);
    return periodFromNames(names);
  });
  assert.deepEqual(det, { date: "20260813", time: "12:00", windows: 96, first: "20260813 12:00", last: "20260814 11:45" });
  assert.equal(await page.evaluate(() => periodFromNames(["error.csv", "error_level1.csv"])), null);
  // a 30-minute CSV: the count threshold is per hour (10) scaled to the window, the labels say 30
  const thirty = await page.evaluate(() => {
    const keep = { times: S.times, T: S.T, nb: S.nbParams };
    S.times = ["12:00", "12:30", "13:00"]; S.T = 3; S.nbParams = null;
    const d = defaultParams(), slot = slotMin();
    fillParamInputs();
    const labels = [$("pSlot1").textContent, $("pSlot2").textContent];
    S.times = keep.times; S.T = keep.T; S.nbParams = keep.nb; fillParamInputs();
    return { minCount: d.minCount, slot, labels, back: [$("pSlot1").textContent, slotMin()] };
  });
  assert.deepEqual(thirty, { minCount: 5, slot: 30, labels: ["30", "30"], back: ["15", 15] });
  const vj = await page.evaluate(() => parseViewerJson(JSON.stringify({ period: { start: "2026-08-13 12:00", hours: 24, slot_min: 30 },
    thresholds: { min_base_count: 5, min_base_speed: 10, require_corroboration: true, error_levels: [{ speed: 0.4, count: 0.4, op: "or" }, { speed: 0.4, count: 0.4, op: "and" }, { speed: 0.2, count: 0.2, op: "and" }] } })));
  assert.deepEqual(vj, { period: { event: { start: "2026-08-13 12:00", hours: 24, slot_min: 30 } },
    nbParams: { minCount: 5, minSpeed: 10, corrob: true, levels: [{ speed: 0.4, count: 0.4, op: "or" }, { speed: 0.4, count: 0.4, op: "and" }, { speed: 0.2, count: 0.2, op: "and" }] } });
  assert.deepEqual(await page.evaluate(() => parseViewerJson("{\"thresholds\": {\"error_levels\": [{\"speed\": 1}]}}")), { period: null, nbParams: null }, "an incomplete thresholds block is ignored");
  assert.equal(await page.evaluate(() => parseViewerJson("not json")), null);
  await page.close();
});

test("hovering an error link shows the chart panel with the error band; click pins it, a click beside the links releases it", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const pt = await findLink(page, 4, T_18);
  assert.ok(pt, "a level-3 error link is visible");
  await hover(page, pt);
  const cp = await page.evaluate(() => ({
    shown: $("chartPanel").style.display, status: $("cpStatus").textContent, title: $("cpTitle").textContent, l1: $("roL1").textContent,
    errRects: document.querySelectorAll("#chartSpeed rect.err").length, l3: document.querySelectorAll("#chartSpeed rect.err.l3").length,
    paths: document.querySelectorAll("#chartCount path").length, es: $("roES").textContent, hover: S.hoverId,
  }));
  assert.equal(cp.shown, "block");
  assert.equal(cp.status, "異常 レベル3");
  assert.match(cp.title, /^Link /); assert.equal(cp.l1, "速度 km/h");
  assert.ok(cp.errRects >= 1 && cp.l3 >= 1, "error band drawn with the level class");
  assert.equal(cp.paths, 2, "baseline + event series");
  assert.notEqual(cp.es, "–");
  assert.notEqual(cp.hover, null, "hovered link highlighted via feature-state");
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => $("chartPanel").classList.contains("pinned") && S.pinnedId !== null));
  await page.screenshot({ path: join(SHOTS, "simple_hover_pinned.png") });
  // moving away keeps the pinned panel; a click on a spot without links releases it
  const empty = await page.evaluate(() => {
    const c = map.getCanvas(), cx = c.clientWidth / 2, cy = c.clientHeight / 2;
    for (let r = 4; r < 80; r += 2) for (const [dx, dy] of [[r, r], [-r, r], [r, -r], [-r, -r], [r, 0], [0, r]]) {
      const p = { x: cx + dx, y: cy + dy };
      if (!map.queryRenderedFeatures([p.x, p.y], { layers: ["links-hit"] }).length) return p;
    }
    return null;
  });
  assert.ok(empty, "a point without links near the centre");
  await page.mouse.move(box.x + empty.x, box.y + empty.y); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => $("chartPanel").style.display), "block", "pinned panel survives leaving the link");
  await page.mouse.click(box.x + empty.x, box.y + empty.y); await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => [S.pinnedId, $("chartPanel").style.display, $("chartPanel").classList.contains("pinned")]), [null, "none", false]);
  await page.close();
});

test("threshold panel recomputes classes and the reference check reacts", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const base0 = await status(page);
  await page.click("#settingsBtn");
  assert.equal(await page.evaluate(() => $("settings").style.display), "block");
  await page.fill("#pL1Speed", "0.5"); await page.fill("#pL1Count", "0.5"); await page.waitForTimeout(500);
  const strict = await status(page);
  assert.ok(strict.error < base0.error, "stricter level-1 thresholds -> fewer errors");
  assert.equal(strict.levels[2], base0.levels[2], "level 3 unchanged");
  assert.match(await page.textContent("#pCheck"), /想定内/);
  await page.fill("#pMinCount", "0"); await page.waitForTimeout(500);
  assert.ok((await status(page)).target > base0.target, "lower count threshold -> more targets");
  await page.click("#pCorrob"); await page.waitForTimeout(500);
  assert.ok((await status(page)).error >= strict.error, "without corroboration errors do not decrease");
  await page.click("#pDefault"); await page.waitForTimeout(500);
  await page.selectOption("#pL1Op", "and"); await page.waitForTimeout(500);   // level 1 needs both ratios low
  const andL1 = await status(page);
  assert.ok(andL1.levels[0] < base0.levels[0] && andL1.error < base0.error, "AND at level 1 -> fewer level-1 links and fewer errors");
  assert.equal(andL1.levels[2], base0.levels[2], "level 3 (still OR) unchanged");
  await page.click("#pDefault"); await page.waitForTimeout(500);
  assert.deepEqual(await status(page), base0, "defaults restore the original counts");
  assert.match(await page.textContent("#pCheck"), /不一致: 0 セル/);
  await page.click("#settingsClose");
  assert.equal(await page.evaluate(() => $("settings").style.display), "none");
  await page.close();
});

test("rain over http: slots follow the slider and the axis date, readout, toggle, a day without files shows no rain", async () => {
  const page = await openViewer();
  const r = await page.evaluate(() => ({ n: S.rain.sources.size, dates: S.rain.dates, opts: getComputedStyle($("overlayOpts")).display, legend: $("legendRain").textContent,
    d: [0, 23, 24, 47].map(rainDateFor), vis: map.getLayoutProperty("rain", "visibility"), sel: getComputedStyle($("rainDate")).display }));
  assert.equal(r.n, 48, "48 rain GeoTIFF slots registered from rain/index.json");
  assert.deepEqual(r.dates, ["20240821", "20240822"]);
  assert.notEqual(r.opts, "none"); assert.match(r.legend, /降雨 mm\/h（15 分平均）1–5.*80\+/); assert.equal(r.vis, "visible"); assert.equal(r.sel, "none", "no rain date select: the date comes from the axis");
  assert.deepEqual(r.d, ["20240821", "20240821", "20240822", "20240822"], "after the clock wraps the next day's files are used");
  await page.evaluate((t) => applyTime(t + 2), T_18);   // 00:30 of the next day = peak
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  const peak = await page.evaluate(() => ({ max: Math.max(...S.rain.cur.vals), url: map.getSource("rain").url.slice(0, 21), w: S.rain.cur.w, h: S.rain.cur.h, nodata: S.rain.cur.nodata, bounds: S.rain.cur.bounds }));
  assert.ok(peak.max > 80, "peak slot decoded from the GeoTIFF: " + JSON.stringify(peak));
  assert.equal(peak.nodata, -1); assert.deepEqual([peak.w, peak.h], [160, 96]); assert.equal(peak.url, "data:image/png;base64");
  assert.ok(Math.abs(peak.bounds[0] - 139.70) < 1e-9 && Math.abs(peak.bounds[3] - 35.71) < 1e-9, "georeference from the tags: " + peak.bounds);
  const centre = await page.evaluate((ll) => rainAt({ lng: ll[0], lat: ll[1] }), WET);
  assert.match(centre, /^\d+\.\d mm\/h$/); assert.ok(parseFloat(centre) > 60, "wet centre value " + centre);
  assert.equal(await page.evaluate(() => rainAt({ lng: 139.7001, lat: 35.68 })), "–", "no-data stripe reads as –");
  assert.equal(await page.evaluate(() => rainAt({ lng: 139.5, lat: 35.68 })), "", "outside the bounds reads empty");
  // readout under the cursor
  const box = await page.locator("#map").boundingBox();
  const px = await page.evaluate((ll) => map.project(ll), WET);
  await page.mouse.move(box.x + px.x, box.y + px.y); await page.waitForTimeout(400);
  assert.match(await page.textContent("#rainVal"), /^\d+\.\d mm\/h$/, "value under the cursor");
  await page.screenshot({ path: join(SHOTS, "simple_rain.png") });
  // stepping time swaps the image; the cache is bounded
  await page.evaluate((t) => applyTime(t), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:00", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => S.rain.cache.size >= 2 && S.rain.cache.size <= 8));
  // toggle
  await page.click("#chkRain"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("rain", "visibility")), "none");
  await page.click("#chkRain"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("rain", "visibility")), "visible");
  // the axis date moved to 2024-08-22: 00:00 falls on 08-23, which has no file -> no rain, never another day's
  await page.fill("#axisDate", "2024-08-22"); await page.waitForTimeout(300);
  const moved = await page.evaluate(() => ({ key: rainDateFor(24), cur: S.rain.cur, val: $("rainVal").textContent }));
  assert.deepEqual(moved, { key: "20240823", cur: null, val: "（この時刻の降雨なし）" });
  await page.fill("#axisDate", "2024-08-21");
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:00", null, { timeout: 15000 });
  await page.close();
});

test("standalone file:// with the file picker: traffic files (input 1) and the rain folder (input 2)", async () => {
  const page = await openPicker();
  assert.ok(await page.evaluate(() => $("loadBtn").disabled), "load button disabled until input 1 is chosen");
  await page.setInputFiles("#fileInput", REQUIRED.map((f) => join(DATA, f)));
  assert.match(await page.textContent("#pickNote"), /^1: 5 ファイル \/ 2: なし$/);
  await page.setInputFiles("#rainInput", join(DATA, "rain"));
  assert.match(await page.textContent("#pickNote"), /^1: 5 ファイル \/ 2: 降雨 48 枚$/);
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  const info = await page.evaluate(() => ({ rain: S.rain.sources.size, axis: [S.axisStart, S.axisDate, S.axisSource], ref: S.errRef, check: $("pCheck").textContent, title: document.title }));
  assert.equal(info.rain, 48, "rain registered from input 2"); assert.deepEqual(info.axis, ["18:00", "20240821", "default"], "no viewer.json among the 5 files: CSV order, date from the file name");
  assert.equal(await page.evaluate(() => S.nbParams), null);
  assert.equal(info.ref, null); assert.match(info.check, /未読み込み/); assert.equal(info.title, "冠水候補 2024-08-21 18:00〜08-22 06:00");
  await page.evaluate((t) => applyTime(t), T_18);
  assert.equal((await status(page)).error, errorCountsFromCsv()[T_18], "same result without error.csv");
  await page.evaluate((t) => applyTime(t + 2), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => Math.max(...S.rain.cur.vals) > 80), "rain GeoTIFF decoded from a File object");
  await page.close();
});

test("standalone file:// with the folder picker: rain/ inside the traffic folder, error.csv cross-checked, the period from the error_L*.geojson names", async () => {
  const page = await openPicker();
  await page.setInputFiles("#dirInput", DATA);
  assert.match(await page.textContent("#pickNote"), /^1: \d+ ファイル \/ 2: なし$/);
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  const info = await page.evaluate(() => ({ rain: S.rain ? S.rain.sources.size : 0, dates: S.rain && S.rain.dates, check: $("pCheck").textContent, unit: S.rain && S.rain.index.unit,
    axis: [S.axisStart, S.axisDate, S.axisSource], title: document.title }));
  assert.equal(info.rain, 48, "rain slots found in the folder (rain_*.tif)"); assert.deepEqual(info.dates, ["20240821", "20240822"]);
  assert.match(info.check, /不一致: 0 セル/, "error.csv from the folder is compared");
  assert.ok(info.unit, "rain/index.json inside the folder is read");
  assert.deepEqual(info.axis, ["18:00", "20240821", "viewer.json"], "period from viewer.json in the folder (the error_L*.geojson names are the fallback)");
  assert.ok(await page.evaluate(() => !!S.nbParams), "thresholds from viewer.json");
  assert.match(await page.evaluate(() => document.querySelector('#fileList li[data-name="viewer.json"]').textContent), /期間 2024-08-21 18:00 から 12 時間（15 分窓） \/ 閾値を既定値に/);
  assert.equal(info.title, "冠水候補 2024-08-21 18:00〜08-22 06:00");
  await page.evaluate((t) => applyTime(t + 2), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => Math.max(...S.rain.cur.vals) > 80));
  await page.close();
});

test("standalone file:// without a rain folder: no overlay controls, the axis date still comes from the network file name", async () => {
  const page = await openPicker();
  await page.setInputFiles("#fileInput", REQUIRED.map((f) => join(DATA, f)));
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  const info = await page.evaluate(() => ({ rain: S.rain, layer: map.getLayer("rain") || null, opts: getComputedStyle($("overlayOpts")).display, legend: getComputedStyle($("legendRain")).display, date: S.axisDate, label: $("timeLabel").textContent }));
  assert.deepEqual(info, { rain: null, layer: null, opts: "none", legend: "none", date: "20240821", label: "08-21 18:00" });
  await page.close();
});

test("no JavaScript errors were raised", () => {
  assert.deepEqual(errors, []);
});
