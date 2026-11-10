// The pure parts of the folders mod: what `tessela index --dir` answers, and the words and paths
// the view makes from it.

export interface PageEntry {
  path: string;
  title: string;
  description?: string | null;
  type?: string | null;
}

export interface FolderEntry {
  path: string;
  pages: number;
  has_home: boolean;
}

/** What `tessela index --dir` answers for one folder. */
export interface Listing {
  ok: true;
  dir: string;
  home: string | null;
  links: PageEntry[];
  folders: FolderEntry[];
  pages: PageEntry[];
  journal: PageEntry[];
}

/** How many journal days the view lists before saying how many more there are. */
export const JOURNAL_SHOWN = 5;

/** A folder path as the CLI wants it: no slashes at the ends, "" for the root. */
export function cleanDir(dir: string | undefined): string {
  return (dir ?? "").replace(/^\/+|\/+$/g, "");
}

/** The folder a page is in ("" for the root). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** The folders from the root down to `dir`: `{name, path}` each; the root is `{name: "", path: ""}`. */
export function trail(dir: string): { name: string; path: string }[] {
  const parts = cleanDir(dir).split("/").filter(Boolean);
  return [{ name: "", path: "" }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))];
}

/** The path of the home page a folder would have. */
export function homePath(dir: string): string {
  return dir ? `${dir}/home.md` : "home.md";
}

/** The title a new home page starts with: the folder's name, or "Home" for the root. */
export function homeTitle(dir: string): string {
  const name = cleanDir(dir).split("/").pop() ?? "";
  return name === "" ? "Home" : `${name[0]?.toUpperCase()}${name.slice(1)} home`;
}

/** The last part of a path, as a folder's row shows it. */
export function leaf(path: string): string {
  return path.split("/").pop() ?? path;
}

export const pagesIn = (n: number): string => `${n} ${n === 1 ? "page" : "pages"}`;
