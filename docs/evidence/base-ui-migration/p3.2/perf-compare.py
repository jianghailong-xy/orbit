#!/usr/bin/env python3
"""Same-scenario timings side by side: usage perf-compare.py <reference run dir> <delivery run dir> > perf-compare.json

Reads the performance.json each run of pilot-performance.browser.mjs wrote (its `pilot-performance-samples`
attachment), and
reports for the task load and every operation the sample statistics of both trees (milliseconds), the
difference of the medians, and the host load each run recorded, plus the JS/CSS the task route loaded.
One machine, one browser and theme; the numbers compare the two trees, they are not absolute targets."""
import json
import sys
from pathlib import Path


def samples(run):
    found = sorted(Path(run).rglob('performance.json'))
    if not found:
        raise SystemExit(f'no performance.json under {run}')
    return json.loads(found[-1].read_text())


reference, delivery = (samples(path) for path in sys.argv[1:3])


def stats(entry):
    return {key: entry.get(key) for key in ('count', 'min', 'median', 'p95', 'max')} if entry else None


result = {'reference': {k: reference.get(k) for k in ('observedAt', 'browser', 'hostStart', 'hostEnd', 'methodology')},
          'delivery': {k: delivery.get(k) for k in ('observedAt', 'browser', 'hostStart', 'hostEnd')},
          'loads': {}, 'operations': {}, 'resources': {}}
# A load is timed from the host and from the page's own clock; an operation in the browser and on the host.
for group, measures in (('loads', ('hostReadyMs', 'browserReadyMs')), ('operations', ('browserMs', 'hostMs'))):
    for name in sorted(set(reference[group]) | set(delivery[group])):
        r, d = reference[group].get(name, {}), delivery[group].get(name, {})
        result[group][name] = {measure: {'reference': stats(r.get(measure)), 'delivery': stats(d.get(measure)),
                                         'medianDifference': round((d.get(measure) or {}).get('median', 0) - (r.get(measure) or {}).get('median', 0), 3)}
                               for measure in measures}
for tree, report in (('reference', reference), ('delivery', delivery)):
    resources = report.get('resources', [])
    result['resources'][tree] = {'files': len(resources),
                                 'decodedBytes': sum(entry.get('decodedBodySize', 0) for entry in resources),
                                 'list': resources}
json.dump(result, sys.stdout, indent=1)
print()
