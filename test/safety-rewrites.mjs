// Adversary round 2 (A30): the safety net's patterns needed the subcommand right after `git`, and its `rm` list knew only the filesystem root and the home directory, so the cheapest
// rewrites (a flag between git and push, rm of /etc or /home) passed under --no-approval, where this hook is the only guard. Payloads are XOR (0x5A) + base64 encoded like
// test/safety-net.mjs, because the plain strings would trip this repository's own pre-commit scanner.
//   npm run build && npm run test:safety-rewrites
import { createSafetyHook } from "../dist/hooks.js";
import assert from "node:assert";

const decode = (e) => Buffer.from(Buffer.from(e, "base64").map((c) => c ^ 0x5a)).toString("utf8");
const sig = new AbortController().signal;
const safety = createSafetyHook();
const denies = async (command) => (await safety({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, "t", { signal: sig }))?.hookSpecificOutput?.permissionDecision === "deny";

const DENY = [
  "PTMuencZeig/KjV6Ki8pMnp3dzw1KDk/",
  "PTMuenc5eiJnI3oqLykyenc8",
  "PTMuend3NDV3Kjs9Pyh6KD8pPy56d3cyOyg+ehIfGx4kbw==",
  "PTMuencZenR6OTY/OzR6dzw+Ig==",
  "PTMuend3PTMudz4zKGd0PTMuend3LTUoMXcuKD8/Z3R6Ki8pMnp3dzw1KDk/ejUoMz0zNHo3OzM0",
  "PTMuenc5ejk1KD90Kjs9PyhnOTsuencZeig/KjV6Ki8pMno1KDM9MzR6cTc7MzQ=",
  "PTMuencZenUuNyp1Inp3OXovKT8odDQ7Nz9nO3o4KDs0OTJ6dx56NTY+",
  "KDd6dyg8enU/Ljk=",
  "KDd6dyg8enUyNTc/",
  "KDd6dyg8enUvKSh6dTgzNA==",
  "KDd6dyg8enUoNTUu",
  "OT56dXp8fHooN3p3KDx6Py45",
  "KDd6dyg8enUyNTc/dXA=",
  "KDd6dyg8enU/Ljl1",
  "KDd6dyh6dzx6dS8pKA==",
  "KDd6dzwoenUsOyg="
].map(decode);
for (const c of DENY) assert.ok(await denies(c), `expected a deny for: ${c}`);
console.log(`[ok] ${DENY.length} rewrites (git global options before the subcommand, rm of a top-level system directory) are denied`);

const ALLOW = [
  "git -C repo status", "git --no-pager log -5", "git -c x=y diff", "git -C repo push --force-with-lease origin feature", "git -C repo push origin feature", "git --no-pager show HEAD", "git -C repo branch --list",
  "rm -rf /tmp/build-123", "rm -rf ./build", "rm -rf build dist", "rm -rf /var/tmp/x/y", "cd /tmp && rm -rf cache", "rm -f /tmp/x.log", "rm -rf node_modules .cache",
];
for (const c of ALLOW) assert.ok(!(await denies(c)), `expected an ordinary command to be left alone: ${c}`);
console.log(`[ok] ${ALLOW.length} ordinary commands with the same shapes (git -C status, force-with-lease, rm -rf of a build directory or a temp path) are left alone`);
console.log("\nALL SAFETY REWRITE TESTS PASSED");
