// Browser tests for flood_viewer (Playwright + node:test).
// Prerequisites: `npm run data` (sample files in sample/output) and `npm run build` (dist/flood_viewer_standalone.html).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, createReadStream, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "sample", "output");
const SHOTS = join(here, "shots");
const HTML = "flood_viewer_standalone.html";
const T_18 = 24; // 18:00 + 24 * 15 min = 00:00 (the sample axis crosses midnight)

const REQUIRED = ["tokyo_20240821_network.geojson", "baseline_speed.csv", "event_speed.csv", "baseline_count.csv", "event_count.csv"];
const OPTIONAL = ["error.csv", "baseline_trajectory.geojson", "event_trajectory.geojson", "baseline_dwell.geojson", "event_dwell.geojson"];
const SLOT_FILES = 2 * 48; // viewer/<role>_<HHMM>.geojson for baseline and event, 48 slots (18:00-05:45) in the sample
// wait until the lazy slot for the current time is parsed
const waitSlot = (page) => page.waitForFunction(() => !S.lazy || S.lazy.loaded === S.times[S.t], null, { timeout: 15000 });

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
  const types = { ".html": "text/html; charset=utf-8", ".csv": "text/csv", ".geojson": "application/geo+json", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
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
  for (const f of [...REQUIRED, ...OPTIONAL]) assert.ok(existsSync(join(DATA, f)), `missing sample file ${f} (run: npm run data)`);
  assert.ok(existsSync(join(DIST, HTML)), "missing dist/flood_viewer_standalone.html (run: npm run build)");
  mkdirSync(SHOTS, { recursive: true });
  server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch);
});
after(async () => { await browser?.close(); server?.close(); });

test("loads all files and reproduces the notebook's error.csv exactly", async () => {
  const page = await openViewer();
  const info = await page.evaluate(() => ({ N: S.ids.length, T: S.T, lazy: S.lazy ? S.lazy.sources.size : 0, traj: S.traj, check: document.getElementById("pCheck").textContent }));
  assert.equal(info.T, 48);
  assert.ok(info.N > 1000);
  assert.equal(info.lazy, SLOT_FILES, "per-slot viewer files registered via viewer/index.json");
  assert.equal(info.traj, null, "nothing parsed until a slot is shown");
  assert.match(info.check, /不一致: 0 セル/, "in-page error computation must match error.csv at default thresholds");
  assert.match(info.check, /レベル 0〜3 で照合/, "error.csv holds levels (not 0/1)");
  assert.ok(await page.evaluate(() => S.errRefRows < S.ids.length && !S.errRefBinary), "error.csv lists only the links with an error");
  const ref = errorCountsFromCsv(), refL = [1, 2, 3].map((l) => errorCountsFromCsv(l));
  for (const t of [0, T_18, 47]) {
    await page.evaluate((t) => applyTime(t), t);
    const st = await status(page);
    assert.equal(st.error, ref[t], `error count at t=${t} matches error.csv`);
    assert.deepEqual(st.levels, refL.map((c) => c[t]), `per-level counts at t=${t} match error.csv`);
  }
  assert.ok(refL[0][T_18] > 0 && refL[2][T_18] > 0, "sample has level-1 and level-3 errors at 00:00");
  await page.screenshot({ path: join(SHOTS, "traffic_18.png") });
  await page.close();
});

test("slider, play and keyboard change the time", async () => {
  const page = await openViewer();
  await page.locator("#slider").fill(String(T_18));
  assert.equal((await status(page)).time, "00:00");
  await page.mouse.move(700, 450);
  await page.keyboard.press("ArrowRight");
  assert.equal((await status(page)).time, "00:15");
  await page.keyboard.press("Space"); await page.waitForTimeout(1500); await page.keyboard.press("Space");
  const after = await page.evaluate(() => S.t);
  assert.ok(after > T_18 + 1, "playback advanced");
  await page.close();
});

