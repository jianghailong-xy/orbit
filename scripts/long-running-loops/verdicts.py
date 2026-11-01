#!/usr/bin/env python3
"""What a drill.py dump shows, checked: every claim of the long-running-loop acceptance read off the dump's own files.

Usage: verdicts.py DUMP   writes DUMP/verdicts.json and DUMP/summary.md, prints the checks; exit 1 when one fails.
DUMP is drill.py dump's directory, or docs/evidence/long-running-loops (its files at the top and in raw/).
Reads only the dump (drill.py dump OUT): the loops' tick rows joined to their turns, the turns, the stall wakes, the push
recorder's file, the samples, the timeline, the observer's session_get results and fake-model.py's log.
"""

import calendar
import json
import math
import re
import sys
from pathlib import Path

DUMP = Path(sys.argv[1]) if len(sys.argv) > 1 else None
checks = []


def check(name, ok, detail):
    checks.append({'check': name, 'ok': bool(ok), 'detail': detail})


def load(name, default=None):
    """A file of the dump, at its top or in raw/ (the layout docs/evidence/long-running-loops keeps)."""
    path = DUMP / name if (DUMP / name).exists() else DUMP / 'raw' / name
    if not path.exists():
        return default
    text = path.read_text()
    if name.endswith('.jsonl'):
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return json.loads(text) if text.strip() else default


def epoch(value):
    hit = re.fullmatch(r'(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?', value)
    base = calendar.timegm(tuple(int(x) for x in re.split('[-T:]', f'{hit[1]}T{hit[2]}')) + (0, 0, 0)) + (float(hit[3]) if hit[3] else 0)
    zone = hit[4]
    if zone and zone != 'Z':
        digits = zone[1:].replace(':', '')
        base += (-1 if zone[0] == '+' else 1) * (int(digits[:2]) * 3600 + int(digits[2:4] or 0) * 60)
    return base


def iso(seconds):
    import time
    return time.strftime('%H:%M:%S', time.gmtime(seconds)) + f'.{int(seconds % 1 * 1000):03d}Z'


def tick_number(row):
    return math.ceil(round(epoch(row['due_at']) - epoch(row['first_due_at']), 3) / row['every_seconds']) + 1


def window_of(due, outage):
    if outage and outage[0] <= due < outage[1]:
        return 'runner down'
    if outage and due >= outage[1]:
        return 'after'
    return 'before'


def tick_report(rows, outage, label):
    """The table, and which slots outside the outage had a turn of their own."""
    lines = [f'| tick | due_at | state | turn | delivered_at | delivered − due | window |',
             '| ---: | --- | --- | ---: | --- | ---: | --- |']
    turns_seen = {}
    for row in rows:
        if row['turn_seq'] is not None:
            turns_seen.setdefault(row['turn_seq'], []).append(tick_number(row))
    own = []
    for row in rows:
        due = epoch(row['due_at'])
        late = epoch(row['delivered_at']) - due if row['delivered_at'] else None
        window = window_of(due, outage)
        shared = row['turn_seq'] is not None and len(turns_seen[row['turn_seq']]) > 1
        lines.append(f"| {tick_number(row)} | {iso(due)} | {row['state']} | {row['turn_seq'] if row['turn_seq'] is not None else '—'}"
                     f"{' (shared)' if shared else ''} | {iso(epoch(row['delivered_at'])) if row['delivered_at'] else '—'} | "
                     f"{f'{late:.1f} s' if late is not None else '—'} | {window} |")
        own.append({'tick': tick_number(row), 'due': due, 'state': row['state'], 'turn': row['turn_seq'], 'late': late,
                    'window': window, 'shared': shared})
    return '\n'.join(lines), own


