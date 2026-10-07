// Files the agent may attach (docs/HYBRID-AGENT-SPEC.md S2; threat B7 "uploading the wrong file"): the model names a file the user designated in `<home>/uploads.json`, never a path. No browser here: the config's shape and
// its file hardening, then what a name resolves to at the moment of use (a link, a swapped directory, a changed content, a file inside the agent-loop home, a path pretending to be a name).
//   npm run build && npm run test:uploads
import assert from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUploads, parseUploads, resolveUpload, NO_UPLOADS, UPLOAD_EXTENSIONS } from "../dist/uploads.js";

const posix = process.platform !== "win32";
const scratch = () => mkdtempSync(join(tmpdir(), "uploads-"));
const write = (p, text = "%PDF-1.4 a résumé") => { writeFileSync(p, text); return p; };

// 1. The shape of the file: names, paths, types, pins
{
  const dir = scratch();
  const resume = write(join(dir, "resume.pdf"));
  const ok = parseUploads({ files: { resume, "cover-letter": { path: write(join(dir, "Cover.DOCX")), maxBytes: 1000 }, portrait: { path: write(join(dir, "me.jpg")), sha256: "A".repeat(64) } } });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepStrictEqual(ok.value.files.map((f) => f.name), ["resume", "cover-letter", "portrait"]);
  assert.strictEqual(ok.value.files[0].maxBytes, 10 * 1024 * 1024);
  assert.strictEqual(ok.value.files[1].maxBytes, 1000);
  assert.strictEqual(ok.value.files[2].sha256, "a".repeat(64), "a pin was not folded to lower case");
  assert.ok(ok.value.files.every((f) => typeof f.canonical === "string"), "a file that exists was not pinned to its real path");

  const bad = (spec, why) => { const r = parseUploads(spec); assert.ok(!r.ok && r.errors.some((e) => why.test(e)), `${JSON.stringify(spec)} -> ${JSON.stringify(r)}`); };
  bad(null, /must be a JSON object/); bad([], /must be a JSON object/); bad("x", /must be a JSON object/);
  bad({ file: {} }, /unknown key "file"/);
  bad({ files: [] }, /must be an object/); bad({ files: null }, /must be an object/);
  for (const name of ["Resume", "re sume", "../x", "9lives", "", "x".repeat(32), "a.b"]) bad({ files: { [name]: resume } }, /a name is lower-case/);
  bad({ files: { r: 7 } }, /path must be a text/); bad({ files: { r: "" } }, /path must be a text/); bad({ files: { r: { sha256: "a".repeat(64) } } }, /path must be a text/);
  bad({ files: { r: "resume.pdf" } }, /must be absolute/); bad({ files: { r: "./resume.pdf" } }, /must be absolute/); bad({ files: { r: "~/resume.pdf" } }, /must be absolute/);
  bad({ files: { r: resume + "\u0000.txt" } }, /control character/); bad({ files: { r: resume + "\n" } }, /control character/);
  bad({ files: { r: join(dir, "x".repeat(1100) + ".pdf") } }, /too long/);
  for (const ending of [".", " ", "/", "\\"]) bad({ files: { r: resume + ending } }, /must name a file/);
  for (const ext of ["exe", "sh", "js", "html", "svg", "zip", "key", "pem", "sqlite", "json", ""]) bad({ files: { r: join(dir, `thing${ext ? "." + ext : ""}`) } }, /only pdf, doc/);
  for (const sha of ["abc", "g".repeat(64), 7, null, "a".repeat(63)]) bad({ files: { r: { path: resume, sha256: sha } } }, /sha256 must be/);
  for (const max of [0, -1, 1.5, "10", 26 * 1024 * 1024, Number.NaN, null]) bad({ files: { r: { path: resume, maxBytes: max } } }, /maxBytes must be/);
  bad({ files: { r: { path: resume, sha265: "a".repeat(64) } } }, /unknown key "sha265"/);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, resume]));
  bad({ files: many }, /limit is 20/);
  assert.deepStrictEqual(UPLOAD_EXTENSIONS.filter((e) => ["exe", "sh", "js", "html", "svg", "zip", "pem", "key"].includes(e)), [], "a script, archive or key type is on the list");
  // an entry that is not there yet is accepted (it may be put there later) and has no pin
  const later = parseUploads({ files: { later: join(dir, "later.pdf") } });
  assert.ok(later.ok && later.value.files[0].canonical === undefined, JSON.stringify(later));
  console.log("[ok] uploads.json: names, absolute paths, document and image types, optional pin and size, unknown keys refused; a path with a control character, a trailing dot or space, or a script type is refused");
}