test("hovering an error link shows the chart panel with the error band, click pins it", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const pt = await findLink(page, 4, T_18);
  assert.ok(pt, "a level-3 error link is visible");
  await hover(page, pt);
  const cp = await page.evaluate(() => ({
    shown: document.getElementById("chartPanel").style.display, status: document.getElementById("cpStatus").textContent,
    errRects: document.querySelectorAll("#chartSpeed rect.err").length, paths: document.querySelectorAll("#chartCount path").length,
    es: document.getElementById("roES").textContent,
  }));
  assert.equal(cp.shown, "block");
  assert.equal(cp.status, "異常 レベル3");
  assert.ok(cp.errRects >= 1, "error band drawn");
  assert.ok(await page.evaluate(() => document.querySelectorAll("#chartSpeed rect.err.l3").length >= 1), "band carries the level class");
  assert.equal(cp.paths, 2, "baseline + event series");
  assert.notEqual(cp.es, "–");
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.getElementById("chartPanel").classList.contains("pinned")));
  await page.screenshot({ path: join(SHOTS, "hover_pinned.png") });
  await page.close();
});

test("threshold panel recomputes classes and the reference check reacts", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const base0 = await status(page);
  await page.click("#settingsBtn");
  await page.fill("#pL1Speed", "0.5"); await page.fill("#pL1Count", "0.5"); await page.waitForTimeout(500);
  const strict = await status(page);
  assert.ok(strict.error < base0.error, "stricter level-1 thresholds -> fewer errors");
  assert.equal(strict.levels[2], base0.levels[2], "level 3 unchanged");
  assert.match(await page.textContent("#pCheck"), /想定内/);
  await page.fill("#pMinCount", "0"); await page.waitForTimeout(500);
  assert.ok((await status(page)).target > base0.target, "lower count threshold -> more targets");
  await page.click("#pCorrob"); await page.waitForTimeout(500);
  const noCorrob = await status(page);
  assert.ok(noCorrob.error >= strict.error, "without corroboration errors do not decrease");
  await page.click("#pDefault"); await page.waitForTimeout(500);
  assert.deepEqual(await status(page), base0, "defaults restore the original counts");
  assert.match(await page.textContent("#pCheck"), /不一致: 0 セル/);
  await page.screenshot({ path: join(SHOTS, "settings.png") });
  await page.close();
});

