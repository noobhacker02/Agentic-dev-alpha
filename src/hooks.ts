import { isAbsolute, resolve, sep } from "node:path";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { analyzeBash } from "./bash-analysis.js";
import type { EventBus } from "./bus.js";
import type { PhaseName } from "./types.js";

/**
 * Patterns that are denied outright, before the request even reaches the human approval UI. This
 * is the actual last line of defense under `--no-approval` (nobody is there to catch what it
 * misses), so it needs to survive trivial rewordings, not just the textbook spelling of each
 * command. A real stress test (see docs/STRESS-TEST-REPORT.md) found the original 6-pattern list
 * caught 3 of 27 adversarial cases — flag-order variants, quoting, wildcards, encoding, and piped
 * exfiltration all sailed through. This list is organized by the same categories that test used.
 *
 * Still a defense-in-depth backstop, not a shell parser: the approval UI (or, unattended, the
 * task's own good sense) remains the real control surface. This just narrows how much a phase can
 * do unsupervised before a human would have caught it anyway.
 */

const DANGEROUS_RM_TARGET =
  /^(\/|\/\*|~|~\/.*|\$HOME\b.*|"\$HOME"|'\$HOME'|\$\{HOME\}.*|\.\.|\.\.\/.*|\*)$/;

/** True if any `rm` invocation in the command combines recursive+force flags with a target like `/`, `~`, `$HOME`, `..`, or a bare `*` (including after `cd /` / `cd ~` earlier in the same line). */
function hasDangerousRm(command: string): boolean {
  const changedToDangerousDir = /\bcd\s+(\/|~)(\s|&&|;|$)/.test(command);
  for (const match of command.matchAll(/\brm\s+((?:[^\n;|&]|\\[;|&])*)/gi)) {
    const rest = match[1];
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const tok of tokens) {
      if (tok === "--recursive") recursive = true;
      else if (tok === "--force") force = true;
      else if (tok === "--no-preserve-root") force = true; // only meaningful alongside -r, but signals intent
      else if (/^-[a-zA-Z]+$/.test(tok)) {
        if (/r/i.test(tok)) recursive = true;
        if (/f/i.test(tok)) force = true;
      } else {
        targets.push(tok.replace(/^["']|["']$/g, ""));
      }
    }
    if (!recursive || !force) continue;
    if (targets.some((t) => DANGEROUS_RM_TARGET.test(t))) return true;
    if (changedToDangerousDir && targets.includes("*")) return true;
  }
  return false;
}

const HARD_DENY_CHECKS: Array<{ name: string; test: (cmd: string) => boolean }> = [
  { name: "rm targeting /, ~, $HOME, .., or * after cd into one", test: hasDangerousRm },
  { name: "fork bomb", test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(c) },
  { name: "mkfs (reformats a device)", test: (c) => /\bmkfs\b/i.test(c) },
  {
    name: "dd writing to a block device",
    test: (c) => /\bdd\b[^\n;|&]*\bof=\/dev\/(?!null\b|zero\b|random\b|urandom\b)[a-z]+/i.test(c),
  },
  {
    name: "git push force (--force, -f, or a +refspec)", // devskill:allow — naming what we detect
    test: (c) =>
      /\bgit\s+push\b[^\n;|&]*(--force(?!-with-lease)\b|\s-f(\s|$)|\s\+[\w./-]+)/i.test(c),
  },
  { name: "git reset --hard", test: (c) => /\bgit\s+reset\s+--hard\b/i.test(c) }, // devskill:allow
  { name: "git clean -f (force-deletes untracked files)", test: (c) => /\bgit\s+clean\s+(-\w*f\w*|--force)\b/i.test(c) },
  { name: "git checkout/restore discarding all local changes", test: (c) => /\bgit\s+(checkout|restore)\s+(--\s+\.|\.)\s*$/i.test(c) },
  { name: "git branch -D (force-delete)", test: (c) => /\bgit\s+branch\s+(-D|--delete\s+--force)\b/i.test(c) },
  { name: "find ... -delete", test: (c) => /\bfind\b[^\n;|&]*-delete\b/i.test(c) },
  { name: "curl/wget piped into a shell", test: (c) => /\b(curl|wget)\b[^\n;|&]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i.test(c) },
  {
    name: "base64-decoded payload piped into a shell (obfuscated command)",
    test: (c) => /\bbase64\s+(-d|--decode)\b[^\n;|&]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i.test(c),
  },
  { name: "Python shutil.rmtree", test: (c) => /shutil\s*\.\s*rmtree\s*\(/i.test(c) },
  {
    name: "reading a credential file and piping it to the network",
    test: (c) =>
      /\bcat\b[^\n;|&]*(id_rsa|id_ed25519|id_dsa|\.ssh\/|\.aws\/credentials|\.netrc|\.git-credentials)[^\n;|&]*\|\s*(curl|nc|ncat|wget)\b/i.test(
        c
      ),
  },
  {
    name: "DROP/TRUNCATE via a database CLI's inline command flag",
    test: (c) =>
      /\b(psql|mysql|mariadb|sqlite3|mongosh|redis-cli)\b[^\n;|&]*(-c\b|--command\b|--eval\b|-e\b)[^\n;|&]*\b(DROP|TRUNCATE)\s+(DATABASE|TABLE|SCHEMA)\b/i.test(
        c
      ),
  },
];

function commandFromInput(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === "Bash" && typeof toolInput.command === "string") return toolInput.command;
  return null;
}

/** Always-on safety net. Runs alongside the approval hook; a deny from either wins. */
export function createSafetyHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    const command = commandFromInput(pre.tool_name, toolInput);
    if (!command) return {};
    const hit = HARD_DENY_CHECKS.find((c) => c.test(command));
    if (hit) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: `agent-loop safety net: '${command}' matches a hard-denied pattern (${hit.name}) and is never allowed, even with human approval.`,
        },
      };
    }
    return {};
  };
}

