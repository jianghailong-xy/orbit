"""Summarize one Playwright trace.zip: module requests that failed or never finished, console/page errors and the last actions."""
import json
import sys
import zipfile


def summarize(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        events = [json.loads(line) for name in names if name.endswith('.trace')
                  for line in archive.read(name).decode().splitlines() if line.strip()]
        network = [json.loads(line) for name in names if name.endswith('.network')
                   for line in archive.read(name).decode().splitlines() if line.strip()]
    requests = []
    for entry in network:
        snapshot = entry.get('snapshot', {})
        request, response = snapshot.get('request', {}), snapshot.get('response', {})
        url = request.get('url', '')
        if '/src/' not in url and '/node_modules/' not in url and '/ui-migration/' not in url:
            continue
        requests.append({'url': url.split('127.0.0.1')[-1][:140], 'status': response.get('status'),
                         'failure': snapshot.get('_failureText'), 'ms': round(snapshot.get('time', 0), 1)})
    bad = [r for r in requests if r['failure'] or r['status'] in (None, -1, 0) or r['status'] >= 400]
    slow = sorted(requests, key=lambda r: -r['ms'])[:5]
    console = [{'type': e.get('messageType'), 'text': e.get('text', '')[:300]} for e in events
               if e.get('type') == 'console' and e.get('messageType') in ('error', 'warning')]
    errors = [e.get('error', {}).get('message', '')[:300] for e in events if e.get('type') == 'error']
    actions = [{'api': e.get('apiName') or e.get('method'), 'title': e.get('title'),
                'start': e.get('startTime'), 'error': (e.get('error') or {}).get('message', '')[:160] if isinstance(e.get('error'), dict) else None}
               for e in events if e.get('type') == 'before']
    name = path.split('/')[-1] if path.split('/')[-1] != 'trace.zip' else path.split('/')[-2]
    return {'trace': name, 'moduleRequests': len(requests), 'failedRequests': bad,
            'networkChangedConsoleErrors': sum('ERR_NETWORK_CHANGED' in c['text'] for c in console),
            'slowestRequests': slow, 'console': console[:10], 'pageErrors': errors[:5],
            'lastActions': [a for a in actions if a['api']][-6:]}


if __name__ == '__main__':
    print(json.dumps([summarize(p) for p in sys.argv[1:]], indent=1))