test("trajectory mode: zoom gating, viewport filtering, hover tooltip, no traffic info", async () => {
  const page = await openViewer();
  await page.click("#modeTraj"); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => S.mode), "traj");
  assert.match(await page.textContent("#trajStatus"), /ズーム 14 以上/);
  assert.equal(await page.evaluate(() => map.querySourceFeatures("traj-event").length), 0, "nothing drawn below the zoom threshold");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("statTraffic")).display), "none", "traffic counts hidden");
  assert.equal(await page.evaluate(() => map.getLayoutProperty("links-base", "visibility")), "none", "traffic-coloured network hidden");
  assert.equal(await page.evaluate(() => map.getLayoutProperty("links-context", "visibility")), "visible");
  await page.evaluate((t) => { map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 }); applyTime(t); }, T_18);
  await waitSlot(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => S.lazy.loaded), "00:00", "only the 00:00 slot is parsed");
  assert.equal(await page.evaluate(() => Object.values(S.traj).filter(Boolean).length), 8, "4 kinds x baseline+event for the slot");
  const st = await page.textContent("#trajStatus");
  const m = st.match(/平時 徒歩軌跡 (\d+) 本・滞留 (\d+) 点・車→徒歩 (\d+) 点・方向転換 (\d+) 点 \/ イベント時 徒歩軌跡 (\d+) 本・滞留 (\d+) 点・車→徒歩 (\d+) 点・方向転換 (\d+) 点/);
  assert.ok(m, "status lists counts: " + st);
  assert.ok(+m[1] > 0 && +m[5] > 0, "trajectories drawn at zoom 15");
  assert.ok(+m[2] > 0 && +m[6] > 0, "dwell points drawn from the slot files");
  assert.ok(+m[7] > 0 && +m[8] > 0, "mode-change and turn points drawn for the flooded event window");
  assert.match(st, /この時刻のデータ全体: 平時 徒歩軌跡 \d+/, "whole-slot diagnostics shown");
  for (const l of ["mode-event", "turn-event", "dwell-event", "traj-event"]) assert.ok(await page.evaluate((l) => map.queryRenderedFeatures({ layers: [l] }).length, l) > 0, l + " rendered");
  // kind toggles hide their layers
  await page.click("#chkMode"); await page.click("#chkTurn"); await page.waitForTimeout(400);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本・滞留 \d+ 点・車→徒歩 0 点・方向転換 0 点/);
  assert.equal(await page.evaluate(() => map.querySourceFeatures("mode-event").length), 0, "mode-change source cleared by its toggle");
  await page.click("#chkMode"); await page.click("#chkTurn"); await page.waitForTimeout(400);

  // hovering a link shows no chart panel in trajectory mode
  const link = await findLink(page, 4, T_18);   // the flooded block is level 3
  await hover(page, link);
  assert.notEqual(await page.evaluate(() => document.getElementById("chartPanel").style.display), "block", "no time-series panel on link hover");

  // hover an event trajectory: tooltip only (features carry no identifier, nothing is highlighted)
  const tp = await page.evaluate(() => {
    const fts = map.queryRenderedFeatures({ layers: ["traj-event"] });
    const c0 = map.getCenter(); let best = null;
    for (const f of fts) { const cs = f.geometry.coordinates; const c = cs[Math.floor(cs.length / 2)];
      const d = Math.hypot(c[0] - c0.lng, c[1] - c0.lat); if (!best || d < best.d) { const p = map.project(c); best = { d, x: p.x, y: p.y }; } }
    return best;
  });
  assert.ok(tp, "an event trajectory is rendered");
  await hover(page, tp);
  assert.equal(await page.evaluate(() => document.getElementById("tip").style.display), "block", "tooltip on hover");
  assert.match(await page.textContent("#tip"), /イベント時 (徒歩軌跡|滞留|車→徒歩|方向転換)/);
  assert.doesNotMatch(await page.textContent("#tip"), /ID |userid/, "no identifier in the tooltip");
  assert.equal(await page.evaluate(() => S.trajSel), null, "nothing selected on hover");
  await page.screenshot({ path: join(SHOTS, "trajectory_hover.png") });
  // click marks the one feature under the cursor (feature-state); a second click or an empty click clears it
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + tp.x, box.y + tp.y); await page.waitForTimeout(300);
  const sel = await page.evaluate(() => S.trajSel && { source: S.trajSel.source, id: S.trajSel.id, state: map.getFeatureState({ source: S.trajSel.source, id: S.trajSel.id }) });
  assert.ok(sel && sel.state.sel === true, "clicked feature selected: " + JSON.stringify(sel));
  assert.ok(await page.evaluate(() => map.queryRenderedFeatures({ layers: TRAJ_LAYERS }).filter((f) => f.state && f.state.sel).length) >= 1, "selected feature rendered with state");
  await page.screenshot({ path: join(SHOTS, "trajectory_selected.png") });
  await page.mouse.click(box.x + tp.x, box.y + tp.y); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => S.trajSel), null, "second click clears the selection");
  assert.equal(await page.evaluate(([s, i]) => map.getFeatureState({ source: s, id: i }).sel, [sel.source, sel.id]), undefined, "feature-state removed");
  await page.mouse.click(box.x + tp.x, box.y + tp.y); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => !!S.trajSel), "selected again");
  await page.evaluate(() => map.jumpTo({ zoom: 12.5 })); await page.waitForTimeout(800);
  await page.mouse.click(box.x + 30, box.y + box.height - 30); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => S.trajSel), null, "empty click clears the selection");
  await page.evaluate(() => map.jumpTo({ zoom: 15.2 })); await page.waitForTimeout(1500);
  await page.mouse.move(700, 30); await page.waitForTimeout(300);   // onto the top bar: leaves the canvas
  assert.equal(await page.evaluate(() => document.getElementById("tip").style.display), "none", "tooltip hidden when the mouse leaves the map");

  // stepping through time loads other slots and keeps a bounded cache
  await page.evaluate((t) => applyTime(t + 1), T_18); await waitSlot(page);
  await page.evaluate((t) => applyTime(t + 2), T_18); await waitSlot(page);
  assert.equal(await page.evaluate(() => S.lazy.loaded), "00:30");
  assert.ok(await page.evaluate(() => S.lazy.cache.size >= 3 && S.lazy.cache.size <= 4), "slot cache bounded");
  await page.evaluate((t) => applyTime(t), T_18); await waitSlot(page); await page.waitForTimeout(800);

  await page.click("#chkBase"); await page.waitForTimeout(500);
  assert.match(await page.textContent("#trajStatus"), /平時 徒歩軌跡 0 本・滞留 0 点・車→徒歩 0 点・方向転換 0 点/);
  await page.click("#chkBase"); await page.waitForTimeout(300);
  // "nearest" button: from an empty corner of the grid the map flies to the nearest feature of the slot
  await page.evaluate(() => map.jumpTo({ center: [139.70 + 2 * 0.0025, 35.65 + 2 * 0.002], zoom: 15.2 })); await page.waitForTimeout(800);
  assert.match(await page.textContent("#trajStatus"), /表示範囲内にはありません/, "diagnostic when the view holds no feature");
  await page.click("#nearestBtn"); await page.waitForTimeout(1500);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本/, "features visible after flying to the nearest one");
  await page.evaluate(() => map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 })); await page.waitForTimeout(800);
  await page.mouse.move(50, 400); await page.keyboard.press("m"); await page.waitForTimeout(300);   // traj -> truck (M cycles the three tabs)
  assert.equal(await page.evaluate(() => S.mode), "truck");
  await page.keyboard.press("m"); await page.waitForTimeout(500);                                     // truck -> traffic
  assert.equal(await page.evaluate(() => S.mode), "traffic");
  assert.equal(await page.evaluate(() => map.querySourceFeatures("traj-event").length), 0, "sources cleared in traffic mode");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("statTraffic")).display), "none", "traffic counts back");
  await page.close();
});

