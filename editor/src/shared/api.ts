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

/** A page file in the bundle. `path` is relative, with `/` separators. */
export interface PageEntry {
  id: string;
  path: string;
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

export interface Api {
  bundle(): Promise<string | null>;
  chooseBundle(): Promise<string | null>;
  listPages(): Promise<PageEntry[]>;
  vocab(): Promise<VocabEntry[]>;
  query(args: QueryArgs): Promise<Hit[]>;
  readPage(path: string): Promise<PageFile>;
  /** Writes only if the file on disk still has `expectedHash` (null: must not exist). */
  writePage(path: string, text: string, expectedHash: string | null): Promise<WriteResult>;
  /** Path of today's journal, in local time. */
  todayPath(): Promise<string>;
  /** Called with the paths (relative) of pages that changed on disk. Returns an unsubscribe. */
  onChanged(listener: (paths: string[]) => void): () => void;
}

declare global {
  interface Window {
    tessela: Api;
  }
}
