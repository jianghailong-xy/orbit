import json, sys
projects = sys.argv[2].split(',') if len(sys.argv) > 2 else None
for r in json.load(open(sys.argv[1])):
    if projects and r['project'] not in projects: continue
    if 'scroll-positions' in r:
        s = ' '.join('%s/%s=%s' % (x['when'][:6], x['step'], x['pageScrollTop']) for x in r['scroll-positions'])
        print(r['project'], r['test'][:22].ljust(22), r['status'], '|', s)
        for e in r['errors']: print('      ', e[:160])
    else:
        print(r['project'], r['test'][:22], r['status'], r.get('document', {}).get('after'))
