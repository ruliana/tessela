// Acceptance tests: every feature of the editor (spec §11) driven in a real window.
// Run with `npm run e2e:acceptance` (needs a display: `xvfb-run -a npm run e2e:acceptance`).
// ONLY=regex runs the tests whose "suite name" matches, e.g. ONLY="Tab and" or ONLY=Undo.

import { runAll } from "./harness.mjs";
import "./acceptance/journals.mjs";
import "./acceptance/navigation.mjs";
import "./acceptance/search.mjs";
import "./acceptance/blocks.mjs";
import "./acceptance/format.mjs";
import "./acceptance/menus.mjs";
import "./acceptance/syntax.mjs";
import "./acceptance/preview.mjs";
import "./acceptance/files.mjs";

await runAll();