// 2. Nothing inside the agent-loop directory can be designated (it holds the saved sign-ins)
{
  const home = scratch();
  const profile = join(home, "profiles", "linkedin");
  mkdirSync(profile, { recursive: true });
  const stolen = write(join(profile, "resume.pdf"));
  const r = parseUploads({ files: { resume: stolen } }, { home });
  assert.ok(!r.ok && /inside the agent-loop directory/.test(r.errors[0]), JSON.stringify(r));
  const direct = parseUploads({ files: { resume: write(join(home, "resume.pdf")) } }, { home });
  assert.ok(!direct.ok && /inside the agent-loop directory/.test(direct.errors[0]), JSON.stringify(direct));
  const outside = parseUploads({ files: { resume: write(join(scratch(), "resume.pdf")) } }, { home });
  assert.ok(outside.ok, JSON.stringify(outside));
  if (posix) {
    // the home itself reached through a link: a file at its real place is inside it all the same
    const homeAlias = join(scratch(), "home-alias");
    symlinkSync(home, homeAlias);
    const viaHomeLink = parseUploads({ files: { resume: stolen } }, { home: homeAlias });
    assert.ok(!viaHomeLink.ok && /inside the agent-loop directory/.test(viaHomeLink.errors[0]), `a home reached through a link was not resolved: ${JSON.stringify(viaHomeLink)}`);
    // a file that does not exist yet, named through a link to the home
    const aliasDir = join(scratch(), "alias-to-home");
    symlinkSync(home, aliasDir);
    const notYet = parseUploads({ files: { resume: join(aliasDir, "profiles", "linkedin", "later.pdf") } }, { home });
    assert.ok(!notYet.ok && /inside the agent-loop directory/.test(notYet.errors[0]), `a file that does not exist yet, named through a link into the home, was accepted: ${JSON.stringify(notYet)}`);
    const via = join(scratch(), "alias");
    symlinkSync(home, via);
    const viaLink = parseUploads({ files: { resume: join(via, "profiles", "linkedin", "resume.pdf") } }, { home });
    assert.ok(!viaLink.ok && /inside the agent-loop directory/.test(viaLink.errors[0]), `a path through a link into the home was accepted: ${JSON.stringify(viaLink)}`);
  }
  console.log("[ok] a file inside the agent-loop directory, directly or through a link, cannot be designated");
}

// 3. The file is the user's: a link, a loose mode, someone else's, a directory, too large, not JSON
{
  const home = scratch();
  const none = loadUploads(home);
  assert.ok(none.ok && none.source === "none" && none.value === NO_UPLOADS, JSON.stringify(none));
  const file = join(home, "uploads.json");
  const resume = write(join(scratch(), "resume.pdf"));
  writeFileSync(file, JSON.stringify({ files: { resume } }), { mode: 0o600 });
  const good = loadUploads(home);
  assert.ok(good.ok && good.source === "file" && good.value.files[0].name === "resume", JSON.stringify(good));
  if (posix) {
    chmodSync(file, 0o666);
    let r = loadUploads(home);
    assert.ok(!r.ok && /writable by others/.test(r.errors[0]), JSON.stringify(r));
    chmodSync(file, 0o620);
    r = loadUploads(home);
    assert.ok(!r.ok && /writable by others/.test(r.errors[0]), "a file the group can write was accepted");
    chmodSync(file, 0o600);
    r = loadUploads(home, { uid: process.getuid() + 1 });
    assert.ok(!r.ok && /not owned by you/.test(r.errors[0]), JSON.stringify(r));
    const other = scratch();
    symlinkSync(file, join(other, "uploads.json"));
    r = loadUploads(other);
    assert.ok(!r.ok && /is a link/.test(r.errors[0]), JSON.stringify(r));
  }
  const dirHome = scratch();
  mkdirSync(join(dirHome, "uploads.json"));
  assert.ok(/not a file/.test(loadUploads(dirHome).errors?.[0] ?? ""), "a directory was read as the file");
  const bigHome = scratch();
  writeFileSync(join(bigHome, "uploads.json"), " ".repeat(200_000), { mode: 0o600 });
  assert.ok(/too large/.test(loadUploads(bigHome).errors?.[0] ?? ""));
  const badHome = scratch();
  writeFileSync(join(badHome, "uploads.json"), "{ nope", { mode: 0o600 });
  assert.ok(/not valid JSON/.test(loadUploads(badHome).errors?.[0] ?? ""));
  const shapeHome = scratch();
  writeFileSync(join(shapeHome, "uploads.json"), JSON.stringify({ files: { Resume: resume } }), { mode: 0o600 });
  const shape = loadUploads(shapeHome);
  assert.ok(!shape.ok && /uploads\.json: files\.Resume: a name is lower-case/.test(shape.errors[0]), JSON.stringify(shape));
  // the file inside the home is refused through the loader too (it knows the home)
  const insideHome = scratch();
  writeFileSync(join(insideHome, "uploads.json"), JSON.stringify({ files: { resume: write(join(insideHome, "resume.pdf")) } }), { mode: 0o600 });
  assert.ok(/inside the agent-loop directory/.test(loadUploads(insideHome).errors?.[0] ?? ""), "the loader did not tell the parser where the home is");
  console.log("[ok] uploads.json is read like the allowances file: no file means nothing may be uploaded; a link, a file others can write, someone else's file, a directory, an oversize or invalid file, and a bad entry are refused");
}

