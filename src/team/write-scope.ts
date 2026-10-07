// Where a role may write, enforced at the moment of the write (V7 and V8, docs/TEAM-COMPOSITION.md). The scope comes from the role's definition in the roster and from the plan's slices, never from
// anything the role says about itself. This judges the four file-writing tools by the real location of the path (links followed, `..` applied to the real directory, case folded, a name that only shares a
// prefix is outside); Bash is not judged here, the diff audit after the step is what closes that (`auditDiffScope`). A path that cannot be placed is a refusal, as everywhere else in the hook chain.
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, join, relative, sep } from "node:path";
import { canonicalPath, toolPath } from "../path-canon.js";
import { insidePrefixes, reservedReason, slicePrefixes } from "./plan.js";

export interface WriteRule {
  /** The role id, for the refusal's wording only. */
  role: string;
  /** `none`, `tests`, `docs`, `slice` or `shared` (roster.ts WriteScope); anything else is refused. */
  writeScope: string;
  workDir: string;
  /** The step's slice, for `slice`. */
  slice?: { name: string; paths: string[] };
  /** Every slice's prefixes, for `shared` (the integrator joins them). */
  allPrefixes?: string[];
}
export type WriteDecision = { allow: true } | { allow: false; reason: string };

/** The tools that write a file, and the argument that names the file. */
const WRITE_ARGS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const TEST_FILE = /(^test_[^/]*\.[a-z0-9]+$)|(_test\.[a-z0-9]+$)|(\.(test|spec)\.[a-z0-9]+$)/;
const DOC_FILE = /^(readme|changelog|contributing)(\.(md|markdown|txt|rst|adoc))?$/;
const DOC_DIRS = new Set(["docs", "doc"]);
/** Never hand-written by any role through the file tools. */
const NEVER = new Set([".git", "node_modules"]);

/** The path as the operating system will open it, relative to the project, lower case and NFC; undefined when it is not inside the project or cannot be placed. */
function targetOf(value: string, workDir: string): string | undefined {
  const placed = toolPath(value);
  if ("refuse" in placed) return undefined;
  const real = canonicalPath(placed.path, workDir);
  const root = canonicalPath(workDir, workDir);
  if (real === undefined || root === undefined) return undefined;
  const rel = relative(root, real);
  const first = rel.split(sep)[0];
  if (rel === "" || first === ".." || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/").normalize("NFC").toLowerCase();
}

const clip = (s: string): string => s.replace(CONTROL, " ").slice(0, 200);

export function decideWrite(path: unknown, rule: WriteRule): WriteDecision {
  const no = (why: string): WriteDecision => ({ allow: false, reason: `${rule.role} may not write ${typeof path === "string" ? JSON.stringify(clip(path)) : "that"}: ${why} (write scope: ${rule.writeScope})` });
  if (typeof path !== "string" || path === "") return no("the write names no path");
  if (CONTROL.test(path)) return no("the path has a control character in it");
  if (rule.writeScope === "none") return no("this role is read-only and has no write scope");
  // Off Windows a backslash is an ordinary character of a file name, and the path resolver treats it as a separator: the two readings differ, so the path is not judged, it is refused.
  if (sep === "/" && path.includes("\\")) return no("a backslash in a path means a separator to one reader and a file-name character to another here");
  const target = targetOf(path, rule.workDir);
  if (target === undefined) return no("it is outside the project, or cannot be placed inside it");
  const segs = target.split("/");
  const dirs = segs.slice(0, -1), base = segs[segs.length - 1];
  if (segs.some((x) => NEVER.has(x))) return no("it is inside a directory no role writes by hand (.git, node_modules)");
  switch (rule.writeScope) {
    case "slice": {
      const prefixes = rule.slice ? slicePrefixes(rule.slice, rule.workDir) : [];
      if (!prefixes.length) return no("the step has no slice to write in");
      if (reservedReason(target) !== undefined) return no("it is a shared or generated file, which belongs to the integrator");
      return insidePrefixes(target, prefixes) ? { allow: true } : no(`it is outside the step's slice (${clip(prefixes.join(", "))})`);
    }
    case "tests": {
      if (reservedReason(target) !== undefined) return no("it is a shared or generated file");
      return dirs.some((d) => TEST_DIRS.has(d)) || TEST_FILE.test(base) ? { allow: true } : no("it is not a test file or in a tests directory");
    }
    case "docs": {
      if (reservedReason(target) !== undefined) return no("it is a shared or generated file");
      return DOC_DIRS.has(segs[0]) && segs.length > 1 || DOC_FILE.test(base) ? { allow: true } : no("it is not README, CHANGELOG or under docs/");
    }
    case "shared": {
      // the shared files (manifests, lockfiles) and generated output are the integrator's; .git and node_modules were refused above for every role
      const shared = reservedReason(target) !== undefined;
      return shared || insidePrefixes(target, rule.allPrefixes ?? []) ? { allow: true } : no("it is neither a shared file nor inside one of the plan's slices");
    }
    default:
      return no("the role's write scope is not one this version knows");
  }
}

/** The hook the pipeline puts in the chain for a team step: the file-writing tools are judged against the step's rule, everything else passes. */
export function createWriteScopeHook(rule: WriteRule): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const arg = WRITE_ARGS[pre.tool_name];
    if (!arg) return {};
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    const decision = decideWrite(toolInput[arg], rule);
    if (decision.allow) return {};
    return { hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny" as const, permissionDecisionReason: `agent-loop write scope: ${decision.reason}.` } };
  };
}
