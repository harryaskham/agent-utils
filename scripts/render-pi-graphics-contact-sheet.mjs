#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderPiGraphicsContactSheet } from "../extensions/pi-graphics/components.js";

const out = resolve(process.argv[2] || "./pi-graphics-contact-sheet.png");
const sheet = renderPiGraphicsContactSheet({ columns: 36, rows: 6, gapPx: 12 });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, sheet.png);
console.log(JSON.stringify({ out, widthPx: sheet.widthPx, heightPx: sheet.heightPx, tileCount: sheet.tileCount, bytes: sheet.png.length }, null, 2));
