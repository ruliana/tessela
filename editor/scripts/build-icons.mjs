// Renders the app icons from the SVG logos in ../assets/logo/. Run with `npm run icons`.
//
// There are two drawings. The full one (tessela-app-icon.svg) is used from 48px up, the
// simplified one (tessela-app-icon-small.svg: fewer, bigger tiles, no tone steps) at 32px and
// below, where the five tiles of the master would blur into each other.
//
// Writes, next to package.json:
//   build/icon.png, build/icon.ico, build/icon.icns   electron-builder picks these up
//   build/icons/<size>x<size>.png                     Linux (AppImage and deb)
//   src/renderer/public/icon.png                      the window icon, also used when run unpackaged
//
// It needs Chromium to rasterise the SVG. playwright-core finds none by itself, so point
// CHROME_PATH at a Chrome or Chromium binary (or use `npx playwright install chromium`).
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const logos = resolve(root, "../assets/logo");
const full = readFileSync(resolve(logos, "tessela-app-icon.svg"), "utf8");
const small = readFileSync(resolve(logos, "tessela-app-icon-small.svg"), "utf8");
const SMALL_UP_TO = 32;

const sizes = new Set([16, 24, 32, 48, 64, 128, 256, 512, 1024]);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
const png = new Map();
for (const size of sizes) {
  const svg = (size <= SMALL_UP_TO ? small : full).replace(/ width="\d+" height="\d+"/, ` width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg}</body>`);
  png.set(size, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();

const out = (...p) => resolve(root, ...p);
mkdirSync(out("build/icons"), { recursive: true });
mkdirSync(out("src/renderer/public"), { recursive: true });

writeFileSync(out("build/icon.png"), png.get(1024));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(out(`build/icons/${size}x${size}.png`), png.get(size));
writeFileSync(out("src/renderer/public/icon.png"), png.get(256));

// .ico: a directory of PNG images (supported since Windows Vista). 256 is stored as 0.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const entries = icoSizes.map((size) => {
  const data = png.get(size);
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size;
  e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
writeFileSync(out("build/icon.ico"), Buffer.concat([head, ...entries, ...icoSizes.map((s) => png.get(s))]));

// .icns: a list of typed chunks, here all PNG. The @2x types reuse the next size up.
const icns = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32], // 16@2x
  ["ic12", 64], // 32@2x
  ["ic13", 256], // 128@2x
  ["ic14", 512], // 256@2x
].map(([type, size]) => {
  const data = png.get(size);
  const h = Buffer.alloc(8);
  h.write(type, 0, "ascii");
  h.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([h, data]);
});
const total = 8 + icns.reduce((n, c) => n + c.length, 0);
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(total, 4);
writeFileSync(out("build/icon.icns"), Buffer.concat([icnsHead, ...icns]));

console.log(`icons written to ${out("build")}`);
