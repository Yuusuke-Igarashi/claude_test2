// Inline MapLibre GL JS (from node_modules) into flood_viewer.html -> dist/flood_viewer_standalone.html
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "flood_viewer.html"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "node_modules/maplibre-gl/package.json"), "utf8"));
const js = readFileSync(join(here, "node_modules/maplibre-gl/dist/maplibre-gl.js"), "utf8");
const css = readFileSync(join(here, "node_modules/maplibre-gl/dist/maplibre-gl.css"), "utf8");

const link = /<link rel="stylesheet" href="https:\/\/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.css">/;
const script = /<script src="https:\/\/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.js"><\/script>/;
if (!link.test(src) || !script.test(src)) throw new Error("CDN tags not found in flood_viewer.html");
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error("bundle contains a closing tag; cannot inline");

const out = src
  .replace(link, `<style>\n/* MapLibre GL JS ${pkg.version} CSS (inlined) */\n${css}\n</style>`)
  .replace(script, `<script>\n/* MapLibre GL JS ${pkg.version} (inlined, BSD-3-Clause; see https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt) */\n${js}\n</script>`);

mkdirSync(join(here, "dist"), { recursive: true });
const target = join(here, "dist/flood_viewer_standalone.html");
writeFileSync(target, out);
console.log(`built ${target} (${(statSync(target).size / 1048576).toFixed(2)} MB, maplibre-gl ${pkg.version})`);
