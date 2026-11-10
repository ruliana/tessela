// On macOS the app switcher and the Dock take the name and icon from the app bundle, not from
// the running code. `npm start` runs the stock node_modules/electron/dist/Electron.app, so it
// shows up as "Electron" with the Electron atom. This renames that bundle to Tessela and swaps
// in our icon. It only touches node_modules, does nothing off macOS, and is safe to rerun.
// Packaged builds don't need it: electron-builder uses productName and build/icon.icns.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

if (process.platform !== "darwin") process.exit(0);

const editor = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
let app;
try {
  // `electron` exports the path of its binary: .../Electron.app/Contents/MacOS/Electron
  app = resolve(dirname(require.resolve("electron")), "dist", "Electron.app");
} catch {
  process.exit(0);
}
const plist = resolve(app, "Contents", "Info.plist");
const icns = resolve(editor, "build", "icon.icns");
if (!existsSync(plist) || !existsSync(icns)) process.exit(0);

const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
const iconFile = execFileSync("plutil", ["-extract", "CFBundleIconFile", "raw", plist]).toString().trim();
const iconName = iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`;
const target = resolve(app, "Contents", "Resources", iconName);

const stamp = resolve(app, "Contents", "Resources", ".tessela-branded");
const marker = `${readFileSync(icns).length}`;
if (existsSync(stamp) && readFileSync(stamp, "utf8") === marker) process.exit(0);

set("CFBundleName", "Tessela");
set("CFBundleDisplayName", "Tessela");
copyFileSync(icns, target);
execFileSync("sh", ["-c", `printf %s ${marker} > '${stamp}'`]);
// Nudge Finder and the Dock to drop their cached icon for this bundle.
const now = new Date();
utimesSync(app, now, now);
console.log("branded", app, "as Tessela");
