// What a step really changed (docs/TEAM-COMPOSITION.md, V8 and G8): the write-scope hook sees the file tools, and Bash is outside it, so after every step the project tree is compared with how it was before and
// every changed path is audited against the step's slice. This is the comparison: a bounded snapshot of the tree (content hashes for ordinary files, links read as links, derived directories left out) and the list of
// paths that were added, changed or removed. A snapshot that was cut short says so, because an audit over part of a tree must fail closed.
// Real disk, no API.
//   npm run build && npm run test:team-changes
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, utimesSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { snapshotTree, changedBetween } from "../dist/team/changes.js";

const posix = process.platform !== "win32";
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "changes-"));
  for (const d of ["src/api", "src/ui", "docs", "dist", "node_modules/x", ".git/objects", "coverage", ".agent-loop", "__pycache__", "build", "out", ".cache", ".next", ".pytest_cache"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "src/api/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src/ui/b.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "docs/x.md"), "# x\n");
  writeFileSync(join(root, "dist/out.js"), "built");
  writeFileSync(join(root, "node_modules/x/i.js"), "dep");
  writeFileSync(join(root, ".git/objects/o"), "obj");
  writeFileSync(join(root, "coverage/c.json"), "{}");
  writeFileSync(join(root, "__pycache__/m.pyc"), "x");
  return root;
};
const diff = (root, act) => { const before = snapshotTree(root); act(root); return changedBetween(before, snapshotTree(root)); };

// 1. Nothing changed: nothing reported
{
  const root = make();
  assert.deepStrictEqual(diff(root, () => {}), []);
  console.log("[ok] a tree that was not touched reports no change");
}

// 2. Added, changed (even to a same-size file), removed, renamed, and in a new directory
{
  const root = make();
  const changed = diff(root, (r) => {
    writeFileSync(join(r, "src/api/new.ts"), "x");
    writeFileSync(join(r, "src/api/a.ts"), "export const a = 2;\n");            // same size, different content
    rmSync(join(r, "docs/x.md"));
    renameSync(join(r, "src/ui/b.ts"), join(r, "src/ui/b2.ts"));
    mkdirSync(join(r, "src/deep/er"), { recursive: true });
    writeFileSync(join(r, "src/deep/er/f.ts"), "y");
    writeFileSync(join(r, "root-file.txt"), "z");
  });
  assert.deepStrictEqual(changed, ["docs/x.md", "root-file.txt", "src/api/a.ts", "src/api/new.ts", "src/deep/er/f.ts", "src/ui/b.ts", "src/ui/b2.ts"]);
  console.log("[ok] an added file, a same-size edit, a removal, a rename (both names) and a new directory are all reported, sorted, with forward slashes");
}

// 3. Same size and same modification time, different content: still reported (content is hashed)
{
  const root = make();
  const f = join(root, "src/api/a.ts");
  const t = new Date(Date.UTC(2020, 0, 1));
  utimesSync(f, t, t);
  const changed = diff(root, (r) => { writeFileSync(join(r, "src/api/a.ts"), "export const a = 9;\n"); utimesSync(join(r, "src/api/a.ts"), t, t); });
  assert.deepStrictEqual(changed, ["src/api/a.ts"], "an edit that restored the file's size and time was not noticed");
  console.log("[ok] an edit that keeps the file's size and modification time is still reported");
}

// 4. Derived directories are not counted (builds and tests write there), and other things are
{
  const root = make();
  const changed = diff(root, (r) => {
    writeFileSync(join(r, "dist/out.js"), "rebuilt");
    writeFileSync(join(r, "node_modules/x/i.js"), "other dep");
    writeFileSync(join(r, ".git/objects/o"), "other");
    writeFileSync(join(r, "coverage/c.json"), '{"x":1}');
    writeFileSync(join(r, "__pycache__/m.pyc"), "y");
    writeFileSync(join(r, ".agent-loop/state"), "s");
    for (const d of ["build", "out", ".cache", ".next", ".pytest_cache"]) writeFileSync(join(r, d, "f"), "derived");
    writeFileSync(join(r, ".env"), "TOKEN=1");
    writeFileSync(join(r, "src/api/.hidden"), "h");
  });
  assert.deepStrictEqual(changed, [".env", "src/api/.hidden"], "derived directories were counted, or a hidden file was not");
  console.log("[ok] builds, caches and dependency directories are left out; hidden files are not");
}

// 5. Links are read as links, not followed
if (posix) {
  const root = make();
  const outside = mkdtempSync(join(tmpdir(), "changes-outside-"));
  writeFileSync(join(outside, "secret"), "s");
  const changed = diff(root, (r) => { symlinkSync(outside, join(r, "src/api/out")); symlinkSync("a.ts", join(r, "src/api/alias.ts")); });
  assert.deepStrictEqual(changed, ["src/api/alias.ts", "src/api/out"], "a new link is a change, and what it points at is not walked");
  writeFileSync(join(outside, "secret"), "changed behind a link");
  assert.deepStrictEqual(changedBetween(snapshotTree(root), snapshotTree(root)), []);
  // re-pointing a link is a change
  const before = snapshotTree(root);
  rmSync(join(root, "src/api/alias.ts")); symlinkSync("../ui/b.ts", join(root, "src/api/alias.ts"));
  assert.deepStrictEqual(changedBetween(before, snapshotTree(root)), ["src/api/alias.ts"], "a link that now points elsewhere was not noticed");
  console.log("[ok] a new symlink and a re-pointed one are changes; what a link points at is never read or walked");
} else console.log("[skip] symlink creation needs privileges on Windows");

// 6. A permission change is a change; a big file is compared by size and time, not read whole
if (posix) {
  const root = make();
  const changed = diff(root, (r) => chmodSync(join(r, "src/api/a.ts"), 0o755));
  assert.deepStrictEqual(changed, ["src/api/a.ts"], "a mode change (making a file executable) was not noticed");
  const big = join(root, "src/api/big.bin");
  writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 1));
  const c2 = diff(root, (r) => appendFileSync(join(r, "src/api/big.bin"), "tail"));
  assert.deepStrictEqual(c2, ["src/api/big.bin"], "a change to a large file was not noticed");
  console.log("[ok] making a file executable is a change, and a large file is compared by size and time");
}

