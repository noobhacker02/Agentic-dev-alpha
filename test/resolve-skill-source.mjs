// Resolves a path to the dev-workflow skill directory WITHOUT assuming agent-loop and Dev-Skill
// live as sibling directories on disk. That was only ever true by accident of one development
// session's layout, not a real relationship between two independently-versioned, independently-
// published repos -- a `../../dev-workflow` relative path breaks completely for anyone who clones
// agent-loop (test-dev-1) on its own, which is exactly what a public repo invites.
//
// Default behavior: always fetch the real, current dev-workflow skill from its public GitHub repo
// via a fresh shallow clone, so validation runs against what's actually published right now, not a
// copy that can silently drift out of date. An explicit local path is an opt-in override only, for
// fast local iteration while developing dev-workflow itself -- it is never the silent default.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_GIT_URL = "https://github.com/noobhacker02/Dev-Skill.git";
const DEFAULT_SUBPATH = "dev-workflow";

/**
 * @returns {string} absolute path to a directory containing dev-workflow's SKILL.md.
 */
export function resolveDevWorkflowSkillPath() {
  const overridePath = process.env.DEV_WORKFLOW_SKILL_PATH;
  if (overridePath) {
    if (!existsSync(join(overridePath, "SKILL.md"))) {
      throw new Error(
        `DEV_WORKFLOW_SKILL_PATH=${overridePath} was set but no SKILL.md was found there. ` +
          `Unset it to fetch the latest skill from GitHub instead, or point it at the right directory.`
      );
    }
    console.log(`[resolve-skill] using local override DEV_WORKFLOW_SKILL_PATH=${overridePath} (explicit opt-out of "always latest")`);
    return overridePath;
  }

  const gitUrl = process.env.DEV_WORKFLOW_GIT_URL || DEFAULT_GIT_URL;
  const gitRef = process.env.DEV_WORKFLOW_GIT_REF; // optional: pin a branch/tag for reproducible runs
  const cloneDir = mkdtempSync(join(tmpdir(), "dev-workflow-clone-"));
  const cloneArgs = ["clone", "--depth", "1"];
  if (gitRef) cloneArgs.push("--branch", gitRef);
  cloneArgs.push(gitUrl, cloneDir);

  console.log(`[resolve-skill] fetching the latest dev-workflow skill: git ${cloneArgs.join(" ")}`);
  execFileSync("git", cloneArgs, { stdio: "inherit" });

  const skillPath = join(cloneDir, DEFAULT_SUBPATH);
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    throw new Error(`Cloned ${gitUrl} but ${DEFAULT_SUBPATH}/SKILL.md wasn't found there — did the layout change?`);
  }
  return skillPath;
}
