"""Read the traces of failed choices.browser.mjs:592 runs: usage row-actions-traces.py <run directory> <output json>

For each trace.zip: p2.2 revision 8's read-trace.py summary (module requests that failed, network-change errors,
the last actions; its `pageErrors` also lists the test's own failed expectation), and when the case's last
ArrowDown and Enter presses started and ended, in ms from the start of that ArrowDown press."""
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True  # importing read-trace.py must not leave a __pycache__ in the p2.2 directory
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('read_trace', HERE.parent / 'p2.2' / 'revision-8' / 'read-trace.py')
read_trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read_trace)

run, output = Path(sys.argv[1]), Path(sys.argv[2])
if output.exists():
    raise SystemExit(f'{output} exists; retained evidence is never overwritten.')
traces = []
for path in sorted(run.glob('*trace.zip')):
    with zipfile.ZipFile(path) as archive:
        events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
                  for line in archive.read(name).decode().splitlines() if line.strip()]
    before = {e['callId']: e for e in events if e.get('type') == 'before'}
    after = {e['callId']: e for e in events if e.get('type') == 'after'}
    presses = [call for call, e in before.items() if e.get('method') == 'keyboardPress' and e['params'].get('key') in ('ArrowDown', 'Enter')]
    down, enter = presses[-2], presses[-1]
    start = before[down]['startTime']
    traces.append({**read_trace.summarize(str(path)),
                   'arrowDownMs': [0, round(after[down]['endTime'] - start, 1)],
                   'enterMs': [round(before[enter]['startTime'] - start, 1), round(after[enter]['endTime'] - start, 1)]})
output.write_text(json.dumps(traces, indent=1, ensure_ascii=False) + '\n')
for trace in traces:
    print(trace['trace'], 'failed requests', len(trace['failedRequests']), 'network changed', trace['networkChangedConsoleErrors'],
          'ArrowDown', trace['arrowDownMs'], 'Enter', trace['enterMs'])
