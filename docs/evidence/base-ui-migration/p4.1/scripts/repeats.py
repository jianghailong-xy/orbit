#!/usr/bin/env python3
"""Run-to-run variation of the P4.1 screenshots that differed beyond antialias level.

usage: repeats.py RUNS_DIR OUT.json

For every screenshot the repeated tests write (the photo test and the two CLI login tests), in every
environment: the SHA-256 (first 12 hex digits) each run wrote, how many distinct images each tree
produced, and whether the delivery's images are all among the reference's. Runs:
  reference b5a39dd48: f-p41-ref, rep-ref-1, rep-ref-2
  delivery  b0b59fa39: f-p41-del, rep-del-1, rep-del-2
  start tip a84bc61e7 (development, same AntD pages): r1-ref, r1-ref2
Only reads."""
import hashlib, json, os, sys

runs_dir, out_path = sys.argv[1:3]
REFERENCE = ['f-p41-ref', 'rep-ref-1', 'rep-ref-2']
DELIVERY = ['f-p41-del', 'rep-del-1', 'rep-del-2']
START = ['r1-ref', 'r1-ref2']


def digest(run, env, name):
    path = os.path.join(runs_dir, f'{run}-shots', env, name)
    if not os.path.exists(path):
        return None
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:12]


names = sorted({name for env in os.listdir(os.path.join(runs_dir, 'rep-ref-1-shots'))
                for name in os.listdir(os.path.join(runs_dir, 'rep-ref-1-shots', env))})
envs = sorted(os.listdir(os.path.join(runs_dir, 'rep-ref-1-shots')))
result = {}
for name in names:
    for env in envs:
        row = {run: digest(run, env, name) for run in REFERENCE + DELIVERY + START}
        ref = {row[r] for r in REFERENCE if row[r]}
        dele = {row[r] for r in DELIVERY if row[r]}
        result[f'{env}/{name}'] = {
            'runs': row,
            'referenceVariants': len(ref),
            'deliveryVariants': len(dele),
            'deliveryWithinReference': dele <= ref,
            'deliveryWithinReferenceOrStart': dele <= (ref | {row[r] for r in START if row[r]}),
        }
json.dump(result, open(out_path, 'w'), indent=1)
same = [k for k, v in result.items() if v['referenceVariants'] == 1 and v['deliveryVariants'] == 1 and v['deliveryWithinReference']]
print(f'{len(result)} screenshots; identical in every run of both trees: {len(same)}')
for key, v in result.items():
    if key in same:
        continue
    print(f"{key}: reference {v['referenceVariants']} variant(s), delivery {v['deliveryVariants']}, "
          f"delivery within reference {v['deliveryWithinReference']}, within reference+start {v['deliveryWithinReferenceOrStart']}")
