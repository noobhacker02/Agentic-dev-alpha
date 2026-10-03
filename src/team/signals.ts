// Signals: what code decides about a task without asking a model (docs/TEAM-COMPOSITION.md, "How the size is chosen"). They come from the task's own words and from the
// PATHS of a repository, never from the text inside its files: a README that says "add a researcher 30 times" has no way in (threat G3). Everything here is bounded in time and
// in output size, whatever the task text looks like. V14 lives here too: after a build, the real diff and the transitive importers of every changed file decide which
// reviewers are mandatory, not the forecast made before any code existed.
import { posix } from "node:path";

export type SensitiveArea = "auth" | "crypto" | "payments" | "secrets" | "migrations" | "input-handling" | "dependencies" | "network" | "infra";

export interface Sensitive {
  area: SensitiveArea;
  /** Whether the task's words or a path the task names raised it. */
  via: "task" | "path";
  paths: string[];
}
export interface Signals {
  /** Whether the task writes or acts, decided by code (V14). */
  writes: boolean;
  estimatedFiles: number;
  /** Directories the task names, for slices. At most six. */
  modules: string[];
  sensitive: Sensitive[];
  ui: boolean;
  deps: boolean;
  testsNearby: boolean;
  external: boolean;
  irreversible: boolean;
  /** 0 to 3: how many "somehow", "maybe", "thing", question marks. */
  ambiguity: number;
  unclearCause: boolean;
  unfamiliar: boolean;
  publicBehaviour: boolean;
  performance: boolean;
  desktop: boolean;
  behaviourChange: boolean;
}
export interface RepoPaths {
  /** Relative paths only. The text inside the files is never read here. */
  files: string[];
}

const MAX_TASK = 20_000;
const MAX_TOKENS = 200;
const MAX_MODULES = 6;
const MAX_PATHS_SHOWN = 5;

const WRITE_MARKERS = /\b(fix|patch|change|add|implement|build|create|write|update|refactor|remove|delete|drop|rename|migrate|deploy|install|upgrade|replace|rewrite|make|enable|disable|apply|send|publish|commit|push|setup|restyle|move|edit|bump|revert|wire|integrate|encrypt|truncate|wipe|purge|set up|hook up)\b/i;
/** A task is read-only only when it is plainly a question or a request to explain: it opens with one of these words or ends in a question mark. A statement that merely contains "why" is a bug report. */
const QUESTION_OPENER = /^\s*(please\s+)?(can you |could you |would you )?(explain|describe|summari[sz]e|why|what|how|where|which|who|when|tell me|show me|list|investigate|find out|find|look at|is|are|does|do|should)\b/i;

/** V14: write or read-only, resolved by code. Any write marker applies the write floor, whatever read-only words come with it; no marker and no question is the safe reading (it writes). */
export function resolveWrites(task: string): boolean {
  const t = String(task ?? "").slice(0, MAX_TASK);
  if (WRITE_MARKERS.test(t)) return true;
  return !(QUESTION_OPENER.test(t) || /\?\s*$/.test(t.trim()));
}