test("rain slots and low-lying areas follow the time slider, toggles and date select", async () => {
  const page = await openViewer();
  assert.equal(await page.evaluate(() => S.rain ? S.rain.sources.size : 0), 48, "48 rain GeoTIFF slots registered from rain/index.json");
  assert.ok(await page.evaluate(() => !!S.lowland && map.getLayer("lowland") && map.getLayer("rain")), "rain and lowland layers exist");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("overlayOpts")).display), "none", "overlay controls shown");
  assert.match(await page.textContent("#legendRain"), /降雨 mm\/h/);
  assert.deepEqual(await page.evaluate(() => S.period), { event: { start: "2024-08-21 18:00", hours: 12, slot_min: 15 }, baseline: { start: "2024-08-14 18:00", hours: 12, slot_min: 15 } }, "period read from viewer/index.json");
  assert.equal(await page.evaluate(() => document.querySelector("#topbar h1").textContent), "冠水候補 2024-08-21 18:00〜08-22 06:00（平時 08-14 18:00〜08-15 06:00）", "title from the period, not from the network file name");
  assert.equal(await page.evaluate(() => document.getElementById("rainDate").value), "20240821", "date of the first slot (18:00 of the start day)");
  assert.ok(await page.evaluate(() => document.getElementById("rainDate").disabled), "date follows the period automatically");
  assert.equal(await page.evaluate(() => S.adjPrev[24]), 1, "23:45 -> 00:00 counts as consecutive");
  assert.equal(await page.evaluate(() => rainSlotKey("rain_20260813_2400.tif".match(RAIN_NAME))), "20260814_00:00", "a _2400 file name is the next day's 00:00 slot");
  assert.equal(await page.evaluate(() => S.axisNote), null, "sample CSV columns already follow the period: nothing to realign");
  const align = (period) => page.evaluate((period) => {
    const keep = ["times", "T", "ids", "bs", "es", "bc", "ec", "errRef", "period"], saved = Object.fromEntries(keep.map(k => [k, S[k]]));
    S.ids = ["a", "b"]; S.T = 4; S.times = ["00:00", "06:00", "12:00", "18:00"];   // a whole-day CSV, 6 h columns
    S.bs = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]); S.es = S.bs.slice(); S.bc = S.bs.slice(); S.ec = S.bs.slice();
    S.errRef = Uint8Array.from([0, 1, 0, 0, 1, 0, 0, 0]);
    S.period = period;
    const note = alignAxisToPeriod();
    const r = { note, times: S.times, T: S.T, bs: [...S.bs].map(v => Number.isNaN(v) ? null : v), err: [...S.errRef] };
    Object.assign(S, saved);
    return r;
  }, period);
  const rot = await align({ event: { start: "2026-08-13 12:00", hours: 24, slot_min: 360 } });
  assert.deepEqual(rot.times, ["12:00", "18:00", "00:00", "06:00"], "a whole-day CSV is rotated to the period start");
  assert.deepEqual(rot.bs, [3, 4, 1, 2, 7, 8, 5, 6], "columns matched by clock time");
  assert.deepEqual(rot.err, [0, 0, 0, 1, 0, 0, 1, 0], "error.csv reordered the same way");
  assert.match(rot.note, /00:00 開始、4 列.*12:00 開始、4 列/); assert.doesNotMatch(rot.note, /空欄/);
  const gap = await align({ event: { start: "2026-08-13 12:00", hours: 12, slot_min: 180 } });
  assert.deepEqual(gap.times, ["12:00", "15:00", "18:00", "21:00"], "axis = start + k * slot for hours");
  assert.deepEqual(gap.bs, [3, null, 4, null, 7, null, 8, null], "times the CSV lacks stay empty");
  assert.match(gap.note, /2 列は空欄/);
  assert.equal(await page.evaluate(() => rainSlotKey("rain_20261231_2400.tif".match(RAIN_NAME))), "20270101_00:00", "year end");
  assert.equal(await page.evaluate(() => { const d = S.rain.dates; S.rain.dates = ["20240821"]; const k = rainDateFor(24); S.rain.dates = d; return k; }), "20240822", "a missing day is not replaced by another day's rain");
  await page.evaluate((t) => applyTime(t + 2), T_18);   // 00:30 of the next day = peak
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.getElementById("rainDate").value), "20240822", "after midnight the next day is used");
  const peak = await page.evaluate(() => ({ max: Math.max(...S.rain.cur.vals), url: map.getSource("rain").url.slice(0, 21), w: S.rain.cur.w, h: S.rain.cur.h, nodata: S.rain.cur.nodata, bounds: S.rain.cur.bounds }));
  assert.ok(peak.max > 80, "peak slot decoded from the GeoTIFF: " + JSON.stringify(peak));
  assert.equal(peak.nodata, -1, "GDAL_NODATA read");
  assert.ok(Math.abs(peak.bounds[0] - 139.70) < 1e-9 && Math.abs(peak.bounds[3] - 35.71) < 1e-9, "georeference from the tags: " + peak.bounds);
  assert.equal(peak.url, "data:image/png;base64", "coloured image handed to the image source");
  assert.deepEqual([peak.w, peak.h], [160, 96]);
  // value readout at the wet centre and the no-data stripe
  const centre = await page.evaluate(() => rainAt({ lng: 139.70 + 0.1 * (0.2 + 0.6 * 26 / 47), lat: 35.71 - 0.06 * (0.5 + 0.15 * Math.sin(26 / 6)) }));
  assert.match(centre, /^\d+\.\d mm\/h$/, "readout: " + centre);
  assert.ok(parseFloat(centre) > 60, "wet centre value " + centre);
  assert.equal(await page.evaluate(() => rainAt({ lng: 139.7001, lat: 35.68 })), "–", "no-data stripe reads as –");
  assert.equal(await page.evaluate(() => rainAt({ lng: 139.5, lat: 35.68 })), "", "outside the bounds reads empty");
  // stepping time swaps the image; the cache is bounded
  await page.evaluate((t) => applyTime(t), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:00", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => S.rain.cache.size >= 2 && S.rain.cache.size <= 8));
  // toggles
  await page.click("#chkRain"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("rain", "visibility")), "none");
  await page.click("#chkRain"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("rain", "visibility")), "visible");
  await page.click("#chkLowland"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("lowland", "visibility")), "none");
  await page.click("#chkLowland");
  // rain stays available in trajectory mode
  await page.click("#modeTraj"); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("rain", "visibility")), "visible");
  await page.screenshot({ path: join(SHOTS, "rain_overlay.png") });
  await page.close();
});

