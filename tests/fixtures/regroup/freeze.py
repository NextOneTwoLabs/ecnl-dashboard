"""#203: re-freezes tests/fixtures/regroup/rows.json, the season rows of the five clubs the regroup and override tests name.

Reads committed files only (the archive and data/sources.json through team_history.season_rows): no git, no network. Run it under the netguard:

    PYTHONPATH=tests/netguard HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \\
        python tests/fixtures/regroup/freeze.py --freeze --commit <sha>

The clubs are those of ANCHORS: a team of the season before the regroup and the clubs of the teams it is offered. Every season of those
clubs is kept, without the long `last` lists (the builder does not need them). MANIFEST.json records the anchors, the commit and the
sha256 of rows.json over LF text (so a CRLF checkout hashes the same). Re-freezing is a reviewed PR.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))
import ecnl_api as api  # noqa: E402
import team_history as th  # noqa: E402

# (season, teamID): the Hawks G2011 (54493: offered 134153 and 134166), De Anza (94620, offered 69022), CESA (46817: an id reused for
# another age slot), the club of 79687 (the double-claim test), and NC Fusion by name (the one with two G11 sides).
ANCHORS = [("2025-26", 54493), ("2026-27", 134153), ("2026-27", 134166), ("2025-26", 94620), ("2026-27", 69022),
           ("2025-26", 46817), ("2026-27", 46817), ("2025-26", 79687)]
NAMED = [("2025-26", "NC Fusion ECNL G11")]


def sha(text):
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def dump(rows):
    """One row per line, seasons in order: a refresh that changes one row changes one line."""
    return "{\n" + ",\n".join(f'"{s}": [\n' + ",\n".join("  " + json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows[s]) + "\n]"
                               for s in sorted(rows)) + "\n}\n"


def main(argv):
    if "--freeze" not in argv or "--commit" not in argv or not re.fullmatch(r"[0-9a-f]{7,40}", argv[argv.index("--commit") + 1] if argv.index("--commit") + 1 < len(argv) else ""):
        raise SystemExit("usage: freeze.py --freeze --commit <sha>")
    commit = argv[argv.index("--commit") + 1]
    rows = th.season_rows(api.load_sources())
    byk = {(r["season"], r["teamID"]): r for s in rows.values() for r in s}
    clubs = {byk[k]["clubID"] for k in ANCHORS}
    for season, name in NAMED:
        (hit,) = [r for r in rows[season] if r["name"] == name]
        clubs.add(hit["clubID"])
    kept = {s: [{k: v for k, v in r.items() if k != "last"} for r in rs if r["clubID"] in clubs] for s, rs in rows.items()}
    text = dump(kept)
    assert json.loads(text) == kept
    (HERE / "rows.json").write_text(text, encoding="utf-8", newline="\n")
    manifest = {"schema": 1, "commit": commit, "regroup": th.REGROUP, "anchors": [f"{s}/{t}" for s, t in ANCHORS],
                "named": [f"{s} {n}" for s, n in NAMED], "clubs": sorted(clubs), "rows": {s: len(v) for s, v in sorted(kept.items())},
                "bytes": len(text.encode("utf-8")), "sha256": sha(text)}
    (HERE / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"froze {sum(len(v) for v in kept.values())} rows of {len(clubs)} clubs, {manifest['bytes']} bytes")


if __name__ == "__main__":
    main(sys.argv[1:])