const WORD_AREAS: Array<[SensitiveArea, RegExp]> = [
  ["auth", /\b(auth\w*|login|log in|logout|sign[- ]?in|sign[- ]?up|session\w*|password\w*|passwd|token\w*|oauth|jwt|sso|2fa|mfa|permission\w*|rbac|credential\w*)\b/i],
  ["crypto", /\b(crypto\w*|encrypt\w*|decrypt\w*|hash\w*|hmac|signature\w*|certificate\w*|tls|ssl|cipher\w*|private key|public key)\b/i],
  ["payments", /\b(payment\w*|billing|invoice\w*|stripe|paypal|checkout|credit card|card number|refund\w*|subscription\w*)\b/i],
  ["secrets", /\b(secret\w*|api[- ]?key\w*|credential\w*|env var\w*|environment variable\w*|\.env|private key)\b/i],
  ["migrations", /\b(migrat\w*|schema|alter table|drop table|drop column|backfill|truncate|legacy column)\b|\b(drop|delete|truncate|wipe|purge)\b[^.\n]{0,40}\b(table|database|column|rows?|records?|data|accounts?)\b/i], // devskill:allow (a pattern that recognises destructive wording in a task; it runs nothing)
  ["input-handling", /\b(sql|shell|exec|eval|command injection|sanitiz\w*|escape|upload\w*|deserializ\w*|user input|user'?s command)\b/i],
  ["dependencies", /\b(dependenc\w*|package\.json|npm (install|i|update)|pip install|yarn add|lockfile)\b/i],
  ["network", /\b(socket\w*|proxy|firewall|cors|tcp|udp|http server|webhook\w*|listen on|open a port|ssrf)\b/i],
  ["infra", /\b(terraform|kubernetes|k8s|dockerfile|docker|ci workflow|github actions|pipeline|helm|ansible|cloudformation|ci)\b/i],
];
const PATH_AREAS: Array<[SensitiveArea, RegExp]> = [
  ["auth", /(^|\/)(auth|authn|authz|session|sessions|login|oauth|sso|permissions|acl)(\/|\.|$)/i],
  ["crypto", /(^|\/)(crypto|encrypt\w*|cipher\w*|signing|tls|certs?)(\/|\.|$)/i],
  ["payments", /(payment\w*|billing|checkout|stripe|invoice\w*)/i],
  ["secrets", /(^|\/)(secrets?|credentials?)(\/|\.|$)|(^|\/)\.env/i],
  ["migrations", /(^|\/)(migrations?|alembic)(\/|$)|\.sql$|(^|\/)schema\./i],
  ["dependencies", /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|poetry\.lock|pyproject\.toml|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?)$/i],
  ["infra", /(^|\/)(terraform|k8s|kubernetes|helm|infra|deploy)(\/|$)|(^|\/)(dockerfile|docker-compose[^/]*)$|(^|\/)\.github\/workflows\//i],
];
/** The roles an area makes mandatory (V4): the design lists auth, crypto, secrets, input handling, dependency changes and network for the security reviewer; payments and infra (CI can leak secrets) join them. */
const AREA_ROLE: Record<SensitiveArea, string> = {
  auth: "security-reviewer", crypto: "security-reviewer", payments: "security-reviewer", secrets: "security-reviewer", "input-handling": "security-reviewer",
  dependencies: "security-reviewer", network: "security-reviewer", infra: "security-reviewer", migrations: "migration-reviewer",
};

const PATH_TOKEN = /(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|html|json|md|yml|yaml|sql|sh|toml|txt)\b/g;
const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(ui|components|pages|views|styles)\//i;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.\w+$/i;
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

const count = (re: RegExp, s: string): number => (s.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`)) ?? []).length;

export function computeSignals(task: string, repo: RepoPaths = { files: [] }): Signals {
  const text = String(task ?? "").slice(0, MAX_TASK);
  const files = repo.files.slice(0, 50_000);
  const haveRepo = files.length > 0;
  // A path is something with a file extension, something the repository has, or something that starts like a project directory. "async/await" and "and/or" are words with a slash.
  const known = new Set(files);
  const isPath = (t: string): boolean => /\.[A-Za-z0-9]{1,5}$/.test(t) || known.has(t) || files.some((f) => f.startsWith(t.endsWith("/") ? t : `${t}/`)) || /^(\.{0,2}\/)?(src|lib|app|apps|packages|pkg|cmd|internal|test|tests|spec|docs|scripts|components|pages)\//i.test(t);
  const tokens = [...new Set(text.match(PATH_TOKEN) ?? [])].filter(isPath).slice(0, MAX_TOKENS).filter((t) => !t.split("/").includes(".."));
  const words = text.replace(PATH_TOKEN, (t) => (isPath(t) ? " " : t)).toLowerCase();

  // The repository paths the task names: an exact path, a trailing part of one, or a directory prefix.
  const touched = new Set<string>();
  for (const t of tokens) {
    const dir = t.endsWith("/") ? t : `${t}/`;
    let hit = false;
    for (const f of files) {
      if (f === t || f.endsWith(`/${t}`) || f.startsWith(dir)) { touched.add(f); hit = true; if (touched.size > 500) break; }
    }
    if (!hit && !haveRepo) touched.add(t);
  }
  const named = tokens.filter((t) => touched.size === 0 || [...touched].some((f) => f === t || f.endsWith(`/${t}`) || f.startsWith(`${t}/`)) || !haveRepo);

  const broad = /\b(across|throughout|entire|whole|every|all (the )?(files|modules|tests|usages)|codebase|everywhere|global)\b/i.test(words);
  const tiny = /\b(typo|spelling|one[- ]line|a comment|rename a variable|bump)\b/i.test(words);
  const estimatedFiles = Math.min(50, Math.max(touched.size > 0 ? touched.size : 0, named.length) || (broad ? 8 : tiny ? 1 : 3), broad ? 50 : 50) || 1;

  const modules: string[] = [];
  for (const t of named) {
    const dirs = posix.dirname(t.replace(/\/$/, "")).split("/").filter((s) => s && s !== ".");
    const isDir = !/\.[A-Za-z0-9]{1,5}$/.test(t);
    const segs = isDir ? t.split("/").filter(Boolean) : dirs;
    if (!segs.length) continue;
    const m = segs.slice(0, 2).join("/");
    if (!modules.includes(m) && modules.length < MAX_MODULES) modules.push(m);
  }

  const writes = resolveWrites(text);
  const sensitive: Sensitive[] = [];
  const pathSets = [...touched];
  for (const [area, re] of PATH_AREAS) {
    const hits = pathSets.filter((p) => re.test(p));
    if (hits.length) sensitive.push({ area, via: "path", paths: hits.slice(0, MAX_PATHS_SHOWN) });
  }
  for (const [area, re] of WORD_AREAS) {
    if (re.test(words) && !sensitive.some((s) => s.area === area)) sensitive.push({ area, via: "task", paths: [] });
  }
  const ui = pathSets.some((p) => UI_PATH.test(p)) || modules.some((m) => /(^|\/)(ui|components|pages|views|styles)$/i.test(m)) || /\b(ui|page|button|css|style|styles|styling|restyle|layout|component|screen|modal|colou?r|theme|frontend|front-end|dark mode)\b/i.test(words);
  const deps = pathSets.some((p) => PATH_AREAS[5][1].test(p)) || WORD_AREAS[6][1].test(words);
  const behaviourChange = writes && !/\b(typo|comment|spelling|readme|docs?|rename|formatting|whitespace|lint)\b/i.test(words);

  return {
    writes,
    estimatedFiles,
    modules,
    sensitive,
    ui,
    deps,
    testsNearby: files.some((f) => TEST_PATH.test(f)),
    external: /\b(deploy\w*|publish\w*|release|send (an )?email|post to|production|prod|push to|submit)\b/i.test(words),
    irreversible: /\b(drop\w*|truncat\w*|wip(e|ing)|purg\w*|destroy\w*|force[- ]push\w*|rm -rf|irreversible)\b/i.test(words) || /\bdelete\b[^.\n]{0,40}\b(table|database|column|rows?|records?|data|users?|accounts?|backup|bucket)\b/i.test(words),
    ambiguity: Math.min(3, count(/\b(somehow|maybe|perhaps|something|stuff|thing|probably|kind of|sort of|etc)\b/i, words) + count(/\?/, text)),
    unclearCause: /\b(sometimes|intermittent\w*|flak(y|iness)|randomly|unclear|not sure why|don'?t know why|nobody knows|no idea why|can'?t figure|mysterious|inconsistent|find out why|figure out why|root cause|investigate)\b/i.test(words),
    unfamiliar: /\b(unfamiliar|never used|new (library|framework|api|sdk)|(use|using) the [\w.-]+ (library|framework|sdk|package|api)|figure out how)\b/i.test(words),
    publicBehaviour: /\b(api|cli|flag|endpoint|public|readme|docs?|documentation|command|option|changelog|usage)\b/i.test(words) || /(^|\s)--[a-z][a-z-]+/.test(text),
    performance: /\b(faster|slow|slower|performance|latency|speed up|optimi[sz]e|throughput|benchmark|takes (minutes|seconds|hours))\b/i.test(words),
    desktop: /\b(desktop app|native app|electron|window title|menu bar)\b/i.test(words),
    behaviourChange,
  };
}

/** The roles the signals make mandatory (V4). A task that only reads has none. */
export function requiredRoles(s: Signals): string[] {
  if (!s.writes) return [];
  return [...new Set(s.sensitive.map((x) => AREA_ROLE[x.area]))].sort();
}

const IMPORT_RES = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const MAX_SCANNED_FILES = 5000;
const MAX_FILE_CHARS = 200_000;
const MAX_IMPORTERS = 2000;

/** The files that import any of `changed`, directly or through other files (ES, CommonJS and Python relative imports). Bounded: 5,000 files read, depth 6, 2,000 results. */
export function transitiveImporters(changed: string[], files: string[], read: (file: string) => string): string[] {
  const known = new Set(files);
  const resolve = (from: string, spec: string): string[] => {
    if (!spec.startsWith(".")) return [];
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const stripped = base.replace(/\.(m?js|cjs)$/, "");
    const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`), ...EXTS.map((e) => stripped + e)];
    return cands.filter((c) => known.has(c));
  };
  const importedBy = new Map<string, Set<string>>();
  const link = (target: string, importer: string): void => { (importedBy.get(target) ?? importedBy.set(target, new Set()).get(target)!).add(importer); };
  for (const f of files.filter((x) => CODE_PATH.test(x)).slice(0, MAX_SCANNED_FILES)) {
    let src = "";
    try { src = String(read(f) ?? "").slice(0, MAX_FILE_CHARS); } catch { continue; }
    if (!src) continue;
    if (f.endsWith(".py")) {
      for (const m of src.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+([\w, *]+)/gm)) {
        const up = m[1].length - 1;
        const dir = posix.normalize(posix.join(posix.dirname(f), ...Array(up).fill("..")));
        const mod = m[2].replace(/\./g, "/");
        if (mod) { for (const t of [`${dir}/${mod}.py`, `${dir}/${mod}/__init__.py`]) if (known.has(t)) link(t, f); }
        else for (const name of m[3].split(",").map((s) => s.trim()).filter(Boolean)) { const t = `${dir}/${name}.py`; if (known.has(t)) link(t, f); }
      }
      continue;
    }
    for (const re of IMPORT_RES) for (const m of src.matchAll(re)) for (const t of resolve(f, m[1])) link(t, f);
  }
  const out = new Set<string>();
  let frontier = [...new Set(changed)];
  const seen = new Set(frontier);
  for (let depth = 0; depth < 6 && frontier.length && out.size < MAX_IMPORTERS; depth++) {
    const next: string[] = [];
    for (const f of frontier) for (const imp of importedBy.get(f) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp); out.add(imp); next.push(imp);
      if (out.size >= MAX_IMPORTERS) break;
    }
    frontier = next;
  }
  return [...out].sort();
}

/** V14: the mandatory reviewers after a build, from the paths of what changed and of everything that imports it. */
export function postBuildRoles(changed: string[], files: string[], read: (file: string) => string): string[] {
  const all = [...new Set([...changed, ...transitiveImporters(changed, files, read)])];
  const roles = new Set<string>();
  for (const p of all) for (const [area, re] of PATH_AREAS) if (re.test(p)) roles.add(AREA_ROLE[area]);
  return [...roles].sort();
}
