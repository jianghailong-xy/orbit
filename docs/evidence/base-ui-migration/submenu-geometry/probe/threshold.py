import base64, json, sys
report = json.load(open(sys.argv[1]))
def walk(suites):
    for s in suites:
        yield from walk(s.get('suites', []))
        for spec in s.get('specs', []):
            for t in spec['tests']:
                for r in t['results']:
                    yield t['projectName'], r
for project, r in walk(report['suites']):
    print('=====', project, r['status'])
    for a in r.get('attachments', []):
        if a['name'] != 'threshold': continue
        for row in json.loads(base64.b64decode(a['body'])):
            cells = []
            for system in ('antd', 'orbit'):
                v = row[system]
                side = 'R' if v['sub'][0] >= v['item'][1] - 1 else 'L'
                over = round(v['item'][1] + v['sub'][2] - v['clientWidth'], 3)
                cells.append(f"{system} {side} item.right={v['item'][1]} +w-cw={over:+} sub=({v['sub'][0]},{v['sub'][1]})")
            print(row['left'], ' | '.join(cells), 'vv', row['orbit']['visual'])