test("standalone file:// with the file picker, without optional files", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#fileInput", REQUIRED.map((f) => join(DATA, f)));
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  await page.evaluate((t) => applyTime(t), T_18);
  const st = await status(page);
  assert.equal(st.error, errorCountsFromCsv()[T_18], "same result without error.csv");
  assert.ok(await page.evaluate(() => document.getElementById("modeTraj").disabled), "trajectory mode disabled without trajectory files");
  assert.equal(await page.evaluate(() => S.rain), null, "no rain without the rain folder");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("overlayOpts")).display), "none");
  assert.match(await page.textContent("#trajStatus"), /軌跡モードは使えません。選択 5 ファイル: 時刻別ファイル.*なし/, "the reason stays visible in traffic mode");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("trajStatus")).display), "block");
  assert.match(await page.textContent("#pCheck"), /未読み込み/);
  await page.close();
});

test("standalone file:// with the folder picker uses the per-slot files", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#dirInput", DATA);
  assert.match(await page.textContent("#pickNote"), /^1: \d+ ファイル \/ 2: なし \/ 3: なし \/ 4: なし$/);
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  assert.equal(await page.evaluate(() => S.lazy ? S.lazy.sources.size : 0), SLOT_FILES, "slot files found in the folder");
  assert.equal(await page.evaluate(() => S.rain ? S.rain.sources.size : 0), 48, "rain slots found in the folder (rain_*.tif)");
  assert.ok(await page.evaluate(() => !!S.lowland), "lowland.geojson found in the folder");
  await page.evaluate((t) => applyTime(t + 2), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => Math.max(...S.rain.cur.vals) > 80), "rain GeoTIFF decoded from a File object");
  await page.evaluate((t) => { setMode("traj"); map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 }); applyTime(t); }, T_18);
  await waitSlot(page); await page.waitForTimeout(1500);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本/, "trajectories drawn from a slot file read via FileReader");
  await page.close();
});