/**
 * File-tool argument names that name a path the tool will read or write, per built-in tool. `Glob`
 * and `Grep`'s `path` is where they search, not a write target, but a phase pointed at it is still
 * a phase reading outside the task's own directory, so it's scoped too.
 */
const PATH_ARGS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
};

function isInside(workDir: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? candidate : resolve(workDir, candidate);
  const resolved = resolve(abs);
  const root = resolve(workDir);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * Defense-in-depth backstop, same spirit as the safety hook: keeps the file tools' own read/write
 * targets inside the run's `--dir`, so a phase can't touch `/root/.bashrc`, `/etc/hosts`, or climb
 * out with `../..` regardless of what the approval UI does. It only sees named path arguments —
 * `Bash` can still `cd` or `cat` anywhere the OS permits; containing that needs a real sandbox, not
 * a hook, so it stays out of scope here.
 */
export function createPathScopeHook(workDir: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const argNames = PATH_ARGS[pre.tool_name];
    if (!argNames) return {};
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    for (const arg of argNames) {
      const value = toolInput[arg];
      if (typeof value !== "string" || value === "") continue;
      if (!isInside(workDir, value)) {
        return {
          hookSpecificOutput: {
            hookEventName: pre.hook_event_name,
            permissionDecision: "deny",
            permissionDecisionReason: `agent-loop safety net: ${pre.tool_name}'s ${arg} ('${value}') resolves outside the run's working directory (${workDir}) and is never allowed.`,
          },
        };
      }
    }
    return {};
  };
}

/**
 * Filenames/paths that name a credential store or secret regardless of which project they show up
 * in. A stress test found `Read` auto-approved as a blanket "read-only tool" even when its target
 * was `~/.claude/.credentials.json` or `~/.ssh/id_rsa` — being outside `--dir` now also catches
 * those two specifically (`createPathScopeHook`), but a task whose own `--dir` happens to contain
 * a `.env` or `.git-credentials` (an ordinary thing for a real project to have) would still sail
 * through on tool-name auto-approval alone. This checks the path itself, so it holds either way —
 * a `deny` from any hook wins regardless of what the approval hook auto-approves by tool name.
 */
const SENSITIVE_PATH_RE =
  /(^|[/\\])(\.ssh[/\\](id_rsa|id_ed25519|id_dsa|id_ecdsa)(\.pub)?|\.aws[/\\]credentials|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.claude[/\\]\.credentials\.json|credentials\.json|\.env)$/i;
const SENSITIVE_ABS_RE = /^\/etc\/(shadow|passwd|sudoers)$/i;

export function createSensitiveFileHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const argNames = PATH_ARGS[pre.tool_name];
    if (!argNames) return {};
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    for (const arg of argNames) {
      const value = toolInput[arg];
      if (typeof value !== "string" || value === "") continue;
      if (SENSITIVE_PATH_RE.test(value) || SENSITIVE_ABS_RE.test(resolve(value))) {
        return {
          hookSpecificOutput: {
            hookEventName: pre.hook_event_name,
            permissionDecision: "deny",
            permissionDecisionReason: `agent-loop safety net: ${pre.tool_name}'s ${arg} ('${value}') names a credential/secret file and is never allowed, regardless of --dir or tool-level auto-approval.`,
          },
        };
      }
    }
    return {};
  };
}

export interface ApprovalHookOptions {
  bus: EventBus;
  runId: string;
  phase: PhaseName;
  /** When false, everything is auto-approved (used for phases that shouldn't interrupt a human, if ever). */
  requireApproval: boolean;
  /** Tools that never need a human's eyes (pure reads) — auto-approved without a round-trip. */
  autoApproveTools?: string[];
  /** The run's --dir: shell commands that only read inside it run without a prompt. */
  workDir?: string;
  /** false = ask about every shell command, even read-only ones (`--strict-approval`). */
  autoAllowReadOnly?: boolean;
}

