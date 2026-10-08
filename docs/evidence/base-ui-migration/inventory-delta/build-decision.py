#!/usr/bin/env python3
"""Write the coordinator's decisions on 2026-10-07.json's forCoordinator questions as a later record.

usage: build-decision.py > 2026-10-07b.json

The 2026-10-07 record left 9 use points pending under 4 questions. The coordinator decided all four
on 2026-10-07, when sending back evidence revision 1 (38IfqZvjjfRG2lpbvFKqOb). This copies each
pending entry's facts from that record unchanged and gives it the decided owner; the earlier record
stays as it is. The name sorts after 2026-10-07.json ('b' > '.'), so `--check-owners` reads it later
and its owners win; a name like 2026-10-07-x.json would sort first and be overridden.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EARLIER = '2026-10-07.json'
BASIS = '协调者 2026-10-07 判定（第 1 版证据 38IfqZvjjfRG2lpbvFKqOb 退回意见），采纳 2026-10-07.json 的建议。'
# subject -> (owner, reason, batches that run its tests when they change what renders it)
DECISIONS = {
    'ProjectBlockers': ('P4.3a', '按项目详情页区块归 P4.3a；P4.3b 改 ProjectPromotionCard 时跑它的测试。', ['P4.3b']),
    'ProjectProgressStatus': ('P4.3a', '按项目详情页区块归 P4.3a；P4.3b、P5.3 改到渲染它的卡片或页面时跑它的测试。', ['P4.3b', 'P5.3']),
    'ProjectCrossingsCard': ('P4.3b', '决策卡，按功能归 P4.3b；P4.3a 改 ProjectsPage 详情页或 TaskAttributionCard 时跑相关测试。', ['P4.3a']),
    'TaskDependencyList': ('P4.3a', '列表，属任务详情，归 P4.3a。', []),
}


def main():
    earlier = json.load(open(HERE / EARLIER))
    asked = {item['subject']: item for item in earlier['forCoordinator']}
    assert set(asked) == set(DECISIONS), 'every question needs a decision, and only those'
    files, css = {}, []
    for subject, (owner, reason, also) in DECISIONS.items():
        decided = {'owner': owner, 'reason': reason, 'basis': BASIS, 'alsoTestedBy': also}
        for path in asked[subject]['files']:
            entry = earlier['files'][path]
            assert entry['owner'] is None and entry['pending']['candidates'].count(owner) == 1
            files[path] = {**{k: v for k, v in entry.items() if k not in ('owner', 'pending')}, **decided}
        for entry in earlier['css']:
            if entry.get('pending') and set(entry['lines']) <= set(asked[subject]['cssLines']):
                css.append({**{k: v for k, v in entry.items() if k not in ('owner', 'pending')}, **decided})
    lines = sorted(x for e in css for x in e['lines'])
    assert lines == sorted(x for item in asked.values() for x in item['cssLines']), 'every pending index.css line is decided once'
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-07',
        'task': earlier['task'],
        'amends': EARLIER,
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-07',
                     'evidenceRevision': '38IfqZvjjfRG2lpbvFKqOb', 'questions': sorted(DECISIONS)},
        'scan': earlier['scan'],
        'files': dict(sorted(files.items())),
        'css': css,
        'summary': {'files': len(files), 'cssLines': len(lines),
                    'owners': {o: sum(1 for e in [*files.values(), *css] if e['owner'] == o) for o in sorted({d[0] for d in DECISIONS.values()})}},
    }
    json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
