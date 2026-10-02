# agent-loop: rules for every session

Read `docs/HANDOFF.md` first (the SessionStart hook injects it): what was asked in the user's words, decisions, status, next step, what is verified and what is not.
Two repos are in play: this one (`main`) and the Dev-Skill checkout one level up (`claude/dev-workflow-process-v4kafr`; agent-loop is gitignored there).

## Save before you run out of usage (the user asked for this twice)

When usage is nearly out, **save everything before moving ahead**: `npm run checkpoint` (stages, commits and pushes both repos, never `--no-verify`), update
`docs/HANDOFF.md` "Next step" and what is verified, make sure anything in the background writes to disk as it goes, and only then continue. Do not start a big edit,
a rebuild or a long run in the last stretch. A checkpoint commit says what was **not** re-run; it never claims green it did not see.

## Do not remake mistakes

`docs/SELF-HEALING.md` is the catalog: how to recover while building (part A), how the product recovers at runtime (part B), and the mistakes made more than once
(part C). Add a row the second time anything fails.

## Standing rules

- Verify by running things; a claim about "the suite passes" is about the commit it ran on. Regenerate the benchmark table (`node bench/run.mjs --write-doc`) after
  changing a suite, the improvement log or the planned list.
- Every improvement gets an entry in `docs/IMPROVEMENTS.md` (why, how, the number it moved, the cost) and the skill-side log in the Dev-Skill repo.
- New tests fail on the old code first, then pass; mutation-check them; run them twice. Score a baseline against the old code in a scratch worktree.
- After each stage run an adversary round with a **new** fresh-context agent (it writes findings to its file as it confirms them); triage in `docs/adversary/`.
- Never evade bans or anti-bot measures; never test against real third-party sites from here; never record passwords or cookies; the agent profile stays local,
  0700, outside the repo and `--dir`.
- Do not use `--no-verify`. A scanner false positive is allowed inline with `// devskill:allow (reason)`.
- Persona: tease tool-usage habits, never the person; "politics" means legislature process only; dark but not too dark.
- Do not open pull requests unless asked. Push only the designated branches.
