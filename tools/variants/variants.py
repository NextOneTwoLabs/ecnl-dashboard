"""#203: builds the data variants the refresh-proof bar is run on, and runs the whole suites on them. Offline, standard library and Node only.

    python tools/variants/variants.py build <variant> <outdir> [--teams 1,2] [--tests-from <git-ref>]
    python tools/variants/variants.py run   <copy-dir> <logfile> node|py

`build` copies this checkout (the working tree without .git) to <outdir>, takes the copy to <variant> with sim_games.mjs (and
sim_rollover.py), rebuilds the history files and search data in the copy with the repo's own builders (archive.py --team-index --all,
--team-history, --search-data), and makes the copy a git repository (two git tests need one). `--tests-from <ref>` swaps the copy's
tests/, README.md and .github for those of a git ref, to run the old tests on the same data. `run` runs the whole Node suite (the README
command) or the whole Python suite in the copy and writes its output to <logfile>.

Variants: base, refresh, season-end, double-header, remove (--teams, default 55477), withdraw-many, rename (--teams), late-add,
nofile (--teams: delete that team's history file), rollover3 (season end, then 2027-28 registered, ages moved up one, rebuilt).

Safety: nothing here edits a checkout. <outdir> and <copy-dir> must be outside this checkout (the repo root and any path inside it are
refused) and <outdir> must be empty or missing; every command that runs does so with the network guard on (tests/netguard) and a dead
proxy on 127.0.0.1:9, so no request can leave the machine. `python tools/variants/subset.py` compares two runs.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
VARIANTS = ("base", "refresh", "season-end", "double-header", "remove", "withdraw-many", "rename", "late-add", "nofile", "rollover3")
DEAD_PROXY = "http://127.0.0.1:9"


def outside(path, what="directory"):
    """The resolved path, refused when it is this checkout's root, inside it, or above it."""
    p = Path(path).resolve()
    if p == REPO or REPO in p.parents:
        raise SystemExit(f"refusing {p}: it is this checkout (or inside it); pass a {what} outside the repo")
    if p in REPO.parents:
        raise SystemExit(f"refusing {p}: it holds this checkout; pass a {what} outside the repo")
    return p


def env(copy):
    e = dict(os.environ, HTTP_PROXY=DEAD_PROXY, HTTPS_PROXY=DEAD_PROXY, http_proxy=DEAD_PROXY, https_proxy=DEAD_PROXY)
    e["PYTHONPATH"] = os.pathsep.join(["tests/netguard"] + ([e["PYTHONPATH"]] if e.get("PYTHONPATH") else []))
    e["NETGUARD_REPORT"] = "1"
    return e


def sh(cmd, cwd, copy, **kw):
    e = env(copy)
    e.update(kw.pop("env_extra", {}))
    return subprocess.run(cmd, cwd=cwd, env=e, check=kw.pop("check", True), **kw)


def copy_checkout(dest):
    ignore = shutil.ignore_patterns(".git", "node_modules", "__pycache__")
    shutil.copytree(REPO, dest, ignore=ignore, symlinks=True, dirs_exist_ok=True)


def build(variant, outdir, teams=None, tests_from=None):
    if variant not in VARIANTS:
        raise SystemExit(f"unknown variant {variant}; one of {', '.join(VARIANTS)}")
    out = outside(outdir)
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"refusing {out}: it is not empty")
    out.mkdir(parents=True, exist_ok=True)
    copy_checkout(out)
    netguard = str(out / "tests/netguard/netguard.mjs")
    node = lambda *a: sh(["node", "--import", netguard, str(HERE / "sim_games.mjs"), str(out), *a], out, out)
    team_args = ["--teams", teams] if teams else []
    if variant in ("refresh", "season-end", "double-header", "remove", "withdraw-many", "rename", "late-add"):
        node(variant, *team_args)
    elif variant == "nofile":
        for t in (teams or "55477").split(","):
            (out / f"public/archive/history/{t}.json").unlink()
    elif variant == "rollover3":
        node("season-end")
        sh([sys.executable, str(HERE / "sim_rollover.py"), str(out)], out, out)
    if variant not in ("base", "nofile"):
        for flag in (["--team-index", "--all"], ["--team-history"], ["--search-data"]):
            r = sh([sys.executable, "archive.py", *flag], out, out, capture_output=True, text=True)
            print((r.stdout.strip().splitlines() or [""])[-1])
    if tests_from:
        for d in ("tests", ".github"):
            shutil.rmtree(out / d, ignore_errors=True)
        tar = subprocess.run(["git", "-C", str(REPO), "archive", tests_from, "tests", "README.md", ".github"], check=True, capture_output=True).stdout
        subprocess.run(["tar", "-x", "-C", str(out)], input=tar, check=True)
    git = ["git", "-c", "user.email=variants@example.invalid", "-c", "user.name=variants"]
    sh(["git", "init", "-q"], out, out)
    sh(["git", "add", "-A"], out, out, capture_output=True)
    sh([*git, "commit", "-qm", f"variant {variant}"], out, out, capture_output=True)
    print(f"built {variant} in {out}")


def node_files(copy):
    readme = (copy / "README.md").read_text(encoding="utf-8")
    m = re.search(r"node --import \./tests/netguard/netguard\.mjs --test ([^#\n]*)", readme)
    if not m:
        raise SystemExit("README.md has no Node test command")
    return m.group(1).split()


def run(copy, logfile, kind):
    cp = outside(copy, "copy")
    log = outside(logfile, "log file")
    if kind == "node":
        cmd = ["node", "--import", "./tests/netguard/netguard.mjs", "--test", *node_files(cp)]
    elif kind == "py":
        cmd = [sys.executable, "-m", "unittest", "discover", "-v", "-s", "tests", "-p", "test_*.py"]
    else:
        raise SystemExit("run: node or py")
    # A private TMPDIR: two runs side by side must not see each other's temp folders (tests count their own).
    tmp = tempfile.mkdtemp(prefix="variants-run-")
    try:
        with open(log, "w", encoding="utf-8") as f:
            r = sh(cmd, cp, cp, stdout=f, stderr=subprocess.STDOUT, check=False, env_extra={"TMPDIR": tmp})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    text = log.read_text(encoding="utf-8", errors="replace")
    attempts = sum(int(m) for m in re.findall(r"netguard: (\d+) attempts", text))
    keys = ("# tests", "# pass", "# fail", "# skipped") if kind == "node" else ("Ran ", "OK", "FAILED")
    print(f"{kind} {log.name}: exit {r.returncode}; " + "; ".join(l.strip() for l in text.splitlines() if l.startswith(keys))
          + (f"; netguard: {attempts} attempts in all" if kind == "node" else ""))
    return r.returncode


def main(argv):
    if len(argv) >= 3 and argv[0] == "build":
        teams = argv[argv.index("--teams") + 1] if "--teams" in argv else None
        tests_from = argv[argv.index("--tests-from") + 1] if "--tests-from" in argv else None
        return build(argv[1], argv[2], teams, tests_from)
    if len(argv) == 4 and argv[0] == "run":
        return run(argv[1], argv[2], argv[3])
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
