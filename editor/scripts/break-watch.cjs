// Preload for a repro: makes every fs.watch fail with EMFILE a second after it starts, as macOS
// does when the whole machine has run out of folder watchers (fseventsd: "too many clients").
const fs = require("node:fs");
const real = fs.watch;
fs.watch = (...args) => {
  const w = real(...args);
  setTimeout(() => w.emit("error", Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" })), 1000);
  return w;
};
// Without this, Electron shows the "A JavaScript error occurred in the main process" dialog and
// waits for a click; here the error is printed and the app stops, as it does after the click.
process.on("uncaughtException", (err) => {
  console.log(`UNCAUGHT in the main process: ${err.message}`);
  process.exit(1);
});
