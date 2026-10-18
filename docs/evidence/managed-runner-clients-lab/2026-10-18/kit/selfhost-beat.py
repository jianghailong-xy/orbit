#!/usr/bin/env python3
"""Keep NAME's self-managed runner (wake-lab.py selfhost) online for T07's regression pictures: one runner-API
heartbeat every 20 s, Claude Code installed and signed in, until DIR/stop-beat exists. Prints one line a beat.

  LAB_TEST_SERVER_DIR=... python3 -I selfhost-beat.py NAME DIR
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

LAB = Path(os.environ.get('T07_LAB_SCRIPTS', '/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40/scripts/managed-runner/lab'))
spec = importlib.util.spec_from_file_location('wake_lab', LAB / 'wake-lab.py')
wl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wl)

name, out = sys.argv[1], Path(sys.argv[2])
token = wl.owner_state(name)['selfhost']['token']
while not (out / 'stop-beat').exists():
    status, _ = wl.self_beat(token)
    print(json.dumps({'at': wl.now(), 'owner': name, 'heartbeat': status}), flush=True)
    time.sleep(20)
