import { isAbsolute, resolve, sep } from "node:path";

/**
 * Splits a shell command into its simple subcommands the way Claude Code's permission check does,
 * so an approval can be judged per subcommand instead of "any `&&` means ask every time":
 *
 *  - a subcommand that only reads (ls, cat, grep, git status, curl to localhost, cd inside the
 *    workdir, …) and only touches paths inside --dir is `readOnly` and never needs a prompt;
 *  - any other subcommand gets a "don't ask again" `rule` like `Bash(npm test:*)`, or `null` when it
 *    must be asked every time (rm, kill, git push, interpreters' inline code, remote curl, …).
 *
 * Anything this can't read with confidence -- command substitution, heredocs, process
 * substitution, unbalanced quotes -- returns null, and the caller asks.
 */
export interface Subcommand {
  words: string[];
  readOnly: boolean;
  rule: string | null;
}

interface RawSub {
  words: string[];
  /** Words that contained an unquoted `$` expansion (value unknown until the shell runs it). */
  dynamic: boolean[];
  writes: boolean; // output redirected to a real file
  readsFrom: string[]; // `< file`
}

const SEPARATORS = new Set([";", "\n", "&&", "||", "|", "&", "(", ")"]);

function tokenize(command: string): RawSub[] | null {
  const subs: RawSub[] = [];
  let cur: RawSub = { words: [], dynamic: [], writes: false, readsFrom: [] };
  let word: string | null = null;
  let dyn = false;
  const flushWord = () => {
    if (word !== null) { cur.words.push(word); cur.dynamic.push(dyn); }
    word = null; dyn = false;
  };
  const flushSub = () => {
    flushWord();
    if (cur.words.length || cur.writes || cur.readsFrom.length) subs.push(cur);
    cur = { words: [], dynamic: [], writes: false, readsFrom: [] };
  };
  const readTarget = (i: number): [string, number] => {
    while (command[i] === " " || command[i] === "\t") i++;
    let t = "";
    while (i < command.length && !/[\s;&|()<>]/.test(command[i])) {
      const ch = command[i];
      if (ch === "'" || ch === '"') {
        const end = command.indexOf(ch, i + 1);
        if (end < 0) return ["", -1];
        t += command.slice(i + 1, end); i = end + 1; continue;
      }
      t += ch; i++;
    }
    return [t, i];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i], two = command.slice(i, i + 2);
    if (ch === "\\") {
      if (command[i + 1] === "\n") { i += 2; continue; } // line continuation
      word = (word ?? "") + (command[i + 1] ?? ""); i += 2; continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end); i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) { s += command[j + 1]; j += 2; continue; }
        if (command[j] === "`" || command.startsWith("$(", j)) return null;
        if (command[j] === "$") dyn = true;
        s += command[j]; j++;
      }
      if (j >= command.length) return null;
      word = (word ?? "") + s; i = j + 1; continue;
    }
    if (ch === "`" || two === "$(" || two === "<(" || two === ">(" || two === "<<") return null;
    if (ch === "$") dyn = true;
    if (ch === ">" || ch === "<") {
      // An fd prefix like the 2 in 2>&1 belongs to the operator, not to the command's words.
      if (word !== null && /^(\d+|&)$/.test(word)) word = null;
      else flushWord();
      let op = ch; i++;
      if (command[i] === ">") { op += ">"; i++; }
      if (command[i] === "&") { i++; const [fd, n] = readTarget(i); if (n < 0) return null; i = n; if (!/^\d+$/.test(fd) && fd !== "-") return null; continue; }
      const [target, n] = readTarget(i);
      if (n < 0 || !target) return null;
      i = n;
      if (target === "/dev/null") continue;
      if (op === "<") cur.readsFrom.push(target); else cur.writes = true;
      continue;
    }
    if (two === "&&" || two === "||") { flushSub(); i += 2; continue; }
    if (SEPARATORS.has(ch)) { flushSub(); i++; continue; }
    if (ch === " " || ch === "\t") { flushWord(); i++; continue; }
    word = (word ?? "") + ch; i++;
  }
  flushSub();
  return subs;
}

