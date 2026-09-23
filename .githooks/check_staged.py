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

ENV_FILE_RE = re.compile(r"(^|/)\.env(\.[A-Za-z0-9_.-]+)?$")
ENV_ALLOW_RE = re.compile(r"\.env\.(example|sample|template|dist)$", re.I)

# Docs necessarily *name* the destructive patterns they warn about (a security tool's own README
# is the clearest case) — that's prose describing a command, not a command that will ever run.
# Secrets get no such exemption: a real key pasted into a README by mistake is still a real key.
DOC_FILE_RE = re.compile(r"\.(md|mdx|rst|txt)$", re.I)

SECRET_PATTERNS = [
    (re.compile(r"AKIA[0-9A-Z]{16}"), "Possible AWS access key ID"),
    (re.compile(r"ASIA[0-9A-Z]{16}"), "Possible AWS temporary access key ID"),
    (re.compile(r"-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"), "Private key material"),
    (re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}"), "Possible Slack token"),
    (re.compile(r"gh[pousr]_[0-9A-Za-z]{30,}"), "Possible GitHub token"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "Possible API secret key (OpenAI/Anthropic-style)"),
    (
        re.compile(r"(?i)\b(api|access|secret|client)[_-]?(key|token|secret)\b\s*[:=]\s*[\"'][A-Za-z0-9/+_.=-]{12,}[\"']"),
        "Possible hardcoded credential",
    ),
    (re.compile(r"(?i)\bpassword\b\s*[:=]\s*[\"'][^\"' ]{6,}[\"']"), "Possible hardcoded password"),
]

# Applied only to the two generic, higher-false-positive patterns above (last two).
PLACEHOLDER_RE = re.compile(
    r"(?i)(changeme|your[_-]?(api)?[_-]?key|example|placeholder|xxxx|dummy|fake|test[_-]?only|<[^>]+>|\$\{|\$\()"
)
GENERIC_PATTERN_COUNT = 2  # last N entries in SECRET_PATTERNS that PLACEHOLDER_RE applies to

DESTRUCTIVE_PATTERNS = [
    (re.compile(r"(?i)\bDROP\s+(TABLE|DATABASE|SCHEMA)\b"), "Destructive SQL: DROP"),
    (re.compile(r"(?i)\bTRUNCATE\s+TABLE\b"), "Destructive SQL: TRUNCATE"),
    (re.compile(r"(?i)\bALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN\b"), "Destructive SQL: DROP COLUMN"),
    (re.compile(r"(?i)\bDELETE\s+FROM\s+\S+\s*;"), "DELETE without a WHERE clause on the same line"),
    (re.compile(r"(?i)\bUPDATE\s+\S+\s+SET\b(?!.*\bWHERE\b)"), "UPDATE without a WHERE clause on the same line"),
    (re.compile(r"rm\s+-rf\s+(/(\s|$)|~|\*|\$HOME\b|\$\{HOME\})"), "Destructive shell: rm -rf on root/home/wildcard"),
    (re.compile(r"(?i)git\s+push\s+[^\n]*--force(?!-with-lease)\b"), "Force push (bypasses history protection)"),
    (re.compile(r"(?i)git\s+reset\s+--hard\b"), "Hard reset (discards local work)"),
    (re.compile(r"chmod\s+-R\s+777\s+/(\s|$)"), "Dangerous recursive chmod on root"),
    (re.compile(r"dd\s+if=\S+\s+of=/dev/\S+"), "Raw disk write"),
    (re.compile(r":\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:"), "Fork bomb pattern"),
]


def run(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return result.stdout


def repo_root():
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    ).stdout.strip()
    return out or os.getcwd()


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


def check_diff(diff_text):
    findings = []
    for file, lineno, content in iter_added_lines(diff_text):
        display_file = file or "(unknown file)"
        for idx, (pattern, label) in enumerate(SECRET_PATTERNS):
            if idx >= len(SECRET_PATTERNS) - GENERIC_PATTERN_COUNT and PLACEHOLDER_RE.search(content):
                continue
            if pattern.search(content):
                findings.append(("SECRET", display_file, lineno, label, content.strip()[:200]))
        if file and DOC_FILE_RE.search(file):
            continue
        for pattern, label in DESTRUCTIVE_PATTERNS:
            if pattern.search(content):
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
    result = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
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
        result = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
        if result.returncode == 1:
            print("[dev-workflow] Gitleaks flagged possible secrets:\n" + (result.stdout or result.stderr))
            hit = True
        elif result.returncode not in (0, 1):
            print(f"[dev-workflow] gitleaks exited unexpectedly ({result.returncode}):\n{result.stderr}", file=sys.stderr)
    else:
        for r in ranges:
            cmd = [exe, "git", f"--log-opts={r}", "--no-banner", "--exit-code", "1", "."]
            result = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
            if result.returncode == 1:
                print(f"[dev-workflow] Gitleaks flagged possible secrets in {r}:\n" + (result.stdout or result.stderr))
                hit = True
            elif result.returncode not in (0, 1):
                print(f"[dev-workflow] gitleaks exited unexpectedly ({result.returncode}):\n{result.stderr}", file=sys.stderr)
    return hit


def print_report(findings):
    by_category = {}
    for category, file, lineno, label, snippet in findings:
        by_category.setdefault(category, []).append((file, lineno, label, snippet))

    titles = {
        "ENV_FILE": "Environment files",
        "SECRET": "Possible secrets",
        "DESTRUCTIVE": "Destructive commands / SQL",
    }
    print("[dev-workflow] BLOCKED — the following issues were found:\n")
    for category in ("ENV_FILE", "SECRET", "DESTRUCTIVE"):
        items = by_category.get(category)
        if not items:
            continue
        print(f"  {titles[category]}:")
        for file, lineno, label, snippet in items:
            loc = f"{file}:{lineno}" if lineno else file
            print(f"    - {loc} — {label}")
            if snippet and category != "ENV_FILE":
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

    if args.mode == "commit":
        names = [n for n in run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"], root).splitlines()]
        diff_text = run(["git", "diff", "--cached", "-U0", "--no-color"], root)
        all_names.extend(names)
        findings.extend(check_filenames(names))
        findings.extend(check_diff(diff_text))
    else:
        if not args.ranges:
            print("[dev-workflow] No ref ranges to check.")
            sys.exit(0)
        for r in args.ranges:
            names = [n for n in run(["git", "diff", "--name-only", "--diff-filter=ACM", r], root).splitlines()]
            diff_text = run(["git", "diff", "-U0", "--no-color", r], root)
            all_names.extend(names)
            findings.extend(check_filenames(names))
            findings.extend(check_diff(diff_text))

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
