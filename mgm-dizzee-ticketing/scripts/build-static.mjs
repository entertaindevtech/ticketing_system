// Generates static-build/index.html — the whole app in one self-contained file (open it by double-clicking).
// It is a build artefact of src/: never edit it by hand. Run `npm run build:static`.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const assets = join(dist, "assets");
const mime = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp" };
const dataUri = (file) => `data:${mime[file.split(".").pop()]};base64,${readFileSync(file).toString("base64")}`;

// Every image the bundle references by URL becomes an inline data URI.
const images = Object.fromEntries(readdirSync(assets).filter((f) => /\.(png|jpe?g|svg|webp)$/.test(f)).map((f) => [`/assets/${f}`, dataUri(join(assets, f))]));
const inlineUrls = (s) => Object.entries(images).reduce((acc, [url, uri]) => acc.split(url).join(uri), s);

let html = readFileSync(join(dist, "index.html"), "utf8");
const js = html.match(/<script type="module" crossorigin src="\/assets\/([^"]+\.js)"><\/script>/);
const css = html.match(/<link rel="stylesheet" crossorigin href="\/assets\/([^"]+\.css)">/);
if (!js || !css) throw new Error("Unexpected dist/index.html layout - update scripts/build-static.mjs");

const code = inlineUrls(readFileSync(join(assets, js[1]), "utf8")).replace(/<\/script/gi, "<\\/script");
const style = inlineUrls(readFileSync(join(assets, css[1]), "utf8"));
html = html
  .replace(css[0], () => `<style>${style}</style>`)
  .replace(js[0], () => `<script type="module">${code}</script>`)
  .replace('href="/favicon.png"', () => `href="${dataUri(join(dist, "favicon.png"))}"`)
  .replace("<head>", "<head>\n    <!-- GENERATED from src/ by scripts/build-static.mjs. Do not edit by hand. -->");
if (/(src|href)="\/assets\//.test(html)) throw new Error("An asset was left un-inlined");

writeFileSync(join("static-build", "index.html"), html);
console.log(`static-build/index.html written (${Math.round(html.length / 1024)} KiB)`);
