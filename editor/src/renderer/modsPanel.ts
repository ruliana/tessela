// The Mods panel ("Show the mods" in the palette): every mod, where it comes from, whether it loaded
// and what went wrong, and a switch for each. A switch is kept in the config folder's settings.json
// and takes effect when the window loads again, which "Apply and reload" does after saving what is open.

import { modRows } from "../shared/mods";
import { type Dialog, openDialog } from "./dialog";
import { el } from "./dom";
import { host, modsInfo, registry } from "./mods";

const STATUS = { loaded: "Loaded", failed: "Failed", off: "Off" } as const;

export function openModsPanel(): void {
  const info = modsInfo;
  const content = el("div", { class: "mods-panel" });
  const actions = [{ id: "cancel", label: "Close" }, { id: "apply", label: "Apply and reload", primary: true, disabled: true }];
  if (!info || info.disabled) {
    content.append(el("p", {}, info ? "Mods are switched off: the editor was started with --no-mods." : "The mods have not been looked for yet."));
    openDialog({ title: "Mods", content, actions: actions.slice(0, 1) });
    return;
  }
  let dialog: Dialog | undefined;
  const rows = modRows(info, registry.loaded, registry.failures);
  const wanted = new Map(rows.map((r) => [r.id, r.status !== "off"]));
  const changed = () => rows.some((r) => wanted.get(r.id) !== (r.status !== "off"));

  content.append(el("p", { class: "mods-folder" }, `Your mods go in ${info.folder}/mods/NAME/main.js.`));
  if (rows.length === 0) content.append(el("p", {}, "No mods are installed."));
  for (const r of rows) {
    const box = el("input", { type: "checkbox", checked: r.status !== "off", ariaLabel: `Use ${r.id}` });
    box.addEventListener("change", () => {
      wanted.set(r.id, box.checked);
      dialog?.setDisabled("apply", !changed());
    });
    const row = el(
      "div",
      { class: `mod-row ${r.status}` },
      el("label", { class: "mod-head" }, box, el("span", { class: "mod-name" }, r.id), el("span", { class: "mod-source" }, r.source === "app" ? "app" : "yours"), el("span", { class: "mod-status" }, STATUS[r.status])),
      ...r.errors.map((e) => el("div", { class: "mod-error" }, e)),
    );
    row.dataset.mod = r.id;
    content.append(row);
  }

  // The content is in the dialog before it opens, so the first switch has the focus.
  dialog = openDialog({ title: "Mods", content, actions });
  void dialog.closed.then(async (id) => {
    if (id !== "apply") return;
    try {
      for (const r of rows) if (wanted.get(r.id) !== (r.status !== "off")) await window.tessela.setModOff(r.id, !wanted.get(r.id));
      await host.flush();
      await window.tessela.reload();
    } catch (e) {
      host.toast(`The mods could not be changed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
