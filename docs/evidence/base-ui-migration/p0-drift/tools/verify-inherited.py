#!/usr/bin/env python3
"""Checks the main drift registry against its files, the P0.2 record, the attribution groups and git: each entry
replaces one P0.2 screenshot with its recorded hash, its main commits are on origin/main and are not this
project's promotions, its generating tree does not contain the B1 commit 57f792135, the generating run recorded
the same hash and environment, and the registered set equals the union of the a-class groups."""
import json, hashlib, subprocess, sys, os
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))
EV=f'{ROOT}/docs/evidence/base-ui-migration'
D=f'{EV}/p0-drift'
sha=lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
def git(*a): return subprocess.run(['git','-C',ROOT,*a],capture_output=True,text=True)
problems=[]
p02={i['path'].replace('docs/evidence/base-ui-migration/p0.2/screenshots/',''):i['sha256'] for i in json.load(open(f'{EV}/p0.2/baseline-run/summary.json'))['images']}
print('P0.2 originals recorded:',len(p02))
bad=[k for k,v in p02.items() if sha(f'{EV}/p0.2/screenshots/{k}')!=v]
print('P0.2 originals whose file hash differs from record:',len(bad))
env=sha(f'{EV}/p0.2/environment.json')
reg=json.load(open(f'{D}/reference/registry.json'))['screenshots']
runs=json.load(open(f'{D}/attribution/runs.json'))
att=json.load(open(f'{D}/attribution/attribution.json'))
groups={g['id']:set(g['screenshots']) for g in att}
print('groups:',{k:len(v) for k,v in groups.items()})
seen=set(); commits_checked={}
for e in reg:
    s=e['screenshot']
    if s in seen: problems.append(f'dup {s}')
    seen.add(s)
    if s not in p02: problems.append(f'not a P0 screenshot {s}')
    if e['p0Baseline']!=p02.get(s): problems.append(f'p0Baseline mismatch {s}')
    f=f'{D}/reference/screenshots/{s}'
    if sha(f)!=e['sha256']: problems.append(f'file hash mismatch {s}')
    if e['generatedFrom']['commit']!=e['mainCommits'][-1]: problems.append(f'generatedFrom != last main {s}')
    if e['generatedFrom']['environment']!=env: problems.append(f'env mismatch {s}')
    run=runs.get(e['generatedFrom']['run'])
    if not run: problems.append(f'run missing {s} {e["generatedFrom"]["run"]}')
    else:
        if run['commit']!=e['generatedFrom']['commit']: problems.append(f'run commit != generatedFrom {s}')
        if run['screenshots'].get(s)!=e['sha256']: problems.append(f'run screenshot hash != registry {s}')
        if run['environmentSha256']!=env: problems.append(f'run env mismatch {s}')
    # which groups contain s
    gs=[g for g,v in groups.items() if s in v]
    if not gs or any(not g.startswith('A') for g in gs if g!='B1'): problems.append(f'unexpected groups {s} {gs}')
    if not set(e['change'])<=set(g for g in gs if g.startswith('A')): problems.append(f'change field {e["change"]} vs groups {gs} for {s}')
    for c in e['mainCommits']:
        if c in commits_checked: continue
        anc=git('merge-base','--is-ancestor',c,'origin/main').returncode==0
        subj=git('log','-1','--format=%s',c).stdout.strip()
        promo='refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main' in subj
        # does the commit's tree contain P2.3 notification change 57f792135?
        has_b1=git('merge-base','--is-ancestor','57f792135','%s'%c).returncode==0
        commits_checked[c]=(anc,promo,subj,has_b1)
for c,(anc,promo,subj,has_b1) in commits_checked.items():
    print(f'{c[:10]} on origin/main={anc} promotion={promo} contains57f792135={has_b1} :: {subj}')
    if not anc or promo or has_b1: problems.append(f'main commit check failed {c}')
a_union=set().union(*[v for k,v in groups.items() if k.startswith('A')])
print('registered:',len(seen),' A-union:',len(a_union),' registered==A-union:',seen==a_union)
print('B1 screenshots:',sorted(groups['B1']))
print('B1 ∩ registered:',sorted(groups['B1']&seen))
# stray files in reference/screenshots
allpng=set()
for dp,dn,fn in os.walk(f'{D}/reference/screenshots'):
    for f in fn:
        if f.endswith('.png'): allpng.add(os.path.relpath(os.path.join(dp,f),f'{D}/reference/screenshots'))
print('stray reference pngs:',sorted(allpng-seen))
print('PROBLEMS:',problems if problems else 'none')
