// Runs a packaged Tessela app for a few minutes on a git copy of a notes folder, while other
// programs change files in it, under the 256 open-file limit that Finder gives apps.
// It checks what a user sees: does a change made outside still reach the open window, is the
// app alive at the end, and does its open-file count (`lsof -p`) stay flat?
//
//   zsh -c 'ulimit -H -n 256; ulimit -S -n 256; node scripts/repro-watch-limit.mjs --app /Applications/Tessela.app'
// (Set the hard limit too: Node raises its own soft limit to the hard one when it starts.)
//
// Options: --minutes 5 (default)   --source <git folder or URL to clone; default: made-up notes>
// To see the failure itself without starving the machine's watchers, run the built main process with
// scripts/break-watch.cjs (every fs.watch fails with EMFILE after 1 s):
//   npm run build:app && electron --no-sandbox -r $PWD/scripts/break-watch.cjs dist/main.cjs --bundle=<folder>
// On macOS the watcher also fails when the whole machine has run out of folder watchers
// (fseventsd: "too many clients in system (limit 1024)"); the script says whether fs.watch works.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const appPath = resolve(opt("--app", "/Applications/Tessela.app"));
const minutes = Number(opt("--minutes", "5"));
const source = opt("--source", null);

const exe = join(appPath, "Contents/MacOS/Tessela");
process.env.E2E_PACKAGED = exe;
const { launch, makeBundle, front } = await import("../e2e/harness.mjs");

const git = (dir, ...a) =>
  execFileSync("git", ["-c", "user.name=repro", "-c", "user.email=repro@invalid", "-c", "core.fsmonitor=false", ...a], { cwd: dir, stdio: "pipe" });

function makeNotes() {
  if (source) {
    const dir = join(mkdtempSync(join(tmpdir(), "tessela-repro-")), "notes");
    execFileSync("git", ["clone", "-q", source, dir]);
    return dir;
  }
  const dir = makeBundle({ "people/ana.md": `${front("person")}Ana.\n` });
  for (let f = 0; f < 76; f++) {
    mkdirSync(join(dir, `folder-${f}`));
    for (let p = 0; p < 25; p++) writeFileSync(join(dir, `folder-${f}/page-${p}.md`), `${front()}Page ${p}.\n`);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "start");
  return dir;
}

function fsWatchWorks() {
  const dir = mkdtempSync(join(tmpdir(), "tessela-fswatch-"));
  return new Promise((done) => {
    try {
      const w = watch(dir, { recursive: true }, () => {});
      w.on("error", (e) => done(`fails: ${e.message}`));
      setTimeout(() => (w.close(), done("works")), 500);
    } catch (e) {
      done(`fails: ${e.message}`);
    }
  });
}

const openFiles = (pid) => spawnSync("lsof", ["-p", String(pid)]).stdout.toString().split("\n").length - 2;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const limit = execFileSync("sh", ["-c", "ulimit -n"]).toString().trim();
console.log(`app: ${appPath}\nopen-file limit of this shell: ${limit} (run under 256 to match Finder)`);
console.log(`fs.watch on a folder from this machine: ${await fsWatchWorks()}`);

const notes = makeNotes();
// The page the window shows, and other pages that get edits and commits behind it.
const pages = git(notes, "ls-files", "*.md").toString().split("\n").filter(Boolean);
const shown = pages.includes("people/ana.md") ? "people/ana.md" : pages[0];
const others = pages.filter((p) => p !== shown);
const frontOf = (page) => (page === "people/ana.md" ? front("person") : `${readFileSync(join(notes, page), "utf8").match(/^---\n[\s\S]*?\n---\n\n?/)?.[0] ?? front()}`);
const stuck = (what) => new Promise((_, no) => setTimeout(() => no(new Error(`${what} did not finish in 60 s`)), 60_000));
let s;
try {
  s = await Promise.race([launch(notes), stuck("the app window")]);
  await Promise.race([s.open(shown.replace(/\.md$/, "")), stuck("opening a page")]);
} catch (err) {
  // A main process that is stuck behind its own error dialog never shows the window.
  console.log(`FAIL: ${err.message}`);
  spawnSync("pkill", ["-f", exe]);
  process.exit(1);
}
const pid = s.app.process().pid;
console.log(`notes: ${notes}\napp pid ${pid}, ${openFiles(pid)} open files at start`);

const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 1000);
s.app.process().on("exit", (code, signal) => console.log(`t=${seconds()}s the app exited: code=${code} signal=${signal}`));
const counts = [openFiles(pid)];
let delivered = 0;
let missed = 0;
const end = Date.now() + minutes * 60_000;
for (let i = 1; Date.now() < end && alive(pid); i++) {
  const marker = `outside-change-${i}`;
  writeFileSync(join(notes, shown), `${frontOf(shown)}${marker}\n`);
  for (let p = 0; p < 3; p++) appendFileSync(join(notes, (others.length ? others[(i * 3 + p) % others.length] : shown)), `\nedit ${i}\n`);
  if (i % 3 === 0) git(notes, "add", "-A"), git(notes, "commit", "-qm", `c${i}`);
  if (i % 12 === 0) git(notes, "gc", "-q");
  try {
    await s.win.waitForFunction((m) => document.querySelector(".cm-content")?.textContent?.includes(m), marker, { timeout: 10_000 });
    delivered++;
  } catch {
    missed++;
  }
  counts.push(openFiles(pid));
  if (i % 3 === 0) console.log(`t=${seconds()}s alive=${alive(pid)} open files=${counts.at(-1)} delivered=${delivered} missed=${missed}`);
  await new Promise((r) => setTimeout(r, 5000));
}

const isAlive = alive(pid);
console.log(`\nend: alive=${isAlive}, changes that reached the window=${delivered}, missed=${missed}`);
console.log(`open files: first=${counts[0]} last=${counts.at(-1)} min=${Math.min(...counts)} max=${Math.max(...counts)}`);
// The first minute opens the window and its helpers; judge growth after that.
const steady = counts.slice(12);
console.log(`open files, first minute max=${Math.max(...counts.slice(0, 12))}, after it max=${Math.max(...steady)}`);
const flat = steady.length === 0 || Math.max(...steady) <= Math.max(...counts.slice(0, 12)) + 5;
const ok = isAlive && missed === 0 && flat;
console.log(ok ? "PASS" : "FAIL");
await s.app.close().catch(() => {});
process.exit(ok ? 0 : 1);