/** Commands that only read; the ones in PATH_READERS also get their path arguments checked. */
const ARG_FREE = new Set(["echo", "printf", "true", "false", "sleep", "pwd", "date", "which", "whoami", "ps", "test", "[", "uname", "id"]);
const PATH_READERS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "diff", "sort", "uniq", "cut", "stat", "file", "tree", "du", "sed", "less", "more", "jq", "md5sum", "sha256sum"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch", "remote"]);
/** Never generalised into a "don't ask again" rule: destructive, network-reaching, or runs other code. */
const NEVER_RULE = new Set([
  "rm", "rmdir", "dd", "shred", "chmod", "chown", "chgrp", "kill", "pkill", "killall", "shutdown", "reboot",
  "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "ftp", "sudo", "su", "doas", "env", "xargs", "eval",
  "exec", "time", "nohup", "timeout", "watch", "bash", "sh", "zsh", "dash", "fish", "source", ".", "crontab",
  // A rule is a prefix match on the first words, so these would stretch to far more than was seen:
  // a `find .` rule would also match a find that deletes, `sed -i` edits any file, `mv x` moves it
  // anywhere, and `cd` then anything.
  "cd", "find", "sed", "awk", "cp", "mv", "ln", "tee", "truncate", "install", "open", "xdg-open",
]);
/** Subcommands whose next word is what actually runs (`npm run build`, `npx vitest`). */
const RUNNER_SUBS = new Set(["run", "run-script", "exec", "x", "dlx"]);
const INTERPRETERS = /^(node|nodejs|python|python3|perl|ruby|php|deno|bun|lua|Rscript)$/;
/**
 * Package managers whose install/add/remove/update subcommand fetches and runs arbitrary
 * third-party code (postinstall scripts, setup.py, build.rs, gems' extconf.rb…) named by the
 * package argument. Unlike `npm run test`, where the script name is already-reviewed code from
 * package.json, the trust-relevant part here is the package name itself -- and it can't be
 * folded into a "don't ask again" rule safely: dropping it (as the generic 2-word rule does)
 * lets one approved install cover every future package, and keeping only the first of several
 * (the way RUNNER_SUBS keeps one script name) still silently approves whatever else rides
 * along after it (`npm install lodash evil-pkg` computes the identical rule as `npm install
 * lodash` alone). So, like `curl`'s remote URLs, these always ask.
 */
