// A child process started with `--import <path>` fails on Windows when the path is absolute: Node reads `D:\a\...` as a URL with the scheme "d:" (ERR_UNSUPPORTED_ESM_URL_SCHEME). It has happened four times (the
// gate's tests, the bench children, the lineage test, then test:team-run-cli at a035a87), each time found by the Windows CI job after the full local suite on Linux had passed. This reads every file that
// starts node with `--import` and refuses an argument that is not a relative path ("./x.mjs", run from the repository root), a URL (`.href`, `pathToFileURL`, "file:") or a bare package name.
// The scanner is checked against snippets it must refuse and snippets it must accept before it is trusted on the repository.
//   npm run test:windows-imports
import assert from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The text of the argument that starts at `from`: up to the comma or closing bracket that ends it (a comma inside brackets does not). */
function argumentAt(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return src.slice(from, i); depth--; }
    else if (c === "," && depth === 0) return src.slice(from, i);
    else if (c === "\n" && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/** The `--import` arguments in `src` that are not safe on Windows, each with why. */
export function unsafeImports(src) {
  const bad = [];
  for (const m of src.matchAll(/["'`]--import["'`]\s*,\s*/g)) {
    const arg = argumentAt(src, m.index + m[0].length).trim();
    if (/^["'`]/.test(arg)) {
      const text = arg.slice(1, -1);
      if (/^(\.\.?\/|file:)/.test(text) || /^[a-z@][\w@./-]*$/i.test(text)) continue;
      bad.push(`${arg}: a path that is not relative`);
      continue;
    }
    if (/\.href\b|pathToFileURL\(/.test(arg)) continue;
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      const decl = src.match(new RegExp(`(?:const|let|var)\\s+${arg.replace(/\$/g, "\\$")}\\s*=\\s*([^;\\n]*)`));
      if (!decl) { bad.push(`${arg}: cannot see where it comes from`); continue; }
      if (/\.href\b|pathToFileURL\(/.test(decl[1]) || /^["'`](\.\.?\/|file:)/.test(decl[1].trim())) continue;
      bad.push(`${arg}: declared as ${decl[1].trim().slice(0, 80)}`);
      continue;
    }
    bad.push(`${arg}: not a relative path or a URL`);
  }
  return bad;
}

// 1. The scanner refuses what fails on Windows and accepts what works
{
  const refuse = {
    "a path turned into a file name": 'const reg = fileURLToPath(new URL("./x.mjs", import.meta.url)); spawn(p, ["--import", reg, cli]);',
    "an absolute path": 'spawn(p, ["--import", "/tmp/x.mjs", cli]);',
    "a drive path": 'spawn(p, ["--import", "C:\\\\x\\\\y.mjs", cli]);',
    "a template with a path": 'spawn(p, ["--import", `${dir}/x.mjs`, cli]);',
    "a name defined elsewhere": 'spawn(p, ["--import", somewhere, cli]);',
    "a joined path": 'spawn(p, ["--import", join(root, "x.mjs"), cli]);',
    "a joined path in a push": 'nodeArgs.push("--import", join(root, "test/x.mjs"));',
    "single quotes": "spawn(p, ['--import', reg, cli]); const reg = resolve('x.mjs');",
  };
  for (const [what, src] of Object.entries(refuse)) assert.ok(unsafeImports(src).length > 0, `${what} was accepted`);
  const accept = {
    "a relative literal": 'spawn(p, ["--import", "./test/stress/fake-sdk/register.mjs", cli]);',
    "a URL held in a name": 'const fakeSdk = new URL("./a.mjs", import.meta.url).href; spawn(p, ["--import", fakeSdk, cli]);',
    "pathToFileURL inline": 'spawn(p, ["--import", pathToFileURL(x).href, cli]);',
    "a name made with pathToFileURL": "const trace = pathToFileURL(join(a, 'b')).href; run(['--import', trace]);",
    "a URL made inline with a comma in the call": 'run(["--import", new URL("../stress/fake-sdk/register.mjs", import.meta.url).href]);',
    "a parent-relative literal": 'spawn(p, ["--import", "../x/register.mjs", cli]);',
    "a relative template literal": 'run(["--import", `./a.mjs`, cli]);',
    "a package name": 'spawn(p, ["--import", "tsx", cli]);',
    "a file: URL": 'spawn(p, ["--import", "file:///x/y.mjs"]);',
    "two imports": 'const a = new URL("./a.mjs", import.meta.url).href; run(["--import", a, "--import", "./b.mjs"]);',
    "no import at all": 'spawn(p, [cli, "run"]);',
  };
  for (const [what, src] of Object.entries(accept)) assert.deepStrictEqual(unsafeImports(src), [], `${what} was refused: ${unsafeImports(src)}`);
  assert.strictEqual(unsafeImports('run(["--import", a, "--import", "/abs/b.mjs"]); const a = "./a.mjs";').length, 1, "only the second of two imports is wrong");
  console.log("[ok] the scanner refuses an absolute path, a path made into a file name, a joined or templated path and a name it cannot trace, and accepts a relative path, a URL and a package name");
}

/** What is wrong in each of `files` (paths under `root`), as "relative/path: --import <why>". */
export function problemsIn(files, root) {
  const problems = [];
  for (const f of files) for (const why of unsafeImports(readFileSync(f, "utf8"))) problems.push(`${relative(root, f)}: --import ${why}`);
  return problems;
}

// 2. Reading files: a bad one is named by its path, a good one is not
{
  const dir = mkdtempSync(join(tmpdir(), "win-imports-"));
  writeFileSync(join(dir, "bad.mjs"), 'spawn(p, ["--import", join(root, "x.mjs")]);');
  writeFileSync(join(dir, "good.mjs"), 'spawn(p, ["--import", "./x.mjs"]);');
  assert.deepStrictEqual(problemsIn([join(dir, "bad.mjs"), join(dir, "good.mjs")], dir), ['bad.mjs: --import join(root, "x.mjs"): not a relative path or a URL']);
  console.log("[ok] a file with a bad --import is named by its path in the report, and a good one is not");
}

// 3. Every file in the repository that starts node with --import
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git" || name.startsWith("full-")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|ts)$/.test(name) && !p.endsWith("windows-imports.mjs")) files.push(p);
    }
  };
  for (const d of ["test", "scripts", "bench", "src"]) walk(join(root, d));
  const uses = files.reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(/["'`]--import["'`]\s*,/g)].length, 0);
  const problems = problemsIn(files, root);
  assert.ok(uses >= 10, `only ${uses} uses of --import found: the scan is not looking where the suites are`);
  assert.deepStrictEqual(problems, [], `an --import that fails on Windows:\n${problems.join("\n")}`);
  console.log(`[ok] ${uses} uses of --import in ${files.length} files: each is a relative path, a URL or a package name`);
}
console.log("\nALL WINDOWS IMPORT TESTS PASSED");