test("three separate inputs: data files, rain folder, lowland GeoJSON", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  assert.ok(await page.evaluate(() => document.getElementById("loadBtn").disabled), "load button disabled until input 1 is chosen");
  await page.setInputFiles("#fileInput", REQUIRED.map((f) => join(DATA, f)));   // input 1 without rain / lowland
  await page.setInputFiles("#rainInput", join(DATA, "rain"));
  await page.setInputFiles("#lowlandInput", join(DATA, "lowland.geojson"));
  assert.match(await page.textContent("#pickNote"), /^1: 5 ファイル \/ 2: 49 ファイル \/ 3: lowland\.geojson \/ 4: なし$/);
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  assert.equal(await page.evaluate(() => S.rain ? S.rain.sources.size : 0), 48, "rain registered from input 2");
  assert.ok(await page.evaluate(() => !!S.lowland && !!map.getLayer("lowland")), "lowland from input 3");
  await page.evaluate((t) => applyTime(t + 2), T_18);
  await page.waitForFunction(() => S.rain.cur && S.rain.cur.key === "20240822_00:30", null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => Math.max(...S.rain.cur.vals) > 80), "rain GeoTIFF decoded from the separate folder");
  await page.close();
});

test("single-file trajectory GeoJSON (no viewer/ folder) still loads whole-day datasets", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#fileInput", [...REQUIRED, ...OPTIONAL].map((f) => join(DATA, f)));
  await page.click("#loadBtn");
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  assert.equal(await page.evaluate(() => S.lazy), null);
  assert.equal(await page.evaluate(() => Object.values(S.traj).filter(Boolean).length), 4);
  await page.close();
});

