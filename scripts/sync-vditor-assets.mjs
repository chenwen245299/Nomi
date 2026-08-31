#!/usr/bin/env node
// Vendor vditor's runtime assets into public/ so the Markdown editor works fully
// OFFLINE. vditor lazy-loads Lute (its parser — required), icons, i18n,
// highlight.js, KaTeX, mermaid, ECharts, graphviz, etc. from `${options.cdn}/dist/…`
// at runtime; by default that CDN is unpkg.com. We copy node_modules/vditor/dist →
// public/vditor/dist and point options.cdn at "/vditor" (see
// src/editor/vditorAssets.ts), so nothing is ever fetched from the network.
//
// Runs before `dev`/`build` and at install time (postinstall). Idempotent: it
// re-copies only when the installed vditor version differs from the last vendored
// one (tracked in public/vditor/.version). Vite copies public/* into the build
// output verbatim, so the vendored tree ships inside the Tauri bundle.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require = createRequire(import.meta.url);

let version;
let pkgPath;
try {
  pkgPath = require.resolve("vditor/package.json");
  version = require("vditor/package.json").version;
} catch {
  // Not fatal: a fresh checkout runs postinstall before the editor is used.
  console.warn("[sync-vditor] vditor is not installed yet — skipping (run `pnpm install`).");
  process.exit(0);
}

const SRC = join(dirname(pkgPath), "dist");
const DEST_ROOT = join(ROOT, "public", "vditor");
const DEST = join(DEST_ROOT, "dist");
const STAMP = join(DEST_ROOT, ".version");

if (!existsSync(SRC)) {
  console.warn(`[sync-vditor] ${SRC} not found — skipping.`);
  process.exit(0);
}

if (existsSync(STAMP) && existsSync(DEST) && readFileSync(STAMP, "utf8").trim() === version) {
  console.log(`[sync-vditor] assets already vendored for vditor ${version}, skipping.`);
  process.exit(0);
}

rmSync(DEST_ROOT, { recursive: true, force: true });
mkdirSync(DEST_ROOT, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
writeFileSync(STAMP, `${version}\n`);
console.log(`[sync-vditor] vendored vditor ${version} → public/vditor/dist`);
