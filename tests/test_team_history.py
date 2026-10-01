"""Team histories (#107): public/archive/history/<teamID>.json, built by team_history.py.

(a) The committed files equal a fresh build of the committed archive (the drift check), and a
    second build writes nothing.
(b) Invariants: every conference team-season is in exactly one squad and every conference team
    id has a file; every link ages correctly; the links never depend on the order of the input
    rows (M5), and adding a season never changes an older link; nothing is merged across the
    2026-27 regroup but the ids TGS moved up an age group (M6).
(c) What the page shows: event records add up (M1), only the open season is in progress (M2),
    the best Champions League finish and the titles (M3), "Runner-up" only against a decided
    champion (M4), the worked examples (MVLA G2011, a reused id).
(d) team-links.json: every entry validated by the builder; a bad one fails and changes nothing
    (S1); unlink works.
(e) Writing: never a half-built set; the refresh rebuilds exactly the files a changed flight
    touches, in the same run, and a failed build keeps the old files and fails the run.
(f) Privacy: only the allow-listed team-level fields are written.
"""
import argparse
import contextlib
import copy
import functools
import gzip
import io
import json
import os
from pathlib import Path
import random
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive
import ecnl_api as api
import team_history as th

FIX = "run `python archive.py --team-history`, then commit public/archive/history/"
SEASON_KEYS = {"season", "teamID", "name", "clubID", "clubName", "logo", "conference", "eventID", "divisionID",
               "division", "flightID", "flightName", "u", "birthYears", "rank", "of", "gp", "w", "d", "l", "pts",
               "gf", "ga", "gd", "ppg", "form", "games", "played", "link", "merged", "inProgress", "regroup", "last"}
LAST_KEYS = {"date", "home", "opp", "oppID", "gf", "ga", "pk"}   # #128: one played game behind a form letter
EVENT_KEYS = {"season", "stage", "eventID", "eventName", "divisionID", "division", "flightID", "flightName", "tier",
              "teamID", "games", "played", "w", "d", "l", "gf", "ga", "fromTable", "group", "reached", "champion",
              "final", "cup", "reconstructed", "dataGap", "inProgress", "location", "startDate", "endDate"}
REF_KEYS = {"season", "teamID", "name", "division", "conference"}
SQUAD_KEYS = {"clubID", "clubName", "birthYears", "best", "titles", "seasons", "postseason", "showcases",
              "maybe", "maybePrev"}


@functools.lru_cache(maxsize=None)
def built():
    """One build of the committed archive, shared by the tests that only read it."""
    return th.build()


_SEED = []


def seed_history(out):
    """A private copy of a fresh build of the history files (built once per run), so these
    tests depend neither on the committed data being present nor on it being current (that is
    the drift test's job), and never write into the checkout's own directory."""
    if not _SEED:
        tmp = tempfile.mkdtemp()
        unittest.addModuleCleanup(shutil.rmtree, tmp, ignore_errors=True)
        th.write_history(out_dir=os.path.join(tmp, "history"))
        _SEED.append(os.path.join(tmp, "history"))
    shutil.copytree(_SEED[0], out)


def links_of(rows, manual=None):
    nxt, maybe, _stats, errors = th.link_seasons(rows, manual or {})
    return nxt, maybe, errors