test("truck tab: folder input 4, links with baseline Hits >= 2, red at <= 50 %, hover chart", async () => {
  const page = await openViewer();   // http mode: truck/traffic_15min.csv picked up automatically
  const info = await page.evaluate(() => ({ rows: S.truck && S.truck.rows, dates: S.truck && S.truck.dates, disabled: document.getElementById("modeTruck").disabled }));
  assert.ok(info.rows > 1000, "truck statistics parsed");
  assert.deepEqual(info.dates, { baseline: ["2024-08-14", "2024-08-15"], event: ["2024-08-21", "2024-08-22"], byPeriod: true }, "dates assigned to roles by the period");
  // dates outside the flood period (a truck zip of the day before + the flood day): latest date = event, others = baseline
  const fb = await page.evaluate(() => { const r = buildTruck("window,Id,Hits,AvgSp\n2025-09-10 12:00:00,1,3,40\n2025-09-11 12:00:00,1,1,20\n2025-09-11 12:15:00,2,2,30\n", S.gj); return r.dates; });
  assert.deepEqual(fb, { baseline: ["2025-09-10"], event: ["2025-09-11"], byPeriod: false }, "fallback when the CSV dates do not match the period");
  assert.equal(info.disabled, false);
  await page.click("#modeTruck"); await page.waitForTimeout(300);
  await page.evaluate((t) => applyTime(t), T_18);
  const st = await page.evaluate(() => ({ mode: S.mode, shown: +document.getElementById("stTruckShown").textContent.replace(/,/g, ""), drop: +document.getElementById("stTruckDrop").textContent.replace(/,/g, ""),
    vis: map.getLayoutProperty("links-truck-red", "visibility"), base: map.getLayoutProperty("links-base", "visibility"), legend: getComputedStyle(document.getElementById("legendTruck")).display }));
  assert.equal(st.mode, "truck"); assert.equal(st.vis, "visible"); assert.equal(st.base, "none"); assert.notEqual(st.legend, "none");
  assert.ok(st.shown > 0 && st.drop > 0 && st.drop < st.shown, "some drawn links, some dropped: " + JSON.stringify(st));
  // independent recount from the CSV for 00:00: baseline Hits >= 2 -> shown; event Hits or AvgSp <= 50 % -> drop
  const ref = (() => {
    const lines = readFileSync(join(DATA, "truck", "traffic_15min.csv"), "utf8").trim().split(/\r?\n/).slice(1);
    const b = new Map(), e = new Map();
    for (const l of lines) { const [w, id, h, s] = l.split(","); if (!w.endsWith(" 00:00:00")) continue; (w.startsWith("2024-08-15") ? b : e).set(id, [+h, +s]); }
    let shown = 0, drop = 0;
    for (const [id, [bh, bs]] of b) { if (bh < 2) continue; shown++; const ev = e.get(id) || [0, NaN]; if (ev[0] / bh <= 0.5 || (Number.isNaN(ev[1]) ? 0 : ev[1] / bs) <= 0.5) drop++; }
    return { shown, drop };
  })();
  assert.deepEqual({ shown: st.shown, drop: st.drop }, ref, "counts match an independent recount of the CSV");
  // hover a red link: chart panel with truck statistics
  const pt = await page.evaluate((t) => {
    const T = S.T, c0 = map.getCenter(); let best = null;
    for (let f = 0; f < S.truck.nf; f++) { if (S.truck.tcls[f * T + t] !== 2) continue; const c = S.gj.features[f].geometry.coordinates; const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
      if (!map.getBounds().contains(mid)) continue; const d = Math.hypot(mid[0] - c0.lng, mid[1] - c0.lat); if (!best || d < best.d) { const p = map.project(mid); best = { d, x: p.x, y: p.y }; } }
    return best;
  }, T_18);
  assert.ok(pt, "a red truck link is visible");
  await hover(page, pt);
  const cp = await page.evaluate(() => ({ shown: document.getElementById("chartPanel").style.display, status: document.getElementById("cpStatus").textContent, title: document.getElementById("cpTitle").textContent, bc: document.getElementById("roBC").textContent, rects: document.querySelectorAll("#chartCount rect.err").length }));
  assert.equal(cp.shown, "block"); assert.match(cp.status, /低下/); assert.match(cp.title, /トラック/); assert.notEqual(cp.bc, "–"); assert.ok(cp.rects >= 1, "drop band drawn");
  // thresholds: ratio 0 -> only links with no event traffic stay red
  await page.click("#settingsBtn"); await page.fill("#pTruckRatio", "0"); await page.waitForTimeout(500);
  const st2 = await page.evaluate(() => +document.getElementById("stTruckDrop").textContent.replace(/,/g, ""));
  assert.ok(st2 < st.drop, "lower ratio -> fewer red links");
  await page.fill("#pTruckMinHits", "100"); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => +document.getElementById("stTruckShown").textContent.replace(/,/g, "")), 0, "min Hits 100 hides everything");
  await page.click("#pDefault"); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => +document.getElementById("stTruckShown").textContent.replace(/,/g, "")), st.shown);
  await page.screenshot({ path: join(SHOTS, "truck.png") });
  // M key cycles traffic -> traj -> truck -> traffic
  await page.mouse.move(700, 450); await page.keyboard.press("m"); assert.equal(await page.evaluate(() => S.mode), "traffic");
  await page.close();
});

