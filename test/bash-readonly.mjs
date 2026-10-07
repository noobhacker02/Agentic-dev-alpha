// "Read-only inside --dir" is a promise that a shell command can neither write nor run anything nor read outside the directory, so no human is asked. Adversary round 2 (A51) ran
// sed '1e CMD', sed w, rg --pre, git remote set-url, sort -o and more through the real approval hook with no prompt, and made files outside the directory. This table is that list,
// every row beside the ordinary commands that must still run without a prompt (a rule that asks about everything is its own failure: people stop reading the prompts).
//   npm run build && npm run test:bash-readonly
import assert from "node:assert";
import { approvalPlan } from "../dist/hooks.js";
import { AUTO, ASK, scoreShell, scratchWork } from "../bench/suites/shell-readonly.mjs";

const work = scratchWork();
const autoAllowed = (command) => approvalPlan("Bash", { command }, work)?.readOnly === true;

const wronglyAsked = AUTO.filter((c) => !autoAllowed(c));
assert.deepStrictEqual(wronglyAsked, [], `ordinary read-only commands that now ask:\n  ${wronglyAsked.join("\n  ")}`);
const wronglyAllowed = ASK.filter((c) => autoAllowed(c));
assert.deepStrictEqual(wronglyAllowed, [], `commands that run with no prompt and should ask:\n  ${wronglyAllowed.join("\n  ")}`);
console.log(`[ok] ${AUTO.length} ordinary read-only commands run without a prompt; ${ASK.length} commands that write, run code, follow a link, expand to a path outside or name a file the check never saw ask`);

// --strict-approval and the real hook: a command that must ask is never answered by the hook on its own.
{
  const { approvalPlan: plan } = await import("../dist/hooks.js");
  assert.notStrictEqual(plan("Bash", { command: "sed '1e id' notes.txt" }, work)?.readOnly, true, "the plan still calls the sed program read-only");
  assert.notStrictEqual(plan("Bash", { command: "sed '1e id' notes.txt" }, undefined)?.readOnly, true, "without a working directory nothing is read-only");
  assert.notStrictEqual(plan("Bash", { command: "cat notes.txt" }, undefined)?.readOnly, true, "control: without a working directory even cat asks");
  assert.strictEqual(plan("Bash", { command: "cat notes.txt" }, work)?.readOnly, true, "control: with one, cat does not");
  console.log("[ok] the plan the approval hook reads says sed with an e command is not read-only, with and without a working directory");
}
console.log("\nALL BASH READ-ONLY TESTS PASSED");