class Built(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = api.load_sources()
        cls.squads, cls.stats, cls.rows, cls.errors = built()
        cls.files = th.by_team(cls.squads)
        cls.byk = {(r["season"], r["teamID"]): r for s in cls.rows.values() for r in s}

    def squad_of(self, season, tid):
        return next(sq for sq in self.files[tid] if any(r["season"] == season for r in sq["seasons"] if r["teamID"] == tid))

    # ---------- (a) ----------

    def test_committed_files_match_a_fresh_build(self):
        diff, errors = th.check_history()
        self.assertEqual(errors, [])
        self.assertEqual(diff, [], FIX)

    def test_the_file_format_is_one_row_per_line(self):
        for tid in (55477, 46817, 54493):
            data = th.file_bytes(tid, self.files[tid])
            self.assertEqual(json.loads(data), th.document(tid, self.files[tid]))
            lines = {line.rstrip(",") for line in data.decode().split("\n")}
            for sq in self.files[tid]:
                for k in th.LISTS:
                    for item in sq.get(k, []):
                        self.assertIn(th._dump(item), lines, (tid, k))

    # ---------- (b) ----------

    def test_every_team_season_is_in_exactly_one_squad(self):
        seen = {}
        for sq in self.squads:
            for r in sq["seasons"]:
                k = (r["season"], r["teamID"])
                self.assertNotIn(k, seen)
                seen[k] = sq
        self.assertEqual(set(seen), set(self.byk))

    def test_every_conference_team_has_a_history_file(self):
        # S8: the glance card's history link is shown for teams in a conference table only,
        # which this guarantees have one.
        for s in self.sources["seasons"]:
            for t in (api.read_json_file(api.team_index_path(s)) or {}).get("teams") or []:
                self.assertIn(t["teamID"], self.files, (s, t["name"]))

    def test_links_age_correctly_and_respect_the_rules(self):
        for sq in self.squads:
            ch = sq["seasons"]
            self.assertEqual(ch[0]["link"], "start")
            for a, b in zip(ch, ch[1:]):
                self.assertTrue(th.ages_on(a, b), (a["name"], b["name"]))
                self.assertIn(b["link"], ("id", "name", "club", "manual"))
                if b["link"] == "id":
                    self.assertEqual(a["teamID"], b["teamID"])
                if b["link"] == "club":
                    self.assertNotEqual(a["clubID"], th.NO_CLUB)
                    self.assertEqual(a["clubID"], b["clubID"])
                if b["season"] == th.REGROUP:
                    self.assertIn(b["link"], ("id", "manual"), "no guessed link across the regroup")
                    if b["link"] == "id":
                        self.assertEqual(b["u"], a["u"] + 1, "M6: an id kept in its age slot is not merged")

    def test_links_do_not_depend_on_the_order_of_the_rows(self):
        # M5: with the rows reversed or shuffled, every link and every offer is the same.
        want = links_of(self.rows)
        for how in ("reversed", "shuffled"):
            rng = random.Random(107)
            rows = {s: (list(reversed(rs)) if how == "reversed" else rng.sample(rs, len(rs))) for s, rs in self.rows.items()}
            self.assertEqual(links_of(rows), want, how)

    def test_a_merger_is_offered_not_guessed(self):
        # The 2024-25 Fairfax merger (club 4603): two 2023-24 G2010 sides, one 2024-25 G2010.
        nxt, maybe, _ = links_of(self.rows)
        for pred in ((("2023-24", 69871)), ("2023-24", 68366)):
            self.assertNotIn(pred, nxt)
            self.assertEqual(maybe[pred], [("2024-25", 96996)])
        self.assertEqual([p["teamID"] for p in self.squad_of("2024-25", 96996)["maybePrev"]], [68366, 69871])

    def test_a_contested_continuation_names_the_other_claimant(self):
        # Review Must-fix 1: the 10 Fairfax / VA Union predecessors (2023-24, club 4603). Each is
        # offered its 2024-25 successor, and the page must be able to say who else could claim it.
        contested = [(sq, m) for sq in self.squads for m in sq.get("maybe", []) if m.get("alsoClaimedBy")]
        self.assertEqual(len(contested), 10)
        for sq, m in contested:
            last = sq["seasons"][-1]
            self.assertEqual((last["season"], last["clubID"], m["season"]), ("2023-24", 4603, "2024-25"))
            rivals = [(x["season"], x["teamID"]) for x in m["alsoClaimedBy"]]
            self.assertNotIn((last["season"], last["teamID"]), rivals)
            for x in m["alsoClaimedBy"]:
                self.assertIn(m["teamID"], [c["teamID"] for c in self.squad_of(x["season"], x["teamID"])["maybe"]])
        va = self.squad_of("2023-24", 69871)["maybe"]
        self.assertEqual([(m["name"], [x["name"] for x in m["alsoClaimedBy"]]) for m in va],
                         [("Fairfax VA Union ECNL G10", ["Fairfax BRAVE SC ECNL G10"])])
        # At the regroup the reason is the regroup, not a rival: never named there.
        self.assertFalse(any(m.get("alsoClaimedBy") for sq in self.squads for m in sq.get("maybe", []) if m["season"] == th.REGROUP))

    def test_the_regroup_offers_club_teams_another_side_lists_by_name(self):
        # Review: De Anza Force G12 (94620) kept its id in the same age group; the club's team one
        # age group up is another predecessor's name candidate, and is offered here too.
        sq = self.squad_of("2025-26", 94620)
        self.assertEqual([(m["teamID"], m["division"]) for m in sq["maybe"]], [(69022, "GU15"), (94620, "GU14")])

    def test_best_finish_ties_go_to_the_better_group_place(self):
        # Review nit: equal depth and stage: the better group place, then the latest season.
        for season, tid, want in (("2021-22", 46817, ("2022-23", 3)), ("2025-26", 82416, ("2023-24", 2))):
            sq = self.squad_of(season, tid)
            best = sq["postseason"][sq["best"]]
            self.assertEqual((best["season"], best["group"]["pos"]), want, tid)

    def test_adding_a_season_never_changes_an_older_link(self):
        nxt, maybe, _ = links_of(self.rows)
        seasons = sorted(self.rows)
        for keep in range(2, len(seasons)):
            part = {s: self.rows[s] for s in seasons[:keep]}
            n2, m2, _ = links_of(part)
            self.assertEqual(n2, {k: v for k, v in nxt.items() if k[0] in seasons[:keep - 1]}, seasons[keep - 1])
            self.assertEqual(m2, {k: v for k, v in maybe.items() if k[0] in seasons[:keep - 1]}, seasons[keep - 1])

    def test_the_regroup_offers_both_age_groups(self):
        # M6: every 2026-27 row carries the regroup note; an id TGS kept in the same age group
        # is offered, next to the club's team one age group up, never merged.
        for r in self.rows[th.REGROUP]:
            self.assertTrue(r.get("regroup"))
        prev = sorted(self.rows)[-2]
        carried = [(r, self.byk[(th.REGROUP, r["teamID"])]) for r in self.rows[prev]
                   if not th.ends(r) and (th.REGROUP, r["teamID"]) in self.byk and th.ages_on(r, self.byk[(th.REGROUP, r["teamID"])])
                   and self.byk[(th.REGROUP, r["teamID"])]["u"] == r["u"]]
        self.assertEqual(len(carried), 66)
        _nxt, maybe, _ = links_of(self.rows)
        for r, n in carried:
            self.assertIn((th.REGROUP, n["teamID"]), maybe[(prev, r["teamID"])], r["name"])
        # NC Fusion kept every id in its age slot: its G11 could be either 2026-27 side.
        fusion = next(r for r in self.rows[prev] if r["name"] == "NC Fusion ECNL G11")
        self.assertEqual(sorted(self.byk[c]["name"] for c in maybe[(prev, fusion["teamID"])]),
                         ["NC Fusion ECNL G2010/11", "NC Fusion ECNL G2011/12"])
        # Michigan Hawks G2011 (54493, a new id in 2026-27): both age groups offered.
        hawks = self.squad_of("2025-26", 54493)
        self.assertEqual([(m["teamID"], m["division"]) for m in hawks["maybe"]], [(134153, "GU16"), (134166, "GU15")])

    # ---------- (c) ----------

    def test_event_records_add_up(self):
        # M1: a record comes from the games; only a declared data gap may use the group table.
        for sq in self.squads:
            for e in sq["postseason"] + sq["showcases"]:
                if e.get("fromTable"):
                    self.assertTrue(e.get("dataGap"), (e["flightID"], e["teamID"]))
                else:
                    self.assertEqual(e["w"] + e["d"] + e["l"], e["played"], (e["flightID"], e["teamID"]))
        solar = next(e for e in self.squad_of("2020-21", 20122)["postseason"] if e["flightID"] == 9414)
        self.assertEqual((solar["w"], solar["d"], solar["l"], solar["gf"], solar["ga"]), (4, 0, 0, 23, 1))

    def test_only_the_open_season_is_in_progress(self):
        # M2: an unplayed (cancelled) game in a closed season doesn't reopen it.
        active = self.sources["refresh"]["activeSeason"]
        for r in self.byk.values():
            self.assertEqual(bool(r.get("inProgress")), r["season"] == active and r["played"] < r["games"], (r["season"], r["name"]))
        past = [r for r in self.byk.values() if r["season"] != active and r["played"] < r["games"]]
        self.assertGreater(len(past), 300)
        self.assertEqual(sum(1 for r in past if r["rank"] == 1), 36, "first places a played < games rule would drop")

    def test_every_list_is_oldest_first(self):
        # #127: the Overview shows these lists newest first by reversing them for display, and
        # sq.best/sq.titles index postseason in this order.
        for sq in self.squads:
            seasons = [r["season"] for r in sq["seasons"]]
            self.assertEqual(seasons, sorted(set(seasons)), seasons)
            posts = sq.get("postseason", [])
            self.assertEqual([e["season"] for e in posts], sorted(e["season"] for e in posts))
            for a, b in zip(posts, posts[1:]):
                if a["season"] == b["season"]:
                    self.assertLessEqual(th.stage_rank(a["stage"]), th.stage_rank(b["stage"]), (a["season"], a["stage"], b["stage"]))
            dates = [e.get("startDate") or "" for e in sq.get("showcases", [])]
            self.assertEqual(dates, sorted(dates))

    def test_last_is_the_games_behind_form(self):
        # #128: `last` lists the played games behind `form`, in its order, read straight from the
        # archived schedule (checked here against the schedule itself, game by game).
        games = functools.lru_cache(maxsize=None)(th.archived_games)
        level_placeholders = 0
        for r in self.byk.values():
            if not r["played"]:
                self.assertNotIn("last", r, "no key before a first result (the page shows plain chips)")
                self.assertEqual(r["form"], "")
                continue
            last = r["last"]
            self.assertEqual(len(last), len(r["form"]), (r["season"], r["teamID"]))
            self.assertEqual(len(last), min(5, r["played"]))
            self.assertEqual([g["date"] for g in last], sorted(g["date"] for g in last))
            sched = games(r["eventID"], r["flightID"])
            for letter, g in zip(r["form"], last):
                # The game itself: on that date, with that opponent, the same sides and score.
                hits = [x for x in sched if (x.get("gameDate") or "")[:10] == g["date"] and r["teamID"] in (x.get("hometeamID"), x.get("awayteamID"))
                        and th.played(x) and (g["oppID"] is None or g["oppID"] in (x.get("hometeamID"), x.get("awayteamID")))]
                self.assertTrue(hits, (r["season"], r["teamID"], g["date"]))
                x = hits[0]
                home = x.get("hometeamID") == r["teamID"]
                self.assertEqual((g["gf"], g["ga"]), (x["hometeamscore"], x["awayteamscore"]) if home else (x["awayteamscore"], x["hometeamscore"]))
                # Home or away is TGS's; it is unknown only with the opponent (all three, or none).
                self.assertEqual(g["home"] is None, g["opp"] is None)
                self.assertEqual(g["home"] is None, g["oppID"] is None)
                if g["home"] is not None:
                    self.assertEqual(g["home"], home)
                    self.assertNotEqual(g["oppID"], r["teamID"])
                # M1 (review): `pk` only when a shoot-out decided a level game; TGS's 0-0 on a draw
                # is a placeholder, not a shoot-out.
                level = g["gf"] == g["ga"]
                self.assertEqual("pk" in g, level and letter in "WL", (r["season"], r["teamID"], g))
                if "pk" in g:
                    self.assertNotEqual(*g["pk"])
                    self.assertEqual(letter, "W" if g["pk"][0] > g["pk"][1] else "L")
                else:
                    self.assertEqual(letter, "W" if g["gf"] > g["ga"] else "L" if g["gf"] < g["ga"] else "D")
                if level and x.get("hometeamPKscore") is not None and x.get("hometeamPKscore") == x.get("awayteamPKscore"):
                    level_placeholders += 1
        self.assertGreater(level_placeholders, 0, "draws with TGS's 0-0 placeholder exist, and carry no pk")
        # Closed seasons: the 7 games with no opponent listed are all 2021-22 bracket games.
        unknown = [(r["season"], g["date"]) for r in self.byk.values() for g in r.get("last", []) if g["home"] is None]
        self.assertEqual(len(unknown), 7)
        self.assertEqual({s for s, _ in unknown}, {"2021-22"})

    def test_history_files_stay_small(self):
        # #128 S6: `last` grew the files 57% (gzip 40%); a later *field* must not grow them unnoticed,
        # while a new *season* must not trip the budget on its own (review SC3).
        # - Total, per archived season: 1.95 MB gzip for 7 seasons today, about 280 KB a season
        #   (a full season adds about 830 row lines with `last`). The limit, 340 KB a season, grows
        #   with each season, so only a fatter row (a new field) can cross it.
        # - Largest file: one TGS id's squads, 23.8 KB today, growing at most about 1.5 KB a season,
        #   so about five seasons out; then revisit the format rather than raise the limit.
        sizes = [th.file_bytes(tid, sqs) for tid, sqs in self.files.items()]
        seasons = len({r["season"] for r in self.byk.values()})
        self.assertLess(max(len(b) for b in sizes), 32 * 1024)
        self.assertLess(sum(len(gzip.compress(b, 9)) for b in sizes), seasons * 340 * 1024)

    def test_pos_is_tgs_order_except_the_merged_tables(self):
        # S6: the page says Pos is TGS's order except in the 11 tables TGS published in two
        # blocks (2020-21 to 2022-23), which it marks †.
        merged = {(r["season"], r["eventID"], r["flightID"]) for r in self.byk.values() if r.get("merged")}
        self.assertEqual(len(merged), 11)
        self.assertEqual({s for s, _e, _f in merged}, {"2020-21", "2021-22", "2022-23"})
        self.assertIn("one of the 11 tables (2020-21 to 2022-23)", Path(api.PUBLIC_DIR, "index.html").read_text(encoding="utf-8"))

    def test_best_champions_league_finish_and_titles(self):
        # M3: MVLA born 2004 won the 2020-21 Finals ("Flight 1", labelled Champions League Finals).
        sq = self.squad_of("2020-21", 11586)
        best = sq["postseason"][sq["best"]]
        self.assertEqual((best["season"], best["stage"], best["tier"], best["champion"]),
                         ("2020-21", "Finals", "Champions League Finals", True))
        self.assertEqual(sq["titles"], [sq["best"]])
        for sq in self.squads:
            posts = sq["postseason"]
            champs = [i for i, e in enumerate(posts) if e["champion"]]
            self.assertEqual(sorted(sq.get("titles", [])), champs)
            if any(th.tier_rank(posts[i]["tier"]) == 4 for i in champs):
                self.assertTrue(posts[sq["best"]]["champion"], sq["clubName"])
            if "best" in sq:
                self.assertEqual(th.tier_rank(posts[sq["best"]]["tier"]), 4)
            ranks = [(-th.tier_rank(posts[i]["tier"]), -th.stage_rank(posts[i]["stage"])) for i in sq.get("titles", [])]
            self.assertEqual(ranks, sorted(ranks))

    def test_runner_up_only_when_the_other_team_won(self):
        # M4: the 2025-26 Showcase Cup G2011 final (flight 39389) has no result: neither side lost it.
        finals = [e for sq in self.squads for e in sq["postseason"] if e["flightID"] == 39389 and e["reached"] == "Final"]
        self.assertEqual(sorted(e["teamID"] for e in finals), sorted({e["teamID"] for e in finals}))
        self.assertEqual(len(finals), 2)
        for e in finals:
            self.assertEqual((e["champion"], e.get("final")), (False, "undecided"))
        hawks = next(e for e in self.squad_of("2025-26", 54493)["postseason"] if e["flightID"] == 34428)
        self.assertEqual(hawks.get("final"), "lost")
        for sq in self.squads:
            for e in sq["postseason"]:
                self.assertFalse(e["champion"] and e.get("final"))
        self.assertFalse(any(e["reached"] == "Round of 18" for sq in self.squads for e in sq["postseason"]))

    def test_mvla_g2011(self):
        (sq,) = self.files[55477]
        self.assertEqual(sq["birthYears"], [2011])
        self.assertEqual([(r["season"], r["teamID"], r["link"]) for r in sq["seasons"]],
                         [("2023-24", 55477, "start"), ("2024-25", 55477, "id"), ("2025-26", 55477, "id"), ("2026-27", 55477, "id")])
        self.assertEqual([(r["rank"], r["of"]) for r in sq["seasons"]], [(1, 10), (3, 10), (1, 11), (3, 12)])
        done = [r for r in sq["seasons"] if not r.get("inProgress")]
        self.assertEqual([sum(r[k] for r in done) for k in ("gp", "w", "d", "l", "gf", "ga")], [56, 47, 4, 5, 197, 29])
        self.assertEqual([(e["season"], e["reached"], e["group"] and e["group"]["pos"], e.get("fromTable", False)) for e in sq["postseason"]],
                         [("2023-24", None, 4, False), ("2024-25", None, 3, True), ("2025-26", "Round of 16", None, False)])
        self.assertEqual([e["stage"] for e in sq["showcases"]], ["San Diego Fall", "Phoenix Spring"])
        self.assertEqual(sq["postseason"][sq["best"]]["reached"], "Round of 16")

    def test_a_reused_id_keeps_its_squads_apart(self):
        # CESA's GU13 id: the 2008s in 2020-21, the 2009s from 2021-22, and in 2026-27 the
        # id stayed in its age slot (G2009/10), so that season starts a squad of its own (M6).
        self.assertEqual([sq["birthYears"] for sq in self.files[46817]], [[2008], [2009], [2009, 2010]])
        self.assertIn(46817, [p["teamID"] for p in self.files[46817][2]["maybePrev"]])

    def test_a_squad_new_in_the_regroup_has_two_birth_years(self):
        # S2: "born 2010/11" for a squad that starts in a two-year group.
        (sq,) = [sq for sq in self.files[134153] if sq["seasons"][0]["season"] == th.REGROUP]
        self.assertEqual(sq["birthYears"], [2010, 2011])

    # ---------- (f) ----------

    def test_only_team_level_fields(self):
        for sq in self.squads:
            self.assertLessEqual(set(sq), SQUAD_KEYS)
            for r in sq["seasons"]:
                self.assertLessEqual(set(r), SEASON_KEYS)
                for g in r.get("last", []):
                    self.assertLessEqual(set(g), LAST_KEYS)
                    self.assertLessEqual({"date", "home", "opp", "oppID", "gf", "ga"}, set(g))
            for e in sq["postseason"] + sq["showcases"]:
                self.assertLessEqual(set(e), EVENT_KEYS)
                self.assertLessEqual(set(e.get("group") or {}), {"name", "pos", "of"})
            for m in sq.get("maybe", []) + sq.get("maybePrev", []):
                self.assertLessEqual(REF_KEYS, set(m))
                self.assertLessEqual(set(m), REF_KEYS | {"alsoClaimedBy"})
                for x in m.get("alsoClaimedBy", []):
                    self.assertEqual(set(x), {"season", "teamID", "name"})


class Overrides(unittest.TestCase):
    """S1: team-links.json, validated by the builder."""

    @classmethod
    def setUpClass(cls):
        cls.rows = built()[2]

    def test_a_manual_link_joins_across_the_regroup(self):
        nxt, maybe, errors = links_of(self.rows, {"link": [{"from": "2025-26/54493", "to": "2026-27/134153", "note": "test"}]})
        self.assertEqual(errors, [])
        self.assertEqual(nxt[("2025-26", 54493)], (("2026-27", 134153), "manual"))
        self.assertNotIn(("2025-26", 54493), maybe)

    def test_a_bad_entry_fails_and_changes_nothing(self):
        want = links_of(self.rows)[:2]
        bad = [
            ({"from": "2025-26/54493", "to": "2026-27/134153"}, "needs a 'note'"),
            ({"from": "2024-25/54493", "to": "2026-27/134153", "note": "x"}, "season after"),
            ({"from": "2025-26/54493", "to": "2026-27/999999999", "note": "x"}, "not in any conference table"),
            ({"from": "2025-26/54493", "to": "2026-27/55477", "note": "x"}, "by its TGS id"),   # MVLA's, by id
            ({"from": "2024-25/54493", "to": "2025-26/64467", "note": "x"}, "does not age"),    # G2011 -> G2012
            ({"from": "54493", "to": "2026-27/134153", "note": "x"}, "SEASON/TEAMID"),
        ]
        for entry, why in bad:
            with self.subTest(why=why):
                nxt, maybe, errors = links_of(self.rows, {"link": [entry]})
                self.assertEqual(len(errors), 1)
                self.assertIn(why, errors[0])
                self.assertEqual((nxt, maybe), want)

    def test_a_double_claim_applies_neither(self):
        want = links_of(self.rows)[:2]
        two = {"link": [{"from": "2025-26/54493", "to": "2026-27/134153", "note": "a"},
                        {"from": "2025-26/79687", "to": "2026-27/134153", "note": "b"}]}
        nxt, maybe, errors = links_of(self.rows, two)
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("more than one link entry" in e for e in errors))
        self.assertEqual((nxt, maybe), want)

    def test_unlink_splits_a_squad(self):
        nxt, _maybe, errors = links_of(self.rows, {"unlink": [{"from": "2024-25/55477", "to": "2025-26/55477", "note": "test"}]})
        self.assertEqual(errors, [])
        self.assertNotIn(("2024-25", 55477), nxt)
        self.assertEqual(nxt[("2025-26", 55477)][0], ("2026-27", 55477))

    def test_swapped_sister_sides_can_be_relinked(self):
        # The id rule would follow each id; two manual links re-point both (the Sting pattern).
        a, b = ("2023-24", 55477), ("2023-24", 54493)
        manual = {"link": [{"from": "2023-24/55477", "to": "2024-25/54493", "note": "swap test"},
                           {"from": "2023-24/54493", "to": "2024-25/55477", "note": "swap test"}]}
        nxt, _maybe, errors = links_of(self.rows, manual)
        self.assertEqual(errors, [])
        self.assertEqual((nxt[a], nxt[b]), ((("2024-25", 54493), "manual"), (("2024-25", 55477), "manual")))

    def test_an_unreadable_file_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "team-links.json")
            Path(p).write_text("{not json", encoding="utf-8")
            manual, errors = th.load_links(p)
        self.assertEqual(manual, {})
        self.assertIn("unreadable", errors[0])

    def test_the_committed_file_is_valid(self):
        manual, errors = th.load_links()
        self.assertEqual(errors, [])
        self.assertEqual(th.validate_links(manual, self.rows)[2], [])