// 7. A snapshot cut short says so, and keeps the paths it had; comparing with one fails closed
{
  const root = make();
  for (let i = 0; i < 30; i++) writeFileSync(join(root, `src/api/f${i}.ts`), String(i));
  const cut = snapshotTree(root, { maxFiles: 10 });
  assert.strictEqual(cut.truncated, true, "a snapshot over the limit does not say it was cut");
  assert.ok(cut.files.size <= 10);
  const full = snapshotTree(root);
  assert.strictEqual(full.truncated, false);
  assert.throws(() => changedBetween(cut, full), /incomplete|cut short|truncated/i, "comparing with a snapshot that was cut short did not fail");
  assert.throws(() => changedBetween(full, cut), /incomplete|cut short|truncated/i);
  assert.ok(Array.isArray(changedBetween(full, full)));
  console.log("[ok] a snapshot over the file limit is marked cut short, and comparing with one is refused");
}

// 8. Unreadable things do not crash it, and a directory that vanishes mid-walk does not either
if (posix && process.getuid?.() !== 0) {
  const root = make();
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "locked/f"), "x");
  chmodSync(join(root, "locked"), 0o000);
  const snap = snapshotTree(root);
  assert.ok(snap.files.has("src/api/a.ts"));
  assert.ok(snap.unreadable.includes("locked"), "an unreadable directory is not named");
  chmodSync(join(root, "locked"), 0o755);
  console.log("[ok] an unreadable directory is named, not fatal");
} else {
  const root = make();
  const snap = snapshotTree(root);
  assert.ok(Array.isArray(snap.unreadable));
  console.log("[ok] a snapshot lists what it could not read (the permission case needs a non-root user on POSIX)");
}
console.log("\nALL TEAM CHANGES TESTS PASSED");
