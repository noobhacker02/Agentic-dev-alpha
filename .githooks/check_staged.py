#!/usr/bin/env python3
"""
Scans staged changes (--mode=commit) or a set of commit ranges (--mode=push) for:
  - .env files being added/modified
  - hardcoded secrets (API keys, private key material, known token formats)
  - destructive SQL (DROP/TRUNCATE/unguarded DELETE-UPDATE) and shell commands
    (rm -rf /, git push --force, git reset --hard, etc.)  # devskill:allow — naming what we detect

Exits non-zero if anything is found (after allowlist filtering). Also shells out to
TruffleHog for a deeper secret scan when it's installed on PATH; if it isn't, this
prints a warning and continues with the pattern-based checks only (they still block
on their own).

False positives: add an inline `# devskill:allow` (or the language's comment syntax
containing that literal text) on the offending line, or add a regex (one per line,
`#`-prefixed lines are comments) to a `.devskill-allowlist` file at the repo root —
any finding whose line content matches an allowlist regex is suppressed.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

ENV_FILE_RE = re.compile(r"(^|/)(\.env(\.[A-Za-z0-9_.-]+)?|[\w.-]+\.env|\.envrc)$")
ENV_ALLOW_RE = re.compile(r"\.env\.(example|sample|template|dist)$", re.I)

# Docs necessarily *name* the destructive patterns they warn about (a security tool's own README
# is the clearest case) — that's prose describing a command, not a command that will ever run.
# Narrowed to Markdown only (not .txt/.rst, which have no reliable prose-vs-code marker) and further
# narrowed to *outside fenced code blocks* — a ```bash block in a setup doc is code someone may copy-
# paste or a CI step may literally extract and run, not prose. Secrets get no such exemption at all:
# a real key pasted into a README by mistake is still a real key.
MARKDOWN_FILE_RE = re.compile(r"\.(md|mdx)$", re.I)
FENCE_RE = re.compile(r"^\s*```")

SECRET_PATTERNS = [
    # (pattern, label, generic) — "generic" patterns must capture the secret itself in a group
    # named `value`, so the placeholder check below looks only at that value, not the whole line
    # (a real key with an unrelated word like "example" elsewhere on the line must still block).
    (re.compile(r"AKIA[0-9A-Z]{16}"), "Possible AWS access key ID", False),
    (re.compile(r"ASIA[0-9A-Z]{16}"), "Possible AWS temporary access key ID", False),
    (
        re.compile(r"(?i)\baws_secret_access_key\b\s*[:=]\s*[\"']?(?P<value>[A-Za-z0-9/+=]{40})[\"']?"),
        "Possible AWS secret access key",
        False,
    ),
    (re.compile(r"-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----"), "Private key material", False),
    (re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}"), "Possible Slack token", False),
    (re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+"), "Slack webhook URL", False),
    (re.compile(r"gh[pousr]_[0-9A-Za-z]{30,}"), "Possible GitHub token (classic)", False),
    (re.compile(r"github_pat_[0-9A-Za-z_]{20,}"), "Possible GitHub fine-grained token", False),
    (re.compile(r"sk-ant-[A-Za-z0-9-]{20,}"), "Possible Anthropic API key", False),
    (re.compile(r"sk-proj-[A-Za-z0-9_-]{20,}"), "Possible OpenAI project API key", False),
    (re.compile(r"sk_live_[A-Za-z0-9]{16,}"), "Possible Stripe live secret key", False),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "Possible API secret key (OpenAI/Anthropic-style)", False),
    (re.compile(r"AIza[0-9A-Za-z_-]{35}"), "Possible Google API key", False),
    (re.compile(r"eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"), "Possible JWT", False),
    (
        re.compile(r"(?i)\b\w+://[^\s:/'\"]+:(?P<value>[^\s@/'\"]+)@[^\s/'\"]+"),
        "Possible URL with an inline password (connection string)",
        True,
    ),
    (
        re.compile(
            r"(?i)[\"']?(?:api|access|secret|client)[_-]?(?:key|token|secret)[\"']?\s*[:=]\s*[\"']?(?P<value>[A-Za-z0-9/+_.=-]{12,})[\"']?"
        ),
        "Possible hardcoded credential",
        True,
    ),
    (
        re.compile(r"(?i)[\"']?password[\"']?\s*[:=]\s*[\"']?(?P<value>[^\"'\s]{6,})[\"']?"),
        "Possible hardcoded password",
        True,
    ),
]

PLACEHOLDER_RE = re.compile(
    r"(?i)^(changeme|your[_-]?(api)?[_-]?key|example|placeholder|xxxx+|dummy|fake|test[_-]?only|<[^>]+>|\$\{[^}]*\}|\$\([^)]*\))$"
)


DANGEROUS_RM_TARGET_RE = re.compile(
    r'^(/|/\*|~|~/.*|\$HOME\b.*|"\$HOME"|\'\$HOME\'|\$\{HOME\}.*|\.\.|\.\./.*|\*|\.|\./|"\$\w+"/?|\$\w+/?)$'
)


def has_dangerous_rm(command):
    """True if any `rm` invocation combines recursive+force flags (in any order/spelling) with a
    target like `/`, `~`, `$HOME`, `..`, `.`, a bare `*`, or an unquoted/quoted shell variable —
    the flag-order and quoting variety a real stress test found the original single regex missed."""
    for match in re.finditer(r"\brm\s+([^\n;|&]*)", command, re.IGNORECASE):
        tokens = match.group(1).strip().split()
        recursive = force = False
        targets = []
        for tok in tokens:
            if tok == "--recursive":
                recursive = True
            elif tok == "--force":
                force = True
            elif tok == "--no-preserve-root":
                force = True  # only meaningful alongside -r, but signals intent
            elif re.fullmatch(r"-[a-zA-Z]+", tok):
                if re.search(r"[rR]", tok):
                    recursive = True
                if "f" in tok.lower():
                    force = True
            else:
                stripped = tok.strip("\"'")
                targets.append(tok)
                if stripped != tok:
                    targets.append(stripped)
        if recursive and force and any(DANGEROUS_RM_TARGET_RE.match(t) for t in targets):
            return True
    return False


# Each entry: (test function taking the line's content, label). Kept as small composable checks
# (mirrors agent-loop's src/hooks.ts safety net) rather than one giant regex, since flag-order and
# quoting independence is much easier to express procedurally than in a single pattern.
SHELL_DESTRUCTIVE_CHECKS = [
    (has_dangerous_rm, "Destructive shell: rm -rf targeting /, ~, $HOME, .., ., or a bare wildcard/variable"),  # devskill:allow
    (lambda c: bool(re.search(r":\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:", c)), "Fork bomb pattern"),
    (lambda c: bool(re.search(r"\bmkfs\.", c)), "Reformats a filesystem/device"),
    (lambda c: bool(re.search(r"\bdd\s+if=\S+\s+of=/dev/\S+", c)), "Raw disk write"),
    (lambda c: bool(re.search(r"chmod\s+-R\s+777\s+/(\s|$)", c)), "Dangerous recursive chmod on root"),
    (
        lambda c: bool(re.search(r"(?i)\bgit\s+push\b[^\n]*(--force(?!-with-lease)\b|\s-f(\s|$)|\s\+[\w./-]+)", c)),
        "Force push (--force, -f, or a +refspec) bypasses history protection",
    ),
    (lambda c: bool(re.search(r"(?i)\bgit\s+reset\s+--hard\b", c)), "Hard reset (discards local work)"),
    (
        lambda c: bool(re.search(r"(?i)\bgit\s+clean\s+(-\w*f\w*|--force)\b", c)),
        "git clean -f force-deletes untracked files",  # devskill:allow
    ),
    (
        lambda c: bool(re.search(r"(?i)\bgit\s+(checkout|restore)\s+(--\s+\.|\.)\s*$", c)),
        "Discards all local working-tree changes",
    ),
    (
        lambda c: bool(re.search(r"(?i)\bgit\s+branch\s+(-D\b|--delete\s+--force\b)", c)),
        "Force-deletes a branch",
    ),
    (lambda c: bool(re.search(r"(?i)\bfind\b[^\n]*-delete\b", c)), "find ... -delete"),  # devskill:allow
    (
        lambda c: bool(re.search(r"(?i)\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b", c)),  # devskill:allow
        "Pipes a remote script straight into a shell",
    ),
]

DESTRUCTIVE_PATTERNS = [
    (re.compile(r"(?i)\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b"), "Destructive SQL: DROP", False),
    (re.compile(r"(?i)\bTRUNCATE\s+(TABLE\s+)?\S+"), "Destructive SQL: TRUNCATE", False),
    (re.compile(r"(?i)\bALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN\b"), "Destructive SQL: DROP COLUMN", False),
    (re.compile(r"(?i)\bDELETE\s+FROM\s+\S+\b(?!.*\bWHERE\b)"), "DELETE without a WHERE clause", True),
    (re.compile(r"(?i)\bWHERE\s+1\s*=\s*1\b"), "WHERE 1=1 matches every row — not a real guard", False),  # devskill:allow
    (re.compile(r"(?i)\bUPDATE\s+\S+\s+SET\s+(?:(?!\bWHERE\b)[^;])*;"), "UPDATE without a WHERE clause on the same line", False),
    (re.compile(r"(?i)\.dropTable\s*\("), "ORM/query-builder table drop (e.g. knex)", False),
    (re.compile(r"\.objects\.all\(\)\.delete\(\)"), "Django: deletes every row in the table", False),
]


def run(cmd, cwd):
    result = subprocess.run(
        ["git", "-c", "core.quotePath=false", *cmd[1:]] if cmd[0] == "git" else cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",  # non-UTF-8 staged content must not crash the scanner
    )
    return result.stdout, result.returncode == 0


def repo_root():
    out, _ = run(["git", "rev-parse", "--show-toplevel"], os.getcwd())
    return out.strip() or os.getcwd()


def load_allowlist(root):
    path = os.path.join(root, ".devskill-allowlist")
    patterns = []
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    patterns.append(re.compile(line))
                except re.error:
                    print(f"[dev-workflow] WARNING: skipping invalid allowlist regex: {line}", file=sys.stderr)
    return patterns


def is_allowlisted(content, allowlist):
    if "devskill:allow" in content:
        return True
    return any(p.search(content) for p in allowlist)


def iter_added_lines(diff_text):
    current_file = None
    current_lineno = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            path = line[4:]
            current_file = None if path == "/dev/null" else path[2:] if path.startswith("b/") else path
            continue
        if line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            current_lineno = int(m.group(1)) if m else None
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield current_file, current_lineno, line[1:]
            if current_lineno is not None:
                current_lineno += 1


def check_filenames(names):
    findings = []
    for name in names:
        name = name.strip()
        if not name:
            continue
        if ENV_FILE_RE.search(name) and not ENV_ALLOW_RE.search(name):
            findings.append(("ENV_FILE", name, None, "Environment file staged/pushed — should never be committed", name))
    return findings


def line_in_fenced_code_block(full_text, target_lineno):
    """True if `target_lineno` (1-based) falls inside a ``` fence, scanning from the top of the
    file — a per-added-line diff can't tell this on its own, since the fence markers themselves
    may not be part of the diff (e.g. a line added inside a fence that already existed)."""
    in_fence = False
    for i, line in enumerate(full_text.splitlines(), start=1):
        if FENCE_RE.match(line):
            if i == target_lineno:
                return in_fence
            in_fence = not in_fence
            continue
        if i == target_lineno:
            return in_fence
    return False


def check_diff(diff_text, get_full_content=None):
    findings = []
    lines = list(iter_added_lines(diff_text))
    next_line_by_pos = {(f, ln): c for f, ln, c in lines if f is not None and ln is not None}
    fence_cache = {}

    for file, lineno, content in lines:
        display_file = file or "(unknown file)"
        for pattern, label, generic in SECRET_PATTERNS:
            m = pattern.search(content)
            if not m:
                continue
            if generic:
                value = m.groupdict().get("value") or m.group(0)
                if PLACEHOLDER_RE.search(value):
                    continue
            findings.append(("SECRET", display_file, lineno, label, content.strip()[:200]))

        exempt_as_prose = False
        if file and MARKDOWN_FILE_RE.search(file) and get_full_content is not None and lineno is not None:
            if file not in fence_cache:
                fence_cache[file] = get_full_content(file)
            full_content = fence_cache[file]
            if full_content is not None and not line_in_fenced_code_block(full_content, lineno):
                exempt_as_prose = True
        if exempt_as_prose:
            continue

        for pattern, label, needs_lookahead in DESTRUCTIVE_PATTERNS:
            if not pattern.search(content):
                continue
            if needs_lookahead and file is not None and lineno is not None:
                nxt = next_line_by_pos.get((file, lineno + 1), "")
                if re.match(r"(?i)^\s*WHERE\b", nxt):
                    continue  # guarded on the next line — a real multi-line statement, not a hole
            findings.append(("DESTRUCTIVE", display_file, lineno, label, content.strip()[:200]))

        for check, label in SHELL_DESTRUCTIVE_CHECKS:
            if check(content):
                findings.append(("DESTRUCTIVE", display_file, lineno, label, content.strip()[:200]))
    return findings


def run_trufflehog(root, files):
    exe = shutil.which("trufflehog")
    if not exe:
        print(
            "[dev-workflow] trufflehog not found on PATH — skipping deep secret scan "
            "(pattern-based checks above still ran and still block on their own). "
            "Install: https://github.com/trufflesecurity/trufflehog#install",
            file=sys.stderr,
        )
        return False
    existing = [f for f in files if f and os.path.isfile(os.path.join(root, f))]
    if not existing:
        return False
    cmd = [exe, "filesystem", *existing, "--no-update", "--fail"]
    result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        print("[dev-workflow] TruffleHog flagged possible secrets:\n" + (result.stdout or result.stderr))
        return True
    return False


def run_gitleaks(root, mode, ranges):
    exe = shutil.which("gitleaks")
    if not exe:
        print(
            "[dev-workflow] gitleaks not found on PATH — skipping the fast maintained-ruleset "
            "secret scan (pattern-based checks above still ran and still block on their own). "
            "Install: https://github.com/gitleaks/gitleaks#installing",
            file=sys.stderr,
        )
        return False
    hit = False
    if mode == "commit":
        cmd = [exe, "git", "--staged", "--no-banner", "--exit-code", "1", "."]
        result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode == 1:
            print("[dev-workflow] Gitleaks flagged possible secrets:\n" + (result.stdout or result.stderr))
            hit = True
        elif result.returncode not in (0, 1):
            print(f"[dev-workflow] gitleaks exited unexpectedly ({result.returncode}):\n{result.stderr}", file=sys.stderr)
    else:
        for r in ranges:
            cmd = [exe, "git", f"--log-opts={r}", "--no-banner", "--exit-code", "1", "."]
            result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if result.returncode == 1:
                print(f"[dev-workflow] Gitleaks flagged possible secrets in {r}:\n" + (result.stdout or result.stderr))
                hit = True
            elif result.returncode not in (0, 1):
                print(f"[dev-workflow] gitleaks exited unexpectedly ({result.returncode}):\n{result.stderr}", file=sys.stderr)
    return hit


def resolve_push_base(root, range_str):
    """An EMPTY_TREE..X range (a new branch's first push) rescans the entire history the branch
    forked from, which false-positives on anything already reviewed and merged before the branch
    existed. Prefer the merge-base with a local main/master (or that remote's tracking branch)
    when one is discoverable, so only commits actually new to this branch get scanned. Falls back
    to the empty tree — safe, just noisier — when no such base can be found."""
    prefix = EMPTY_TREE + ".."
    if not range_str.startswith(prefix):
        return range_str
    target = range_str[len(prefix):]
    for candidate in ("main", "master", "origin/main", "origin/master"):
        verify = subprocess.run(["git", "rev-parse", "-q", "--verify", candidate], cwd=root, capture_output=True, text=True)
        if verify.returncode != 0:
            continue
        mb = subprocess.run(["git", "merge-base", candidate, target], cwd=root, capture_output=True, text=True)
        if mb.returncode == 0 and mb.stdout.strip():
            return f"{mb.stdout.strip()}..{target}"
    return range_str


def print_report(findings):
    by_category = {}
    for category, file, lineno, label, snippet in findings:
        by_category.setdefault(category, []).append((file, lineno, label, snippet))

    titles = {
        "ENV_FILE": "Environment files",
        "SECRET": "Possible secrets",
        "DESTRUCTIVE": "Destructive commands / SQL",
        "SCAN_ERROR": "Scan could not complete",
    }
    print("[dev-workflow] BLOCKED — the following issues were found:\n")
    for category in ("ENV_FILE", "SECRET", "DESTRUCTIVE", "SCAN_ERROR"):
        items = by_category.get(category)
        if not items:
            continue
        print(f"  {titles[category]}:")
        for file, lineno, label, snippet in items:
            loc = f"{file}:{lineno}" if lineno else file
            print(f"    - {loc} — {label}")
            if snippet and category not in ("ENV_FILE", "SCAN_ERROR"):
                print(f"        {snippet}")
        print()
    print(
        "Fix the underlying issue (remove the secret/file and rotate any real credential, or "
        "guard the destructive command). If this is a genuine false positive, add an inline "
        "`# devskill:allow` comment on the line, or a regex to `.devskill-allowlist` at the repo "
        "root, then retry."
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["commit", "push"], default="commit")
    parser.add_argument("ranges", nargs="*")
    args = parser.parse_args()

    root = repo_root()
    allowlist = load_allowlist(root)

    findings = []
    all_names = []

    def make_full_content_getter(ref):
        def get(path):
            spec = f":{path}" if ref is None else f"{ref}:{path}"
            out = subprocess.run(["git", "show", spec], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
            return out.stdout if out.returncode == 0 else None

        return get

    if args.mode == "commit":
        names_out, names_ok = run(["git", "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "-M"], root)
        names = [n for n in names_out.split("\0") if n]
        diff_text, diff_ok = run(["git", "diff", "--cached", "-U0", "--no-color"], root)
        if not (names_ok and diff_ok):
            findings.append(("SCAN_ERROR", "(commit)", None, "git diff failed — treating as blocked (fail closed)", ""))
        all_names.extend(names)
        findings.extend(check_filenames(names))
        findings.extend(check_diff(diff_text, get_full_content=make_full_content_getter(None)))
    else:
        if not args.ranges:
            print("[dev-workflow] No ref ranges to check.")
            sys.exit(0)
        for raw_range in args.ranges:
            r = resolve_push_base(root, raw_range)
            names_out, names_ok = run(["git", "diff", "--name-only", "-z", "--diff-filter=ACMR", "-M", r], root)
            names = [n for n in names_out.split("\0") if n]
            diff_text, diff_ok = run(["git", "diff", "-U0", "--no-color", r], root)
            if not (names_ok and diff_ok):
                findings.append(("SCAN_ERROR", r, None, "git diff for this range failed — treating as blocked (fail closed)", ""))
                continue
            head_ref = r.split("..")[-1]
            all_names.extend(names)
            findings.extend(check_filenames(names))
            findings.extend(check_diff(diff_text, get_full_content=make_full_content_getter(head_ref)))

    findings = [f for f in findings if not is_allowlisted(f[4] or f[1], allowlist)]

    trufflehog_hit = run_trufflehog(root, set(all_names))
    gitleaks_hit = run_gitleaks(root, args.mode, args.ranges)

    if findings:
        print_report(findings)
        sys.exit(1)

    if trufflehog_hit or gitleaks_hit:
        sys.exit(1)

    print("[dev-workflow] No secrets, env files, or destructive commands detected.")
    sys.exit(0)


if __name__ == "__main__":
    main()
