#!/usr/bin/env python3
"""Compare `dumpsys notification` before and after an in-place upgrade (A10 channel migration).

Usage: push-channel-upgrade.py BEFORE_DUMP AFTER_DUMP PACKAGE
"""
import re
import sys

CHANNEL = re.compile(r"NotificationChannel\{mId='([^']+)'.*?mImportance=(-?\d+).*?mUserLockedFields=(\d+).*?mDeleted=(true|false)")


def channels(path, package):
    text = open(path, errors='replace').read()
    found = {}
    for block in re.split(r'\n\s*AppSettings: ', text)[1:]:
        if not block.startswith(package + ' '):
            continue
        for line in block.splitlines():
            match = CHANNEL.search(line)
            if match:
                found[match.group(1)] = {'importance': int(match.group(2)),
                                         'userLockedFields': int(match.group(3)),
                                         'deleted': match.group(4) == 'true'}
    return found


before, after = channels(sys.argv[1], sys.argv[3]), channels(sys.argv[2], sys.argv[3])
print('before_upgrade', before)
print('after_upgrade', after)
assert before.get('orbit.needs-you', {}).get('importance') == 3, 'the earlier release must have created the DEFAULT channel'
legacy, current = after.get('orbit.needs-you'), after.get('orbit.needs-you.alert')
assert legacy is None or legacy['deleted'], f'untouched DEFAULT channel still in use: {legacy}'
assert current is not None and current['importance'] == 4 and not current['deleted'], f'no HIGH needs-you channel: {current}'
print('upgrade=PASS')
