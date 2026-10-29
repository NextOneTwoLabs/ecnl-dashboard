"""#203: compares, per variant, the red or skipped tests of the old tests and of the new tests run on the same data.

    python tools/variants/subset.py <logdir> <variant>...

<logdir> holds the logs written by `variants.py run`, named <variant>-old-node.txt, <variant>-new-node.txt, <variant>-old-py.txt and
<variant>-new-py.txt. For each variant it prints the red and skipped test names of both, and checks that the new list is a subset of the
old one and that a test which is new (its name is not in the old run) is green. A name that exists only in some runs because of the
catalog (a per-season test) is in both the old and the new run and is not mistaken for a new test. Exit status 1 when a check fails.
Reads the logs only; writes nothing."""
import re, sys, os
def node(path):
    bad, allv, skip = set(), set(), set()
    for l in open(path, encoding='utf-8', errors='replace'):
        m = re.match(r'^(not )?ok \d+ - (.*?)( # SKIP.*)?\s*$', l)
        if not m or m.group(2).endswith('.mjs'): continue
        n = m.group(2); allv.add(n)
        if m.group(1): bad.add(n)
        elif m.group(3): bad.add(n); skip.add(n)
    return bad, allv, skip
def py(path):
    bad, allv, skip, cur = set(), set(), set(), None
    for l in open(path, encoding='utf-8', errors='replace'):
        m = re.match(r'^(test\w*) \(([\w.]+)\)', l)
        if m: cur = m.group(2); allv.add(cur)
        m = re.match(r'^(FAIL|ERROR): (\w+) \(([\w.]+)\)', l)
        if m: bad.add(m.group(3))
        if cur and re.search(r"\.\.\. skipped '", l): bad.add(cur); skip.add(cur)
    return bad, allv, skip
if len(sys.argv) < 3:
    raise SystemExit(__doc__)
S = sys.argv[1]
ok = True
for v in sys.argv[2:]:
    print(f'=== {v}')
    for kind, fn, tail in (('Node', node, 'node'), ('Python', py, 'py')):
        fo, fn_ = f'{S}/{v}-old-{tail}.txt', f'{S}/{v}-new-{tail}.txt'
        if not (os.path.exists(fo) and os.path.exists(fn_)): print(f'  {kind}: (no old run)'); continue
        ob, oa, os_ = fn(fo); nb, na, ns = fn(fn_)
        new_only = na - oa
        extra = nb - ob                       # red/skipped now, not before
        bad_new_only = new_only & nb
        good = (not extra) and (not bad_new_only)
        ok &= good
        print(f'  {kind}: old {len(ob)} red/skipped ({len(os_)} skipped), new {len(nb)} ({len(ns)} skipped); new-only tests {len(new_only)}; subset: {"YES" if good else "NO"}')
        if extra: print('    NEW red/skipped not in old:', sorted(extra))
        if bad_new_only: print('    NEW tests that are red/skipped:', sorted(bad_new_only))
        fixed = ob - nb
        print(f'    fixed (red/skipped in old, green in new): {len(fixed)}')
        for n in sorted(fixed): print('      -', n[:120])
        left = sorted(nb)
        if left:
            print(f'    still red/skipped in new ({len(left)}):')
            for n in left: print('      *', n[:120])
        if new_only: print('    tests new in this PR:', sorted(new_only))
print('SUBSET CHECK:', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
