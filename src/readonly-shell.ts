// Which shell commands run without asking a human. "Read-only" here is an allow-list of safe FORMS, not a list of names (adversary round 2, A51): a command name says little, because
// the same `sed` that prints a line can run a program (`1e CMD`), write a file (`w`), and the same `rg` can run a preprocessor (`--pre`). A form that is not recognised asks, and
// asking is the safe default. Every path a command names is judged by where it really is (links followed), and a word the shell will rewrite before the command sees it (a glob, a
// brace expansion, a tilde, a variable) is a word this analysis cannot see, so it asks too.

export interface ReadOnlyEnv {
  /** Whether this word, as a path, is inside the working directory by its real location. False for anything else. */
  pathOk: (arg: string) => boolean;
}

const isFlag = (a: string): boolean => a.startsWith("-") && a !== "-";
/** Short flags of a cluster like `-la` or `-n5`: true when any letter of any short-flag word is one of `chars`. */
const hasShort = (args: string[], chars: string): boolean => args.some((a) => /^-[A-Za-z0-9]+$/.test(a) && [...a.slice(1)].some((c) => chars.includes(c)));
const hasLong = (args: string[], names: string[]): boolean => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
const positional = (args: string[]): string[] => args.filter((a) => !isFlag(a));

/** A flag that carries a path in the same word (`--file=/etc/passwd`, `-f/etc/passwd`, `-O../x`) is judged like any other path. */
function attachedPathsOk(args: string[], env: ReadOnlyEnv): boolean {
  return args.every((a) => {
    if (!isFlag(a)) return true;
    const value = a.startsWith("--") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined) : /^-[A-Za-z]./.test(a) ? a.slice(2).replace(/^=/, "") : undefined;
    if (value === undefined || value === "") return true;
    return /^[/~]|\.\.|^[A-Za-z]:/.test(value) ? env.pathOk(value) : true;
  });
}
const pathsOk = (args: string[], env: ReadOnlyEnv): boolean => attachedPathsOk(args, env) && positional(args).every((a) => env.pathOk(a));

