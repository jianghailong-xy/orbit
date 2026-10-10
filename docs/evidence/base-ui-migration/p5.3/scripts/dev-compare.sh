#!/usr/bin/env bash
# dev-compare.sh PROJECT: compare the dev runs of both trees for one environment (screenshots, styles, traces).
set -u
V=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1/dev
E=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833/docs/evidence/base-ui-migration
S=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/scripts
p=$1
cd $V
python3 -I $E/p3.2/compare_runs.py ref-$p/shots del-$p/shots ref-$p/out/report.json del-$p/out/report.json compare-$p.json
python3 -I $E/p4.1/summarize.py compare-$p.json > summary-$p.json
python3 -I -c "
import json,sys
s=json.load(open(sys.argv[1]))
print(json.dumps(s['screenshots']))
for b in s['beyond']: print('BEYOND', b['shot'], b['pixels'], b['max'], b['clusters'][:4])
print('notPassed', s['tests']['notPassedRef'], s['tests']['notPassedDel'])
" summary-$p.json
python3 -I $S/trace-semantics.py ref-$p/out/report.json del-$p/out/report.json > sem-$p.json; echo "sem exit $?"
python3 -I -c "
import json,sys
d=json.load(open(sys.argv[1]))
print('steps', d['steps'], 'semantic', len(d['semantic']), 'missing', d['missing'])
print('antd', json.dumps(d['antd']))
for x in d['semantic'][:80]:
    print('SEM', x.get('test','')[-40:], x.get('index'), x.get('step'), json.dumps(x.get('fields', x.get('lengths')), ensure_ascii=False)[:1500])
" sem-$p.json