const PACKAGE_MANAGERS = new Set([
  "npm", "yarn", "pnpm", "pip", "pip3", "pipx", "gem", "bundle", "cargo", "go", "composer",
  "apt", "apt-get", "brew", "dnf", "yum", "conda",
]);
const PACKAGE_INSTALL_SUBS = new Set(["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "upgrade", "get", "ci", "sync", "reinstall"]);
// Also package managers: the first list missed these, and each of `bun add x`, `uv add x`,
// `uv pip install x`, `poetry add x`, `pipenv install x`, `deno install x` and
// `python3 -m pip install x` still produced one rule that covered any package (confirmed).
for (const pm of ["bun", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "pixi", "mamba", "micromamba", "deno",
  "ensurepip", "dotnet", "nuget", "mix", "cabal", "stack", "opam", "cpan", "cpanm", "luarocks", "vcpkg", "conan",
  "volta", "corepack", "choco", "winget", "scoop", "snap", "flatpak", "port", "pkg", "apk", "pacman", "zypper"]) {
  PACKAGE_MANAGERS.add(pm);
}

/** `npm install x`, `uv pip install x`, and the module form `python3 -m pip install x`: the
 * install-like word can sit one word further in than `sub`, behind a flag or a nested tool name. */
function installsPackages(cmd: string, args: string[]): boolean {
  let pm = cmd;
  let rest = args;
  // bun and deno are both runtimes and package managers, so only switch to the module form when
  // there actually is a `-m <module>`.
  const m = INTERPRETERS.test(cmd) ? args.indexOf("-m") : -1;
  if (m >= 0) {
    pm = args[m + 1] ?? "";
    rest = args.slice(m + 2);
  }
  if (!PACKAGE_MANAGERS.has(pm)) return false;
  return rest.filter((a) => !a.startsWith("-")).slice(0, 2).some((a) => PACKAGE_INSTALL_SUBS.has(a));
}
const GIT_NEVER = new Set(["push", "reset", "clean", "checkout", "rebase", "filter-branch", "gc", "prune", "restore", "switch", "am", "apply", "config", "remote", "submodule", "update-ref", "worktree"]);
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** `python3 -c`, `python3 -O -c`, `python3 -Bc`, `node -pe`, `node --eval=…`: code given on the
 * command line, anywhere among the flags before the script or module name. */
function runsInlineCode(args: string[]): boolean {
  for (const a of args) {
    if (!a.startsWith("-")) return false; // reached the script name: flags after it belong to the script
    if (/^--(eval|print|command)\b/.test(a) || /^-[A-Za-z]*[cep]/.test(a)) return true;
    if (a === "-m") return false; // a module is named by the next word, which the rule then includes
  }
  return false;
}

function insideDir(root: string, p: string): boolean {
  const r = resolve(root);
  const c = resolve(p);
  return c === r || c.startsWith(r + sep);
}

export function analyzeBash(command: string, workDir?: string): Subcommand[] | null {
  // Control bytes (ESC and friends) have no business in a command a person approves, and they'd ride
  // into rule text shown in the terminal prompt (confirmed: `npm run <ESC>[2J…` cleared the screen
  // from inside "don't ask again for …"). Never read-only, never a rule: always ask.
  if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(command)) return null;
  const raw = tokenize(command.trim());
  if (!raw || raw.length === 0) return null;
  let cwd = workDir;
  const pathOk = (arg: string, dynamic: boolean) => {
    if (dynamic || arg.startsWith("~") || !cwd || !workDir) return false;
    if (arg === "/dev/null") return true;
    return insideDir(workDir, isAbsolute(arg) ? arg : resolve(cwd, arg));
  };
  return raw.map((s): Subcommand => {
    // Leading VAR=value assignments: harmless alone, but they can change what a command does
    // (NODE_OPTIONS, LD_PRELOAD, PATH…), so a command behind one is never read-only or rule-able.
    let k = 0;
    while (k < s.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(s.words[k])) k++;
    const words = s.words.slice(k);
    const dynamic = s.dynamic.slice(k);
    if (!words.length) return { words: s.words, readOnly: !s.writes, rule: null };
    const [cmd, sub] = words;
    const args = words.slice(1);
    const readsOk = s.readsFrom.every((f) => pathOk(f, false));
    const plainArgsOk = () => args.every((a, idx) => a.startsWith("-") || pathOk(a, dynamic[idx + 1]));

    let readOnly = false;
    if (k === 0 && !s.writes && readsOk) {
      if (cmd === "cd") {
        const target = args[0] ?? "~";
        readOnly = pathOk(target, dynamic[1]);
        // After a cd we can't vouch for, every relative path that follows is somewhere unknown.
        cwd = readOnly && cwd ? (isAbsolute(target) ? target : resolve(cwd, target)) : undefined;
      } else if (ARG_FREE.has(cmd)) readOnly = true;
      else if (cmd === "git") readOnly = GIT_READ.has(sub ?? "") && args.slice(1).every((a) => !a.includes(".."));
      else if (cmd === "find") readOnly = !args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)) && args.every((a, idx) => a.startsWith("-") || !/^[/.~]/.test(a) || pathOk(a, dynamic[idx + 1]));
      else if (cmd === "sed") readOnly = !args.some((a) => /^-i|^--in-place/.test(a)) && plainArgsOk();
      else if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") {
        // The first non-flag argument is the pattern, not a path.
        const firstNonFlag = args.findIndex((a) => !a.startsWith("-"));
        readOnly = args.every((a, idx) => idx === firstNonFlag || a.startsWith("-") || pathOk(a, dynamic[idx + 1]));
      } else if (PATH_READERS.has(cmd)) readOnly = plainArgsOk();
      else if (cmd === "curl") {
        const urls = args.filter((a) => /^https?:\/\//.test(a));
        const outFlag = args.findIndex((a) => /^(-o|-O|--output|-T|--upload-file|--remote-name)$/.test(a));
        readOnly = urls.length > 0 && urls.every((u) => LOCAL_URL.test(u)) && (outFlag < 0 || args[outFlag + 1] === "/dev/null") && !args.some((a) => /^-[a-zA-Z]*[oOT]$/.test(a) && a !== "-o");
      }
    }

    let rule: string | null = null;
    if (k === 0 && !s.writes && !NEVER_RULE.has(cmd) && !(cmd === "git" && GIT_NEVER.has(sub ?? "")) &&
        !(INTERPRETERS.test(cmd) && runsInlineCode(args)) &&
        !installsPackages(cmd, args)) {
      const third = words[2];
      const wantThird = third !== undefined && !third.startsWith("-") && (sub?.startsWith("-") || RUNNER_SUBS.has(sub ?? ""));
      const used = wantThird ? 3 : sub !== undefined ? 2 : 1;
      // A rule word that expands at run time ($F, "$HOME/x") would match whatever it expands to.
      if (!dynamic.slice(0, used).some(Boolean)) rule = `Bash(${words.slice(0, used).join(" ")}:*)`;
    }
    return { words, readOnly, rule };
  });
}
