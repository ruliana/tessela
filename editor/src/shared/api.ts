// The contract between the Electron main process and the window. Everything the
// window knows about the notes comes through these calls; it never reads files itself.

export type HitKind = "block" | "heading" | "page";

/** One result of `tessela query --json`. */
export interface Hit {
  kind: HitKind;
  handle: string;
  page: string;
  path: string;
  page_type: string | null;
  line: number;
  heading_path: string[];
  text: string;
  refs: string[];
  path_refs: string[];
  dates: string[];
  parent: string | null;
  /** The hit is on a `home.md` page. Absent from older `tessela` builds. */
  home?: boolean;
  /** When the hit's file was last changed, in ms since the epoch. Absent from older `tessela` builds. */
  modified?: number;
}

/** One concept from `tessela vocab --json`. */
export interface VocabEntry {
  concept: string;
  has_page: boolean;
  mentions: number;
  pages: number;
  deprecated: boolean;
  use_instead: string | null;
  note: string | null;
}

export type Severity = "error" | "warning" | "info";

/** One finding of `tessela lint --json`. `path` is relative to the bundle. */
export interface Diagnostic {
  rule: string;
  severity: Severity;
  path: string;
  line: number | null;
  message: string;
}

export interface QueryArgs {
  refs?: string[];
  any?: boolean;
  own?: boolean;
  text?: string;
  type?: string;
  page?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** A page of the bundle, from `tessela pages --json`. `path` is relative, with `/` separators. */
export interface PageEntry {
  id: string;
  path: string;
  /** What the page calls itself (front matter `title:`, else its first `#` heading, else its file name). */
  title?: string;
  type?: string | null;
}

export interface PageFile {
  path: string;
  /** False for a page that has no file yet; `text` is then a template. */
  exists: boolean;
  text: string;
  /** Hash of the text on disk, or null when the file does not exist. */
  hash: string | null;
}

export type WriteResult =
  | { ok: true; hash: string }
  | { ok: false; reason: "conflict"; diskHash: string | null };

/** What choosing a Markdown file on disk led to. */
export type OpenFileResult =
  | { kind: "canceled" }
  | { kind: "page"; path: string }
  /** The file is not under the bundle folder; `folder` is the one that holds it. */
  | { kind: "outside"; folder: string }
  /** The file is inside the bundle but is not a page the editor can open. */
  | { kind: "unsupported"; reason: string };

/** The mods installed in the config folder (mods/<id>/main.js). */
export interface ModsInfo {
  /** The config folder: mods live in its `mods/` folder. */
  folder: string;
  /** Started with `--no-mods`: `ids` is then empty. */
  disabled: boolean;
  ids: string[];
}

export interface Api {
  bundle(): Promise<string | null>;
  /** Asks for the notes folder (the bundle root) and switches to it. Returns the folder now in use. */
  chooseBundle(): Promise<string | null>;
  /** Asks for a Markdown file; the caller opens it when it is `kind: "page"`. */
  openFile(): Promise<OpenFileResult>;
  /** Makes `folder` the notes folder, e.g. after `openFile` found a file outside the current one. */
  useFolder(folder: string): Promise<string | null>;
  listPages(): Promise<PageEntry[]>;
  vocab(): Promise<VocabEntry[]>;
  query(args: QueryArgs): Promise<Hit[]>;
  lint(): Promise<Diagnostic[]>;
  /** A page without a file comes back with `exists: false` and the template for a new one. */
  readPage(path: string): Promise<PageFile>;
  /** Writes only if the file on disk still has `expectedHash` (null: must not exist). */
  writePage(path: string, text: string, expectedHash: string | null): Promise<WriteResult>;
  /** Creates a page from the template. False when the page already exists. */
  addPage(path: string, title?: string): Promise<boolean>;
  /** Opens a web or mail address in the system's own program. Other addresses are ignored. */
  openExternal(url: string): Promise<void>;
  /** Path of today's journal, in local time. */
  todayPath(): Promise<string>;
  /** Which mods the window should load. */
  mods(): Promise<ModsInfo>;
  /**
   * Runs a `tessela` command on the open notes folder for a mod and returns its JSON answer,
   * `{api, ok, ...}`; a failure (`ok: false`) is an answer too. The folder, `--json` and the API
   * version are added (the folder first for lint, query, index, vocab and pages, else as `--bundle`).
   * `input` goes to the command's standard input: text, or the bytes of a file (for `attach`).
   */
  cli(argv: string[], input?: string | Uint8Array): Promise<unknown>;
  /** Called with the paths (relative) of pages that changed on disk. Returns an unsubscribe. */
  onChanged(listener: (paths: string[]) => void): () => void;
}

declare global {
  interface Window {
    tessela: Api;
  }
}
