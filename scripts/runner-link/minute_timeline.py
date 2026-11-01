# Per-minute timeline of one load-test run (task C2b, coordinator 2026-10-31 points 3 and 5): link-token responses by
# status (the web gateway's access log), the link gateway's heartbeat `lost` retries and `cancelled` calls (metrics.prom,
# restart-aware: a counter that goes down is a new process starting from 0), the apiservers' slow requests
# (SlowRequestInterceptor), and the database container's memory (samples.jsonl). Optional kill marks.
#
#   python3 -I minute_timeline.py <run dir> [--mark HH:MM:SS=label ...] [--from HH:MM --to HH:MM] [--json out.json]
import json, re, sys, collections, datetime

args = sys.argv[1:]
run = args.pop(0)
marks, json_out, frm, to = {}, None, None, None
while args:
    a = args.pop(0)
    if a == '--mark':
        t, label = args.pop(0).split('=', 1)
        marks[t[:5]] = marks.get(t[:5], '') + (' ' if t[:5] in marks else '') + f'{label}@{t}'
    elif a == '--json': json_out = args.pop(0)
    elif a == '--from': frm = args.pop(0)
    elif a == '--to': to = args.pop(0)

minute = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%H:%M')
rows = collections.defaultdict(lambda: collections.Counter())

# 1. link-token responses through the web gateway, by minute and status.
nginx_ts = re.compile(r'\[(\d{2})/(\w{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) [+-]\d{4}\] "POST /api/runner/link-token[^"]*" (\d{3}) ')
for line in open(f'{run}/logs/gateway.log', errors='replace'):
    m = nginx_ts.search(line)
    if m: rows[f'{m.group(4)}:{m.group(5)}'][f'token_{m.group(7)}'] += 1

# 2. heartbeat lost retries and cancelled calls, from the 15 s scrapes, restart-aware.
want = {'link_backend_retries_total{kind="heartbeat",reason="lost"}': 'hb_lost',
        'link_backend_retries_total{kind="heartbeat",reason="not_delivered"}': 'hb_not_delivered',
        'link_backend_calls_total{kind="heartbeat",result="cancelled"}': 'hb_cancelled',
        'link_backend_calls_total{kind="welcome",result="timeout"}': 'welcome_timeout',
        'link_backend_retries_total{kind="welcome",reason="lost"}': 'welcome_lost',
        'link_backend_retries_total{kind="events_merged",reason="lost"}': 'merged_lost'}
prev, cur, t, seen = {}, {}, None, False
def flush():
    # The first scrape is the baseline. After it, a series that is absent counts as 0: the unset counters appear only
    # once non-zero, and a restarted process starts every one of them again from nothing.
    global seen
    if t is None: return
    for k, label in want.items():
        v = cur.get(k, 0.0)
        if seen:
            p = prev.get(k, 0.0)
            d = v if v < p else v - p   # a drop is a restarted process counting from 0
            if d > 0: rows[minute(t)][label] += int(d)
        prev[k] = v
    seen = True
for line in open(f'{run}/metrics.prom'):
    if line.startswith('# scrape '):
        flush(); cur = {}; t = int(line.split()[2]); continue
    if line.startswith('#') or not line.strip(): continue
    k, _, v = line.rstrip('\n').rpartition(' ')
    if k in want:
        try: cur[k] = float(v)
        except ValueError: pass
flush()

# 3. slow requests on every apiserver, by minute, with the worst one.
nest = re.compile(r'(\d{1,2})/(\d{1,2})/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)\s+WARN \[SlowRequestInterceptor\] (\S+) (\S+) (\d+)ms')
import glob, os
slow_max = collections.defaultdict(lambda: (0, ''))
for f in glob.glob(f'{run}/logs/apiserver*.log'):
    svc = os.path.basename(f)[:-4]
    for line in open(f, errors='replace'):
        m = nest.search(re.sub(r'\x1b\[[0-9;]*m', '', line))
        if not m: continue
        h = int(m.group(4)) % 12 + (12 if m.group(7) == 'PM' else 0)
        k = f'{h:02d}:{m.group(5)}'
        rows[k]['slow'] += 1
        ms = int(m.group(10))
        if ms > slow_max[k][0]: slow_max[k] = (ms, f'{svc} {m.group(8)} {m.group(9).split("?")[0]} {ms}ms')

# 4. the database container's memory at the end of each minute.
pg_mem = {}
for line in open(f'{run}/samples.jsonl'):
    try: s = json.loads(line)
    except ValueError: continue
    if 'postgres' in s: pg_mem[minute(s['t'])] = s['postgres']['memBytes'] / 1048576

keys = sorted(set(rows) | set(pg_mem))
if frm: keys = [k for k in keys if k >= frm]
if to: keys = [k for k in keys if k <= to]
cols = ['token_200', 'token_502', 'token_499', 'token_other', 'hb_lost', 'hb_cancelled', 'welcome_timeout', 'merged_lost', 'slow']
out = []
print('| UTC | link-token 200 | 502 | 499 | other | hb lost | hb cancelled | welcome timeout | merged lost | slow requests (worst) | DB MiB | mark |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for k in keys:
    r = rows[k]
    other = sum(v for c, v in r.items() if c.startswith('token_') and c not in ('token_200', 'token_502', 'token_499'))
    worst = slow_max[k][1] if k in slow_max else ''
    rec = {'minute': k, **{c: r.get(c, 0) for c in cols if c != 'token_other'}, 'token_other': other,
           'slowWorst': worst, 'dbMiB': round(pg_mem.get(k, 0)), 'mark': marks.get(k, '')}
    out.append(rec)
    print(f"| {k} | {r.get('token_200', 0)} | {r.get('token_502', 0)} | {r.get('token_499', 0)} | {other} | {r.get('hb_lost', 0)} | "
          f"{r.get('hb_cancelled', 0)} | {r.get('welcome_timeout', 0)} | {r.get('merged_lost', 0)} | {r.get('slow', 0)}{(' (' + worst + ')') if worst else ''} | "
          f"{round(pg_mem.get(k, 0))} | {marks.get(k, '')} |")
tot = collections.Counter()
for r in out:
    for c in cols: tot[c] += r.get(c, 0)
print(f"\ntotals: {dict(tot)}")
if json_out: json.dump(out, open(json_out, 'w'), indent=1)