class Writing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.out = os.path.join(self.tmp, "history")
        seed_history(self.out)

    def snapshot(self):
        return {n: Path(self.out, n).read_bytes() for n in sorted(os.listdir(self.out))}

    def test_a_second_build_writes_nothing(self):
        before = self.snapshot()
        self.assertEqual(th.write_history(out_dir=self.out)[:2], (0, 0))
        self.assertEqual(self.snapshot(), before)

    def test_a_failure_while_writing_leaves_every_file_as_it_was(self):
        # Three files changed (and one stale file); the second write fails: nothing moves.
        for n in ("55477.json", "54493.json", "46817.json"):
            Path(self.out, n).write_text('{"schema":1,"teamID":0,"squads":[]}\n', encoding="utf-8")
        Path(self.out, "1.json").write_text("{}", encoding="utf-8")
        before = self.snapshot()
        calls = []

        def flaky(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise OSError("disk full (fixture)")
            return real(path, data)
        real = th._write_tmp
        with patch.object(th, "_write_tmp", side_effect=flaky):
            with self.assertRaises(OSError):
                th.write_history(out_dir=self.out)
        self.assertEqual(self.snapshot(), before, "no file replaced, no .tmp left, nothing removed")
        self.assertEqual(th.write_history(out_dir=self.out)[:2], (3, 1))
        self.assertEqual(th.check_history(out_dir=self.out), ([], []))

    def test_a_failed_move_puts_back_the_files_already_replaced(self):
        # Review: os.replace failing on the 3rd of 4 changed files. The 2 already replaced are
        # restored, the new file that had no predecessor is removed, and no .tmp is left.
        for n in ("55477.json", "54493.json", "46817.json"):
            Path(self.out, n).write_text('{"schema":1,"teamID":0,"squads":[]}\n', encoding="utf-8")
        Path(self.out, "11586.json").unlink()
        before = self.snapshot()
        real, calls = th._move, []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 3:
                raise OSError("rename refused (fixture)")
            return real(src, dst)
        with patch.object(th, "_move", side_effect=flaky):
            with self.assertRaisesRegex(OSError, "rename refused"):
                th.write_history(out_dir=self.out)
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.snapshot(), before, "every file as it was, and no .tmp left")

    def test_a_restore_that_fails_says_so(self):
        Path(self.out, "55477.json").write_text("{}", encoding="utf-8")
        Path(self.out, "54493.json").write_text("{}", encoding="utf-8")
        real, calls = th._move, []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 2:
                raise OSError("rename refused (fixture)")
            return real(src, dst)
        real_replace = os.replace

        def no_restore(src, dst):
            if src.endswith(".bak.tmp"):
                raise OSError("restore refused (fixture)")
            return real_replace(src, dst)
        with patch.object(th, "_move", side_effect=flaky), patch.object(th.os, "replace", side_effect=no_restore):
            with self.assertRaisesRegex(th.PartialWrite, r"1 could not be put back \(54493\.json\)"):
                th.write_history(out_dir=self.out)
        self.assertFalse([n for n in os.listdir(self.out) if n.endswith(".tmp")])

    def test_the_check_compares_bytes_but_not_line_endings(self):
        # Review: a reformatted file fails the drift check; a CRLF checkout of the same bytes doesn't.
        p = Path(self.out, "55477.json")
        data = p.read_bytes().replace(b"\r\n", b"\n")
        p.write_bytes(data.replace(b"\n", b"\r\n"))
        self.assertEqual(th.check_history(out_dir=self.out), ([], []))
        p.write_text(json.dumps(json.loads(data), indent=1), encoding="utf-8")
        self.assertEqual(th.check_history(out_dir=self.out), (["55477.json"], []))

    def test_a_build_that_would_remove_many_files_refuses(self):
        for i in range(1, 121):
            Path(self.out, f"{900000000 + i}.json").write_text("{}", encoding="utf-8")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "would remove 120 of the history files"):
            th.write_history(out_dir=self.out)
        self.assertEqual(self.snapshot(), before)

    def test_a_dry_run_writes_nothing(self):
        Path(self.out, "55477.json").unlink()
        before = self.snapshot()
        self.assertEqual(th.write_history(out_dir=self.out, dry_run=True)[:2], (1, 0))
        self.assertEqual(self.snapshot(), before)