test("grid overlay in trajectory mode: parameter select, slot follows the slider, legend", async () => {
  const page = await openViewer();
  assert.equal(await page.evaluate(() => S.grid ? S.grid.sources.size : 0), 48 * 5, "grid rasters registered from grid/index.json");
  assert.deepEqual(await page.evaluate(() => S.grid.params.map(p => p[0])), ["walkers", "walk_dist_m", "stays", "turns", "modechanges"]);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("grid", "visibility")), "none", "hidden in traffic mode");
  await page.click("#modeTraj"); await page.waitForTimeout(300);
  await page.evaluate((t) => applyTime(t + 2), T_18);          // 00:30 = inside the flood window
  await page.waitForFunction(() => S.grid.cur && S.grid.cur.key === "walkers_00:30", null, { timeout: 15000 });
  const g = await page.evaluate(() => ({ vis: map.getLayoutProperty("grid", "visibility"), max: Math.max(...S.grid.cur.vals), min: Math.min(...S.grid.cur.vals.filter(v => v !== -99)),
    legend: document.getElementById("legendGrid").textContent, opt: getComputedStyle(document.getElementById("gridOpt")).display }));
  assert.equal(g.vis, "visible"); assert.equal(g.max, 1); assert.equal(g.min, -1);
  assert.match(g.legend, /徒歩移動者数.*200 % 以上.*50 % 以下/); assert.notEqual(g.opt, "none");
  await page.selectOption("#gridParam", "stays");
  await page.waitForFunction(() => S.grid.cur && S.grid.cur.key === "stays_00:30", null, { timeout: 15000 });
  assert.match(await page.textContent("#legendGrid"), /滞留数/);
  await page.click("#chkGrid"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("grid", "visibility")), "none", "toggle hides the grid");
  await page.click("#chkGrid"); await page.waitForTimeout(200);
  await page.evaluate(() => map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 14 }));
  assert.equal(await page.evaluate(() => gridAt(map.getCenter())), "増加", "flag under the map centre (flood block)");
  await page.click("#modeTraffic"); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => map.getLayoutProperty("grid", "visibility")), "none", "hidden again in traffic mode");
  await page.close();
});

test("no JavaScript errors were raised", () => {
  assert.deepEqual(errors, []);
});
