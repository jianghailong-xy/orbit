#!/usr/bin/env python3
"""Host UI steps for A10's tray tap into a process no instrumentation owns.

Reads `uiautomator dump` hierarchies and taps with `input tap`; it never sends a PendingIntent.
Usage: push-host-ui.py {wait|tap} SERIAL TEXT OUTPUT_XML [--timeout SECONDS] [--contains] [--desc] [--scroll | --scroll-back]
--desc matches the node's content description instead of its text (an icon button). A tap waits for the node to be enabled.
--scroll swipes the content up between attempts, as a person scrolls to an off-screen button; --scroll-back swipes it down, to one
above (a conversation opens at its end).
"""
import argparse
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = os.path.join(os.environ.get('ANDROID_HOME', '/opt/android-sdk'), 'platform-tools', 'adb')
REMOTE = '/data/local/tmp/a10-window.xml'


def adb(serial, *args):
    return subprocess.run([ADB, '-s', serial, *args], capture_output=True, text=True, timeout=60)


def find(serial, text, contains, desc=False, enabled=False):
    if 'dumped to' not in adb(serial, 'shell', 'uiautomator', 'dump', REMOTE).stdout:
        return None, None, None
    xml = adb(serial, 'exec-out', 'cat', REMOTE).stdout
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None, xml, None
    for node in root.iter('node'):
        value = node.get('content-desc' if desc else 'text') or ''
        if ((text in value) if contains else value == text) and (not enabled or node.get('enabled') == 'true'):
            return node, xml, root
    return None, xml, root


def swipe(serial, root, back=False):
    bounds = next(root.iter('node')).get('bounds') if root is not None else '[0,0][1080,2400]'
    _, _, width, height = map(int, re.findall(r'\d+', bounds))
    start, end = (height * 3 // 10, height * 6 // 10) if back else (height * 6 // 10, height * 3 // 10)
    adb(serial, 'shell', 'input', 'swipe', str(width // 2), str(start), str(width // 2), str(end), '400')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['wait', 'tap'])
    parser.add_argument('serial')
    parser.add_argument('text')
    parser.add_argument('output')
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--contains', action='store_true')
    parser.add_argument('--desc', action='store_true')
    scrolls = parser.add_mutually_exclusive_group()
    scrolls.add_argument('--scroll', action='store_true')
    scrolls.add_argument('--scroll-back', action='store_true')
    args = parser.parse_args()
    deadline = time.monotonic() + args.timeout
    node, xml = None, None
    while time.monotonic() < deadline:
        node, xml, root = find(args.serial, args.text, args.contains, args.desc, enabled=args.action == 'tap')
        if node is not None:
            break
        if (args.scroll or args.scroll_back) and root is not None:
            swipe(args.serial, root, back=args.scroll_back)
        time.sleep(0.5)
    if xml is not None:
        with open(args.output, 'w') as out:
            out.write(xml)
    if node is None:
        print(f'not found: {args.text}', file=sys.stderr)
        return 1
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    print(f'found {"desc" if args.desc else "text"}={node.get("content-desc" if args.desc else "text")!r} bounds={node.get("bounds")}')
    if args.action == 'tap':
        result = adb(args.serial, 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
        print(f'tap exit={result.returncode}')
        return result.returncode
    return 0


if __name__ == '__main__':
    sys.exit(main())
