"""#203: the rollover variant, `rollover3`. Run on a COPY of the checkout that sim_games.mjs has already taken to the end of the season.

    python tools/variants/sim_rollover.py <copy-dir>

2027-28 is a relabelled, unplayed copy of the active season's conference events (new event, division, flight and match ids, no scores,
every standing at 0, dates a year on), registered in sources.json through the copy's own archive.save_sources; activeSeason moves to
2027-28; the age groups move up one (the oldest cohort ages out). The repo's builders (--team-index, --team-history, --search-data)
are run afterwards by variants.py. <copy-dir> must be outside this checkout: the script refuses this checkout's root and any path inside it.
"""
import json, os, re, shutil, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    raise SystemExit(__doc__)
_dir = Path(sys.argv[1]).resolve()
if _dir == REPO or REPO in _dir.parents:
    raise SystemExit(f"refusing {_dir}: it is this checkout (or inside it); pass a copy outside the repo")
if not (_dir / 'public/data/sources.json').exists():
    raise SystemExit(f"{_dir} has no public/data/sources.json: it is not a copy of the checkout")
root = str(_dir); A = root + '/public/archive/'; EV = A + 'api/Event/'
SP = root + '/public/data/sources.json'
raw = open(SP, encoding='utf-8').read(); s = json.loads(raw)
fmt = lambda o: json.dumps(o, indent=2, ensure_ascii=False) + '\n'
os.chdir(root); sys.path.insert(0, root)
old = s['refresh']['activeSeason']; new = '2027-28'; OFF = 100000
conf = s['seasons'][old]['conferences']; ids = {c['eventId']: c['eventId'] + OFF for c in conf.values()}
ZERO = {'wins','losses','draws','gp','totalgames','standingpoints','goalsfor','goalsagainst','goaldifferential','ppg','winpercent','win','loss','draw','point'}
def year(sv): return str(int(sv[:4]) + 1) + sv[4:] if isinstance(sv, str) and re.match(r'^20\d\d-', sv) else sv
def walk(o, e, n):
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if k in ('eventID', 'eventId') and v == e: o[k] = n
            elif k == 'gameDate' or k.endswith('Date'): o[k] = year(v)
            elif k in ('division', 'divisionName') and v in MAP: o[k] = MAP[v]
            elif k in ('flightID', 'divisionID') and isinstance(v, int): o[k] = v + OFF
            elif k in ('matchID', 'gameID') and isinstance(v, int): o[k] = v + 10_000_000
            elif k in ('hometeamscore', 'awayteamscore', 'hometeamPKscore', 'awayteamPKscore'): o[k] = None
            elif k in ZERO and isinstance(v, (int, float)) and not isinstance(v, bool): o[k] = 0
            else: walk(v, e, n)
    elif isinstance(o, list):
        for x in o: walk(x, e, n)
MAP = {'GU13': 'GU14', 'GU14': 'GU15', 'GU15': 'GU16', 'GU16': 'GU17', 'GU17': 'GU18/19'}
AGED = set()   # divisionIDs of the oldest cohort: they age out
for e in ids:
    f = EV + 'get-event-schedule-or-standings/%d.json' % e
    for d in json.load(open(f))['data'].get('girlsDivAndFlightList', []):
        if d['divisionName'] == 'GU18/19': AGED.add(d['divisionID'])
AGEDF = set()
for e in ids:
    for d in json.load(open(EV + 'get-event-schedule-or-standings/%d.json' % e))['data'].get('girlsDivAndFlightList', []):
        if d['divisionID'] in AGED: AGEDF |= {x['flightID'] for x in d['flightList']}
made = 0
ROLES = {'get-schedules-by-flight': 'ef0', 'get-standings-by-div-and-flight': 'dfe', 'get-event-schedule-or-standings': 'e',
         'get-event-details-by-eventID': 'e', 'get-brackets-design-by-eventID-and-flightID': 'ef', 'get-flight-brackets-by-flight': 'f'}
def remap(rel):
    ep, _, rest = rel.partition('/'); role = ROLES.get(ep)
    if not role: return None
    parts = rest[:-5].split('/') if rest.endswith('.json') else None
    if parts is None or len(parts) != len(role.rstrip('0')) + (1 if role.endswith('0') else 0): return None
    out = []; ev = None
    for r, x in zip(role, parts):
        if not x.isdigit(): out.append(x); continue
        v = int(x)
        if r == 'e': ev = v; out.append(str(ids.get(v, v)))
        elif r in 'df': out.append(str(v + OFF))
        else: out.append(x)
    return ep + '/' + '/'.join(out) + '.json', ev
for dp, dn, fn in list(os.walk(EV)):
    for f in fn:
        p = os.path.join(dp, f); rel = p[len(EV):]
        # find the event id first (role 'e' segment), then keep only our events
        ep, _, rest = rel.partition('/'); role = ROLES.get(ep)
        if not role or not rest.endswith('.json'): continue
        segs = rest[:-5].split('/')
        ev = next((int(x) for r, x in zip(role, segs) if r == 'e' and x.isdigit()), None)
        if ev not in ids: continue
        m = remap(rel)
        if not m: continue
        if ep == 'get-standings-by-div-and-flight' and int(segs[0]) in AGED: continue
        if ep == 'get-schedules-by-flight' and int(segs[1]) in AGEDF: continue
        q = EV + m[0]; os.makedirs(os.path.dirname(q), exist_ok=True)
        j = json.load(open(p, encoding='utf-8'))
        if isinstance(j.get('data'), dict) and 'girlsDivAndFlightList' in j['data']: j['data']['girlsDivAndFlightList'] = [d for d in j['data']['girlsDivAndFlightList'] if d['divisionID'] not in AGED]
        walk(j, ev, ids[ev])
        open(q, 'w', encoding='utf-8').write(json.dumps(j, ensure_ascii=False)); made += 1
entry = json.loads(json.dumps(s['seasons'][old])); entry.pop('teamCount', None); entry['startYear'] = int(new[:4]); entry.pop('_note', None)
entry['national'] = {}
entry['ageGroups'] = {MAP[k]: dict(v, u=v['u'] + (1 if k != 'GU17' else 1)) for k, v in entry['ageGroups'].items() if k in MAP}
for c in entry['conferences'].values(): c['eventId'] += OFF; c['eventName'] = c['eventName'].replace(old, new)
s['seasons'][new] = {'startYear': entry.pop('startYear'), **entry}
s['refresh']['activeSeason'] = new
import archive; archive.save_sources(s)
print('rollover2: files', made, 'events', len(ids), old, '->', new)