def main():
    state = load('state-public.json', {})
    timeline = state.get('timeline') or {}
    sessions = state.get('sessions') or {}
    loops = state.get('loops') or {}
    summary = []
    pushes = [p for p in load('push-calls.jsonl', []) if p.get('method')]
    samples = load('samples.jsonl', [])

    # ---- loop A: the two-hour loop, its runner killed while the session was idle ----
    a_rows = load('ticks-a.json', [])
    a_kill = epoch(timeline['a.kill']['killedAt']) if 'a.kill' in timeline else None
    a_back = epoch(timeline['a.restart']['restartedAt']) if 'a.restart' in timeline else None
    a_stop = epoch(timeline['a.stop']['sent']['sentAt']) if 'a.stop' in timeline else None
    table, own = tick_report(a_rows, (a_kill, a_back) if a_kill else None, 'A')
    summary += ['## Loop A ticks', '', table, '']
    before_stop = [t for t in own if a_stop is None or t['due'] < a_stop]
    outside = [t for t in before_stop if t['window'] != 'runner down']
    check('A: every slot outside the outage became a turn of its own, handed to the engine within 60 s of its due time',
          outside and all(t['state'] == 'DELIVERED' and t['turn'] is not None and not t['shared'] and t['late'] is not None
                          and t['late'] < 60 for t in outside),
          [{k: t[k] for k in ('tick', 'state', 'turn', 'late', 'shared')} for t in outside if not (
              t['state'] == 'DELIVERED' and t['turn'] is not None and not t['shared'] and t['late'] is not None and t['late'] < 60)]
          or f'{len(outside)} slots')
    down = [t for t in before_stop if t['window'] == 'runner down']
    check('A: the slots while runner a was down were folded into one queued turn, handed over once it was back',
          down and len({t['turn'] for t in down}) == 1 and all(t['late'] is not None and t['due'] + t['late'] >= a_back for t in down),
          [{k: t[k] for k in ('tick', 'state', 'turn', 'late')} for t in down])
    after = [t for t in before_stop if t['window'] == 'after']
    if after and a_back:
        first = after[0]
        check('A: the first slot after the restart fired on time, as a turn of its own',
              first['state'] == 'DELIVERED' and not first['shared'] and first['late'] is not None and first['late'] < 60,
              {k: first[k] for k in ('tick', 'state', 'turn', 'late')})
    span = (a_stop - epoch(a_rows[0]['created_at'])) if a_rows and a_stop else None
    tick_turns = sorted({t['turn'] for t in before_stop if t['turn'] is not None})
    check('A: the loop ran two hours: due times and tick turns over it',
          span is not None and span >= 7200,
          {'loopCreatedToStopSeconds': round(span) if span else None, 'dueTimes': len(before_stop), 'tickTurns': len(tick_turns),
           'slotsInOutage': len(down)})
    if 'a.stop' in timeline:
        receipts = [r['text'] for r in timeline['a.stop']['receipts']]
        check('A: stop: true twice, both answered without error: the first ends the loop, the second finds nothing',
              len(receipts) == 2 and not any(r['isError'] for r in timeline['a.stop']['receipts'])
              and 'the loop has ended' in receipts[0] and receipts[1].startswith('Nothing to stop'), receipts)
        loop = timeline['a.stop']['loop']
        check('A: the loop is ENDED with reason REQUESTED', loop['state'] == 'ENDED' and loop['ended_reason'] == 'REQUESTED',
              {k: loop[k] for k in ('state', 'ended_reason', 'ended_at', 'ticks_fired', 'ticks_missed')})
    if 'a.quiet' in timeline:
        quiet = timeline['a.quiet']
        check('A: no new turn and no waiting wakeup for at least 15 minutes after the stop',
              quiet['watchedSeconds'] >= 900 and not quiet['turnsAfterStop'] and not quiet['pendingWakeups'],
              {k: quiet[k] for k in ('watchedSeconds', 'turnsAfterStop', 'pendingWakeups')})

    # ---- the two 7200-second sleep jobs ----
    for name in ('a', 'c'):
        wakes = load(f'wakes-{name}.json', [])
        stalls = [w for w in wakes if w['trigger'] == 'stall']
        start = timeline.get(f'{name}.start', {})
        job = None
        for receipt in start.get('receipts') or []:
            if receipt['name'] == 'mcp__orbit__bg_run':
                job = json.loads(receipt['text'])
        if job is None:
            continue
        started = epoch(job['startedAt'])
        detail = [{'job': w['job_id'], 'at': w['created_at'], 'afterStartSeconds': round(epoch(w['created_at']) - started, 1),
                   'elapsedMs': w['elapsed_ms'], 'idleMs': w['idle_ms'], 'status': w['status']} for w in stalls]
        check(f'{name.upper()}: the sleep job {job["jobId"]} woke its session for its silence exactly once, about 1800 s in',
              len(stalls) == 1 and stalls[0]['job_id'] == job['jobId'] and 1800 <= epoch(stalls[0]['created_at']) - started < 1900,
              detail)
        summary += [f'## Stall wakes of session {name.upper()}', '', json.dumps(detail, indent=2), '']

    # ---- session_get while runner a was down, and after ----
    for label, when in (('A1', 'down'), ('A2', 'after')):
        path = DUMP / f'session-get-{label}.txt'
        if not path.exists():
            path = DUMP / 'raw' / f'session-get-{label}.txt'
        if not path.exists():
            continue
        got = json.loads(path.read_text())
        loop = (got.get('wakeups') or {}).get('loop') or {}
        detail = {'status': got.get('status'), 'wakeups': got.get('wakeups')}
        if when == 'down' and a_kill:
            asked = epoch(timeline['c.get.a1']['observer']['sent']['sentAt'])
            due_down = [t for t in own if a_kill <= t['due'] <= asked]
            last_before = max((t for t in own if t['due'] < a_kill), key=lambda t: t['due'])
            last_turn = next(r for r in a_rows if tick_number(r) == last_before['tick'])
            missed_before = next((l['ticksMissed'] for sample in reversed(samples) if epoch(sample['at']) < a_kill
                                  for l in sample.get('loops') or [] if l['id'] == loops.get('a')), 0)
            detail['dueWhileDownSoFar'] = len(due_down)
            detail['missedBeforeTheKill'] = missed_before
            detail['minutesDownSoFar'] = round((asked - a_kill) / 60, 1)
            check('A: session_get while runner a is down: lastFiredAt is the last run before the kill; of the slots since, '
                  'the first filed the queued turn and every later one is counted missed',
                  loop.get('lastFiredAt') and abs(epoch(loop['lastFiredAt']) - epoch(last_turn['delivered_at'])) < 0.01
                  and loop.get('ticksMissed') == missed_before + len(due_down) - 1, detail)
        summary += [f'## session_get {label}', '', '```json', json.dumps(detail, indent=2), '```', '']

    # ---- the pushes ----
    loop_ids = {name: loop for name, loop in loops.items()}
    for name, loop_id in loop_ids.items():
        mine = [p for p in pushes if (p['args'][0].get('missed') or {}).get('loopId') == loop_id]
        check(f'{name.upper()}: the real PushService.notifyLoopMissed was called exactly once for its outage',
              len(mine) == 1 and mine[0]['receiver']['instanceOfPushService'], [
                  {'at': p['at'], 'reason': p['args'][0]['reason'], 'ticks': p['args'][0]['missed'].get('ticks'),
                   'receiver': p['receiver']} for p in mine])
    other = [p for p in pushes if not any((p['args'][0].get('missed') or {}).get('loopId') == l for l in loop_ids.values())]
    check('no other call of notifyLoopMissed', not other, other)

    # ---- loop B: its runner killed in a tick's turn, back after the auto-retry gave up ----
    b_rows = load('ticks-b.json', [])
    if b_rows and 'b.kill' in timeline:
        b_kill = epoch(timeline['b.kill']['killedAt'])
        b_back = epoch(timeline['b.restart']['restartedAt'])
        table_b, own_b = tick_report(b_rows, (b_kill, b_back), 'B')
        summary += ['## Loop B ticks', '', table_b, '']
        turn = timeline['b.kill']['turnAtKill']
        check('B: runner b was killed while a tick turn was with the engine',
              turn['status'] == 'IN_FLIGHT' and turn['client_turn_id'].startswith('bg-wake:wakeup:') and 5 <= turn['running_s'] <= 20, turn)
        sb = sessions['b']['uuid']
        history = []
        for sample in samples:
            for s in sample.get('sessions') or []:
                if s['id'] == sb:
                    key = (s['status'], bool(s['retryAt']), s['retryAttempts'])
                    if not history or history[-1]['key'] != key:
                        history.append({'key': key, 'at': sample['at'], 'status': s['status'], 'retryAt': s['retryAt'],
                                        'finishedAt': s['finishedAt'], 'error': s['error']})
        for h in history:
            h.pop('key')
        summary += ['## Session B status changes (samples every 10 s)', '', '```json', json.dumps(history, indent=2), '```', '']
        restart = timeline['b.restart']
        check('B: runner b came back only after the auto-retry had disarmed, past 30 minutes, with ticks refused their revive',
              restart['why'] == 'ready' and restart['downSeconds'] > 1800 and restart['refusedRevivesBeforeRestart'] >= 3,
              {k: restart[k] for k in ('why', 'disarmedAt', 'refusedRevivesBeforeRestart', 'downSeconds')})
        revived = timeline['b.revived']['turn']
        check('B: the first turn after runner b returned is the loop\'s own revive (a tick\'s bg-wake key), not the auto-retry',
              revived['client_turn_id'].startswith('bg-wake:wakeup:'), revived)
        after_b = [t for t in own_b if t['window'] == 'after' and 'b.stop' in timeline and t['due'] < epoch(timeline['b.stop']['sent']['sentAt'])]
        check('B: every slot after the revive became a turn', after_b and all(t['state'] == 'DELIVERED' for t in after_b[1:]),
              [{k: t[k] for k in ('tick', 'state', 'turn', 'late')} for t in after_b])
        if 'b.stop' in timeline:
            receipts = [r['text'] for r in timeline['b.stop']['receipts']]
            check('B: stop: true twice, both answered', len(receipts) == 2 and 'the loop has ended' in receipts[0]
                  and receipts[1].startswith('Nothing to stop'), receipts)

    (DUMP / 'verdicts.json').write_text(json.dumps(checks, indent=2, default=str) + '\n')
    (DUMP / 'summary.md').write_text('\n'.join(summary) + '\n')
    for c in checks:
        print(('PASS ' if c['ok'] else 'FAIL ') + c['check'])
    return 0 if all(c['ok'] for c in checks) else 1


if __name__ == '__main__':
    if DUMP is None:
        raise SystemExit(__doc__)
    sys.exit(main())