class Refresh(unittest.TestCase):
    """The refresh keeps the histories current in the same run (#107), and survives a failure."""

    ACTIVE = "2026-27"

    def setUp(self):
        self.sources = api.load_sources()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.hist = os.path.join(self.tmp, "history")
        seed_history(self.hist)
        self.state = os.path.join(self.tmp, "refresh-state.json")
        shutil.copy(api.REFRESH_STATE_PATH, self.state)
        self.index = os.path.join(self.tmp, f"{self.ACTIVE}.json")
        shutil.copy(api.team_index_path(self.ACTIVE), self.index)

    def snapshot(self):
        return {n: Path(self.hist, n).read_bytes() for n in sorted(os.listdir(self.hist))}

    def refresh(self, answer, **extra):
        """cmd_refresh on a sweep, with upstream answered by `answer(path)` (bytes) and every
        write kept in memory or under the temporary directory."""
        overlay = {}
        read = api.read_archive
        index_path = api.team_index_path

        def reader(path):
            return (overlay[path], "2026-09-30T00:00:00Z") if path in overlay else read(path)

        def writer(path, raw, allow_protected=False):
            overlay[path] = raw
        patches = [
            patch.object(api, "read_archive", side_effect=reader),
            patch.object(api, "write_archive", side_effect=writer),
            patch.object(api, "fetch_api_raw", side_effect=answer),
            patch.object(api, "team_index_path", side_effect=lambda s: self.index if s == self.ACTIVE else index_path(s)),
            patch.object(api, "ARCHIVE_DIR", self.tmp),
            patch.object(api, "REFRESH_STATE_PATH", self.state),
            patch.object(api, "MATCH_DAYS_PATH", os.path.join(self.tmp, "match-days.json")),
            patch.object(th, "HISTORY_DIR", self.hist),
            patch.object(archive, "DELAY", 0),
            patch.object(archive, "export_flight_csv"),
            patch.object(archive, "refresh_club_places"),
        ] + [patch.object(*p) for p in extra.get("more", [])]
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            args = argparse.Namespace(date="2026-10-01", at_hour=7, sweep=True, dry_run=False, force=True)
            code = archive.cmd_refresh(self.sources, args)
        return code, out.getvalue(), overlay

    def test_a_refresh_touching_one_flight_rebuilds_exactly_its_teams_files(self):
        # NorCal GU16 (MVLA's 2026-27 flight): one unplayed game gets a 2-1 result, and the
        # standings rows of its two teams change. Upstream answers everything else unchanged.
        mvla = api.read_json_file(self.index)
        row = next(t for t in mvla["teams"] if t["teamID"] == 55477)
        sched_path = api.p_schedule(row["eventID"], row["flightID"])
        stand_path = api.p_standings(row["divisionID"], row["flightID"], row["eventID"])
        games = json.loads(api.read_archive(sched_path)[0])
        g = next(g for g in games["data"] if g.get("hometeamscore") is None and g.get("hometeamID") and g.get("awayteamID"))
        home, away = g["hometeamID"], g["awayteamID"]
        g["hometeamscore"], g["awayteamscore"] = 2, 1
        table = json.loads(api.read_archive(stand_path)[0])
        for t in (table["data"] if isinstance(table["data"], list) else [table["data"]])[0]["teamStandings"]:
            if t["teamID"] in (home, away):
                won = t["teamID"] == home
                t["gp"] += 1
                t["wins" if won else "losses"] += 1
                t["standingpoints"] += 3 if won else 0
                t["goalsfor"] += 2 if won else 1
                t["goalsagainst"] += 1 if won else 2
                t["goaldifferential"] += 1 if won else -1
        changed = {sched_path: json.dumps(games).encode(), stand_path: json.dumps(table).encode()}
        read = api.read_archive

        def answer(path):
            if path in changed:
                return changed[path]
            raw = read(path)[0]
            if raw is None:
                raise api.ApiError(f"not archived: {path}")
            return raw
        before = self.snapshot()
        squads = built()[0]
        want = sorted({f"{r['teamID']}.json" for sq in squads if any(r["season"] == self.ACTIVE and r["teamID"] in (home, away) for r in sq["seasons"])
                       for r in sq["seasons"]})
        code, out, overlay = self.refresh(answer)
        self.assertEqual(code, 0, out)
        self.assertIn(stand_path, overlay)
        after = self.snapshot()
        self.assertEqual(sorted(n for n in after if after[n] != before.get(n)), want)
        self.assertIn(f"{home}.json", want)
        self.assertIn(f"{away}.json", want)
        state = api.read_json_file(self.state)
        self.assertEqual(state["historyAsOf"], state["updatedAt"])
        mine = json.loads(after[f"{home}.json"])
        r = next(r for sq in mine["squads"] for r in sq["seasons"] if r["season"] == self.ACTIVE and r["teamID"] == home)
        self.assertEqual(r["form"][-1], "W")

    def test_a_failed_history_build_keeps_the_files_and_fails_the_run(self):
        read = api.read_archive

        def answer(path):
            raw = read(path)[0]
            if raw is None:
                raise api.ApiError(f"not archived: {path}")
            return raw
        old = api.read_json_file(self.state)
        before = self.snapshot()
        code, out, _ = self.refresh(answer, more=[(th, "national_and_showcases", unittest.mock.Mock(side_effect=RuntimeError("history fixture fault")))])
        self.assertEqual(code, 1)
        self.assertIn("Team history: FAILED: history fixture fault", out)
        self.assertEqual(self.snapshot(), before)
        state = api.read_json_file(self.state)
        self.assertNotEqual(state["updatedAt"], old["updatedAt"], "the season data is still saved")
        self.assertEqual(state.get("historyAsOf"), old.get("historyAsOf"), "the page can say how old the history is")

    def test_dry_runs_never_build_the_history(self):
        for date, hour in (("2026-08-20", 0), ("2026-09-26", 7)):
            with self.subTest(date=date), \
                    patch.object(archive, "fetch_json", side_effect=AssertionError("dry run fetched")), \
                    patch.object(th, "write_history", side_effect=AssertionError("dry run built the history")), \
                    contextlib.redirect_stdout(io.StringIO()):
                args = argparse.Namespace(date=date, at_hour=hour, sweep=False, dry_run=True, force=True)
                self.assertEqual(archive.cmd_refresh(self.sources, args), 0)


if __name__ == "__main__":
    unittest.main()