// ---- sed: a plain print, delete or quit, or one substitution with flags that cannot run or write anything
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/)`;
const SED_RANGE = String.raw`(?:${SED_ADDR}(?:,${SED_ADDR})?)?`;
const SED_SIMPLE = new RegExp(String.raw`^\s*${SED_RANGE}\s*[pdq]\s*$`);
const SED_FLAGS_OK = new Set(["-n", "-E", "-r", "-s", "-u", "-z", "--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data", "--posix"]);
const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `1,5p`, `$d`, `/x/p`, `s/a/b/g`, `s|a|b|`: yes. `e`, `w`, `r`, `R`, `W`, `x`, a second command, a script file: no. The flags of `s` are g p i I m M and digits: not `e` and not `w`. */
export function sedScriptOk(script: string): boolean {
  if (SED_SIMPLE.test(script)) return true;
  const lead = script.match(new RegExp(String.raw`^\s*${SED_RANGE}\s*s([^\w\s\\])`));
  if (!lead) return false;
  const d = escapeRe(lead[1]);
  return new RegExp(String.raw`^\s*${SED_RANGE}\s*s${d}(?:(?!${d}).)*${d}(?:(?!${d}).)*${d}[gpiImM0-9]*\s*$`).test(script);
}

function sedOk(args: string[], env: ReadOnlyEnv): boolean {
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    const a = args[i];
    // a cluster such as -nE is each of its letters
    const letters = /^-[A-Za-z]+$/.test(a) ? [...a.slice(1)].map((c) => `-${c}`) : [a];
    if (!letters.every((l) => SED_FLAGS_OK.has(l))) return false;
    i++;
  }
  const script = args[i];
  if (script === undefined || !sedScriptOk(script)) return false;
  return args.slice(i + 1).every((f) => !isFlag(f) && env.pathOk(f));
}

// ---- git: reading forms only. A subcommand that can change the repository or its remote, or that names a file the check never saw, asks.
const GIT_SAFE_SUBS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);
const GIT_BRANCH_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "-l", "--show-current", "--no-color", "--color", "-i", "--ignore-case", "--column", "--no-column"]);

function gitOk(args: string[], env: ReadOnlyEnv): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return false;
  if (GIT_SAFE_SUBS.has(sub)) {
    // --output writes a file, --no-index reads two arbitrary ones, --ext-diff and --textconv run configured programs
    if (hasLong(rest, ["--output", "--no-index", "--ext-diff", "--textconv"])) return false;
    return pathsOk(rest, env);
  }
  if (sub === "branch") {
    let listing = false;
    for (const a of rest) {
      if (a === "--list" || a === "-l") { listing = true; continue; }
      if (GIT_BRANCH_FLAGS.has(a)) continue;
      if (/^--(sort|format|contains|merged|no-merged|points-at)(=.*)?$/.test(a)) continue;
      if (!isFlag(a) && listing) continue; // a pattern after --list
      return false; // a name (creates a branch), -d, -D, -m, -c, -u, --set-upstream-to ...
    }
    return true;
  }
  if (sub === "remote") {
    if (rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"))) return true;
    return rest[0] === "get-url" && rest.slice(1).every((a) => a === "--all" || a === "--push" || !isFlag(a)) && positional(rest.slice(1)).length <= 1;
  }
  return false;
}

// ---- find: the start paths are judged; anything that runs a program, writes a file or follows a link is not read-only
function findOk(args: string[], env: ReadOnlyEnv): boolean {
  if (args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls|L|H|follow)$/.test(a))) return false;
  let i = 0;
  while (i < args.length && !/^[-!(]/.test(args[i])) { if (!env.pathOk(args[i])) return false; i++; }
  for (; i < args.length; i++) if (/^-(newer|anewer|cnewer|samefile|newer[acBm][acBmt])$/.test(args[i]) && args[i + 1] !== undefined && !env.pathOk(args[i + 1])) return false;
  return true;
}

// ---- grep and rg: every non-flag word is a path (the pattern too: a pattern that looks like a path outside just asks), and the flags that run or follow are out
function grepOk(cmd: string, args: string[], env: ReadOnlyEnv): boolean {
  if (cmd === "rg") {
    if (hasLong(args, ["--pre", "--pre-glob", "--hostname-bin", "--follow"]) || hasShort(args, "L")) return false;
  } else if (hasShort(args, "R") || hasLong(args, ["--dereference-recursive"])) return false;
  return pathsOk(args, env);
}

// ---- commands that take arguments but never write, run or change anything when given only paths; a few flags are out
const PLAIN: Record<string, (args: string[]) => boolean> = {
  ls: (a) => !hasShort(a, "LH") && !hasLong(a, ["--dereference", "--dereference-command-line", "--dereference-command-line-symlink-to-dir"]),
  du: (a) => !hasShort(a, "LHD") && !hasLong(a, ["--dereference", "--dereference-args"]),
  stat: (a) => !hasShort(a, "L") && !hasLong(a, ["--dereference"]),
  file: (a) => !hasShort(a, "LC") && !hasLong(a, ["--dereference", "--compile"]),
  tree: (a) => !hasShort(a, "ol") && !hasLong(a, ["--output"]),
  sort: (a) => !hasShort(a, "oT") && !hasLong(a, ["--output", "--compress-program", "--temporary-directory"]),
  uniq: (a) => positional(a).filter((w) => !/^\d+$/.test(w)).length <= 1,
  cat: () => true, head: () => true, tail: () => true, wc: () => true, cut: () => true, diff: () => true, jq: () => true, md5sum: () => true, sha256sum: () => true,
};

// ---- commands with no path arguments to speak of; the few flags that read a file, set the clock or the shell, or show other processes' environments are out
function argFreeOk(cmd: string, args: string[]): boolean {
  switch (cmd) {
    case "printf": return args[0] !== "-v"; // -v assigns a shell variable, and the shell outlives the command
    case "date": {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-d" && args[i + 1] !== undefined) { i++; continue; }
        if (!/^(\+.*|-u|--utc|--universal|-R|-I\w*)$/.test(a)) return false; // -f reads a file, -s sets the clock
      }
      return true;
    }
    case "ps": return args.length === 0 || (args.length === 1 && /^(aux|-ef|-e|-A)$/.test(args[0])) || (args.length === 2 && args[0] === "-p" && /^\d+$/.test(args[1]));
    default: return true;
  }
}

export const ARG_FREE_COMMANDS = new Set(["echo", "printf", "true", "false", "sleep", "pwd", "date", "which", "whoami", "ps", "test", "[", "uname", "id"]);

/** The decision for one command with its arguments (the shell's own words, already unquoted). `cd` and `curl` are decided by the caller, which knows the working directory and the URLs. */
export function readOnlyCommand(cmd: string, args: string[], env: ReadOnlyEnv): boolean {
  if (ARG_FREE_COMMANDS.has(cmd)) return argFreeOk(cmd, args);
  if (cmd === "git") return gitOk(args, env);
  if (cmd === "find") return findOk(args, env);
  if (cmd === "sed") return sedOk(args, env);
  if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") return grepOk(cmd, args, env);
  const plain = PLAIN[cmd];
  if (plain) return plain(args) && pathsOk(args, env);
  return false;
}