// 4. A name is resolved at the moment of use; a path is never a name
{
  const dir = scratch();
  const resume = write(join(dir, "resume.pdf"), "%PDF-1.4 the real résumé");
  const loaded = parseUploads({ files: { resume, notes: join(dir, "notes.txt") } });
  assert.ok(loaded.ok);
  const uploads = loaded.value;
  const good = resolveUpload(uploads, "resume");
  assert.ok(good.ok && good.fileName === "resume.pdf" && good.name === "resume" && good.bytes > 10, JSON.stringify(good));
  assert.ok(!JSON.stringify(good.error ?? "").includes(dir));

  const refuse = (name, why, set = uploads) => { const r = resolveUpload(set, name); assert.ok(!r.ok && why.test(r.error), `${JSON.stringify(name)} -> ${JSON.stringify(r)}`); assert.ok(!r.error.includes(dir), `the answer holds the user's directory: ${r.error}`); return r; };
  assert.ok(/no files are designated/.test(resolveUpload(NO_UPLOADS, "resume").error));
  for (const path of ["/etc/passwd", "../../etc/passwd", "..", "C:\\Windows\\win.ini", "~/.ssh/id_rsa", resume, "resume.pdf", "resume.", "resume:stream"]) refuse(path, /pass the NAME of a designated file, never a path.*Designated names: resume, notes/);
  for (const odd of [undefined, null, 7, {}, ["resume"], "", "RESUME", "resume ", " resume"]) refuse(odd, /is not a designated file/);
  refuse("notes", /the file for "notes" is missing/);
  assert.ok(resolveUpload(uploads, "toString").ok === false && resolveUpload(uploads, "__proto__").ok === false && resolveUpload(uploads, "constructor").ok === false, "an object property was taken for a name");

  // swapped for a link to somewhere else
  if (posix) {
    const secret = write(join(scratch(), "secret.txt"), "PRIVATE");
    renameSync(resume, join(dir, "resume.real"));
    symlinkSync(secret, resume);
    refuse("resume", /is a link/);
    rmSync(resume);
    renameSync(join(dir, "resume.real"), resume);
    assert.ok(resolveUpload(uploads, "resume").ok, "a restored file was still refused");
    // a parent directory swapped for a link after the session started: the real path differs from the pinned one
    const parent = scratch(), elsewhere = scratch();
    const pdf = write(join(parent, "cv.pdf"));
    write(join(elsewhere, "cv.pdf"), "ANOTHER");
    const pinned = parseUploads({ files: { cv: pdf } }).value;
    assert.ok(resolveUpload(pinned, "cv").ok);
    renameSync(parent, parent + ".moved");
    symlinkSync(elsewhere, parent);
    refuse("cv", /is not where it was when the session started/, pinned);
  }
  // a directory, an empty file, too large, a type that is not allowed any more
  const asDir = join(dir, "folder.pdf");
  mkdirSync(asDir);
  refuse("folder", /is not a regular file/, parseUploads({ files: { folder: asDir } }).value);
  const empty = join(dir, "empty.pdf");
  writeFileSync(empty, "");
  refuse("empty", /is empty/, parseUploads({ files: { empty } }).value);
  const big = join(dir, "big.pdf");
  writeFileSync(big, "x".repeat(2000));
  refuse("big", /is too large \(2000 bytes; the limit is 1000\)/, parseUploads({ files: { big: { path: big, maxBytes: 1000 } } }).value);
  assert.ok(resolveUpload(parseUploads({ files: { big: { path: big, maxBytes: 2000 } } }).value, "big").ok, "a file at exactly its limit was refused");
  // the user pins the content
  const text = "%PDF-1.4 the real résumé";
  const sum = createHash("sha256").update(text).digest("hex");
  const pinned = parseUploads({ files: { resume: { path: resume, sha256: sum } } }).value;
  assert.ok(resolveUpload(pinned, "resume").ok, "a file that matches its pin was refused");
  writeFileSync(resume, "%PDF-1.4 something else, written by a script");
  refuse("resume", /has changed since the user pinned its SHA-256/, pinned);
  // a hand-built entry with a type that is not allowed is refused at the moment of use too
  const script = write(join(dir, "run.sh"), "#!/bin/sh\necho hi");
  refuse("script", /is not a document or image type/, { files: [{ name: "script", path: script, maxBytes: 1000 }] });
  // a file that did not exist when the config was read has no pin, and is accepted once it exists
  const lateParse = parseUploads({ files: { later: join(dir, "later.pdf") } });
  assert.ok(lateParse.ok && lateParse.value.files[0].canonical === undefined);
  write(join(dir, "later.pdf"));
  const lateRes = resolveUpload(lateParse.value, "later");
  assert.ok(lateRes.ok && lateRes.fileName === "later.pdf", JSON.stringify(lateRes));
  // a file that is not there at all
  rmSync(resume);
  refuse("resume", /the file for "resume" is missing/, pinned);
  console.log("[ok] a name resolves to a regular file at the moment of use; a path, a link, a swapped directory, a changed pin, an empty, oversize or missing file and an object property are refused, and no answer holds the user's directory");
}
console.log("\nALL UPLOADS TESTS PASSED");