/**
 * The actual approval-UI mechanism: a PreToolUse hook that blocks on a real
 * human decision via the event bus / WebSocket UI. `canUseTool` alone is
 * insufficient here because many calls get auto-approved before reaching it
 * (see the SDK's 6-step permission evaluation order) — a PreToolUse hook is
 * the one place guaranteed to run for every tool call.
 */
/**
 * What approving a call would mean, modeled on Claude Code's permission rules:
 *  - `readOnly`: the call only reads inside --dir (every subcommand of a shell command does), so it
 *    runs without a prompt, the same way Read/Glob/Grep already do;
 *  - `rules`: the "Yes, and don't ask again" rules approving it would save -- `Bash(npm test:*)` per
 *    subcommand that isn't read-only, the bare tool name for other tools (file tools are already
 *    confined to --dir by the path-scope hook).
 * null = too open-ended to generalise (rm, kill, git push, remote curl, interpreters' inline code,
 * command substitution, redirects to files…): asked every single time.
 */
export function approvalPlan(toolName: string, toolInput: unknown, workDir?: string): { readOnly: boolean; rules: string[] } | null {
  if (toolName !== "Bash") return { readOnly: false, rules: [toolName] };
  const command = typeof (toolInput as { command?: unknown })?.command === "string" ? (toolInput as { command: string }).command : "";
  const subs = analyzeBash(command, workDir);
  if (!subs) return null;
  const needRules = subs.filter((s) => !s.readOnly);
  if (needRules.some((s) => !s.rule)) return null;
  return { readOnly: needRules.length === 0, rules: [...new Set(needRules.map((s) => s.rule as string))] };
}

/** The single rule for a simple command (kept for callers that only deal in one rule). */
export function approvalRuleFor(toolName: string, toolInput: unknown, workDir?: string): string | null {
  const plan = approvalPlan(toolName, toolInput, workDir);
  return plan && plan.rules.length === 1 ? plan.rules[0] : null;
}

export function createApprovalHook(opts: ApprovalHookOptions): HookCallback {
  const autoApprove = new Set(opts.autoApproveTools ?? []);
  return async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    if (!opts.requireApproval || autoApprove.has(pre.tool_name)) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "allow",
          permissionDecisionReason: opts.requireApproval ? "auto-approved read-only tool" : "approval UI disabled for this run",
        },
      };
    }

    const plan = approvalPlan(pre.tool_name, pre.tool_input, opts.workDir);
    const readOnlyShell = !!plan?.readOnly && opts.autoAllowReadOnly !== false;
    if (plan && (readOnlyShell || (plan.rules.length > 0 && plan.rules.every((r) => opts.bus.hasAllowRule(r))))) {
      const rule = readOnlyShell ? "read-only command inside the working directory" : plan.rules.join(", ");
      opts.bus.emitEvent({
        type: "approval-auto-allowed",
        runId: opts.runId,
        phase: opts.phase,
        toolUseId: toolUseId ?? requestIdFallback(),
        toolName: pre.tool_name,
        rule,
        ts: new Date().toISOString(),
      });
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "allow",
          permissionDecisionReason: `allowed by the "don't ask again" rule ${rule} a human created this run`,
        },
      };
    }

    const { requestId, wait } = opts.bus.requestApproval({
      runId: opts.runId,
      phase: opts.phase,
      toolUseId: toolUseId ?? requestIdFallback(),
      toolName: pre.tool_name,
      toolInput: pre.tool_input,
      rule: plan?.rules.join(", ") || undefined,
    });

    const decision = await raceWithAbort(wait, signal);
    const remembered = decision.decision === "allow" && decision.remember && plan ? plan.rules : [];
    for (const r of remembered) opts.bus.addAllowRule(r);
    const rememberedRule = remembered.length ? remembered.join(", ") : undefined;

    opts.bus.emitEvent({
      type: "approval-resolved",
      runId: opts.runId,
      phase: opts.phase,
      requestId,
      toolUseId: toolUseId ?? undefined,
      decision: decision.decision,
      reason: decision.reason,
      auto: false,
      rememberedRule,
      ts: new Date().toISOString(),
    });

    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: decision.decision,
        permissionDecisionReason: decision.reason ?? `human ${decision.decision} via approval UI`,
      },
    };
  };
}

function requestIdFallback(): string {
  return `no-tool-use-id-${Date.now()}`;
}

async function raceWithAbort<T extends { decision: "allow" | "deny"; reason?: string; remember?: boolean }>(
  wait: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return { decision: "deny", reason: "query aborted before approval was given" } as T;
  }
  return new Promise<T>((resolve) => {
    const onAbort = () => resolve({ decision: "deny", reason: "query aborted while awaiting approval" } as T);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then((d) => {
      signal.removeEventListener("abort", onAbort);
      resolve(d);
    });
  });
}
