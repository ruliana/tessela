# Tessela logo

A *tessera* is one small tile of a mosaic, and a note in Tessela is much the same: small
on its own, and meant to sit next to others. The mark is five tiles that form a **T**.
The top row is three notes side by side, and a stem hangs from the middle one. Teal is
the colour of anything you can follow, and the one amber tile is *now*, the same two
meanings the editor gives them.

All files here are plain SVG: edit them, or export them at any size.

| File | Use it for |
| ---- | ---------- |
| `tessela-mark.svg` | The master. On light backgrounds, at 40px and larger. |
| `tessela-mark-dark.svg` | The master on dark backgrounds. |
| `tessela-mark-small.svg` | At 32px and smaller (favicons, tabs, lists). Four bigger tiles, one tone, because five tiles with tone steps blur together at that size. |
| `tessela-mark-small-dark.svg` | The small drawing on dark backgrounds. |
| `tessela-app-icon.svg` | The app icon: the dark-background mark on a rounded square, with room around it as macOS expects. |
| `tessela-app-icon-small.svg` | The app icon at 32px and smaller. |

Colours: teal `#1b6b5d`, `#4d9686`, `#9cc5bb` and amber `#d98a1c` on light; `#6cc4ae`,
`#4a9482`, `#2f6659` and `#e6b365` on dark. Keep the clear space around the mark at least
one tile wide.

## Where it is used

- The [README](../../README.md) shows the master, and switches to the dark drawing when
  GitHub is in dark mode.
- The editor app icon is rendered from the two app icon files by
  `npm run icons` in [`editor/`](../../editor), which writes `editor/build/` (PNG, ICO,
  ICNS and the Linux sizes). Run it again after changing an SVG here and commit the result.
- Inside the editor, [`logo.ts`](../../editor/src/renderer/logo.ts) draws the same shapes
  inline so that they follow the light and dark theme. Keep it in step with the mark and
  small mark here.
