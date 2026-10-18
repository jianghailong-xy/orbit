#!/usr/bin/env python3
"""T07's native scenes: which recording, which time window, where the app opens, and what the test does and must
see. `pack` cuts each with t07rec.py pack into SCENES_DIR (the probe's scenes/), then writes the steps file
the probe reads. Windows are the HPC host's UTC clock; ids are the test server's public ids.

  python3 -I scenes.py pack RUN_DIR SCENES_DIR [NAME...]
"""
import json
import subprocess
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent

# Words of the shared display (MANAGED_RUNNER_COPY) the native apps show as the banner's title.
WAITING = 'Waiting for capacity'
PREPARING = 'Preparing your managed runner'
WAKING = 'Waking your managed runner'
STOPPING = 'Managed runner going to sleep'
ASLEEP = 'Managed runner asleep'
FAILED = 'Managed runner failed'
MANAGED_WORDS = [WAITING, PREPARING, WAKING, STOPPING, ASLEEP, FAILED, 'Set up a managed runner', 'No managed runner',
                 'Your managed runner needs a model', 'Managed runner not responding', 'Waiting for an operator']

DOCK = '/mnt/data/tmp/t07-34ZtjU1Q/dock'
EVE_WS = '34huV6eiavlQuuUtX0W0a'
EVE_S1 = '34huXsoh2eZnT7logfclT'
CAP = 'as many runner containers as it allows'
ROOT_WS = '34htasHVEnwCfDe1K58bE'
ROOT_SESSION = '34htasQH9ZMfYI7kB46z6'
WEN_WS = '34htihnwejmtvTYblwbOK'
WEN_S1 = '34htkKzxTPS9lsLzhOGjk'
NIA_WS = '34htzVqRcSiCwyhEIBpr6'
NIA_S1 = '34hu0yWhtIlaZz1eVBWTZ'


def off(label, recording, start, end):
    """The switch unset or false, or the capability missing: root's self-managed workspace and session, as before."""
    return [
        {'name': f'{label}-compose', 'rec': recording, 'from': start, 'to': end, 'surface': 'compose', 'agent': ROOT_WS, 'steps': [
            {'wait': 'Claude Code', 'timeout': 90},
            {'absent': MANAGED_WORDS + ['Register your own machine'], 'shot': f'{label}-compose'},
        ]},
        {'name': f'{label}-session', 'rec': recording, 'from': start, 'to': end, 'surface': 'console', 'agent': ROOT_WS,
         'session': ROOT_SESSION, 'steps': [
            {'wait': 't06 self-managed t07', 'timeout': 90},
            {'absent': MANAGED_WORDS, 'shot': f'{label}-session-deep-link'},
        ]},
    ]


SCENES = [
    *off('01-off-unset', 'root-unset', '2026-10-18T05:53:36.279Z', '2026-10-18T05:55:36.875Z'),
    *off('02-off-false', 'root-false', '2026-10-18T05:55:51.926Z', '2026-10-18T05:57:36.813Z'),
    *off('03-off-missing', 'root-missing', '2026-10-18T05:56:15.799Z', '2026-10-18T05:57:36.813Z'),
    # wen: the web acted; the native app only watches the same account.
    {'name': '04-wen-first-session-offered', 'rec': 'wen', 'from': '2026-10-18T05:58:38.645Z', 'to': '2026-10-18T05:59:35.000Z',
     'surface': 'compose', 'agent': WEN_WS, 'steps': [
        {'wait': WAITING, 'timeout': 60, 'shot': '04a-waiting-no-key-no-first-session'},
        {'wait': 'DeepSeek', 'timeout': 90, 'shot': '04b-key-added-first-session-offered'},
    ]},
    {'name': '05-wen-preparing-answered', 'rec': 'wen', 'from': '2026-10-18T05:59:40.000Z', 'to': '2026-10-18T06:01:40.000Z',
     'surface': 'console', 'agent': WEN_WS, 'session': WEN_S1, 'steps': [
        {'wait': WAITING, 'timeout': 60, 'shot': '05a-first-session-queued-waiting'},
        {'wait': PREPARING, 'timeout': 150, 'shot': '05b-preparing'},
        {'wait': 'Answering: T07-WEN-S1', 'timeout': 120, 'shot': '05c-answered'},
        {'gone': PREPARING, 'timeout': 60, 'shot': '05d-ready'},
    ]},
    {'name': '06-wen-sleep-wake', 'rec': 'wen', 'from': '2026-10-18T06:01:40.000Z', 'to': '2026-10-18T06:03:40.000Z',
     'surface': 'console', 'agent': WEN_WS, 'session': WEN_S1, 'steps': [
        {'wait': STOPPING, 'timeout': 90, 'shot': '06a-going-to-sleep'},
        {'wait': ASLEEP, 'timeout': 90, 'shot': '06b-asleep'},
        {'wait': 'Answering: T07-WEN-M1', 'timeout': 120, 'shot': '06c-woken-by-a-message-answered'},
    ]},
    {'name': '07-wen-restarts-failed-retried', 'rec': 'wen', 'from': '2026-10-18T06:05:15.000Z', 'to': '2026-10-18T06:09:40.000Z',
     'surface': 'console', 'agent': WEN_WS, 'session': WEN_S1, 'steps': [
        {'wait': 'being started again on the same data volume', 'timeout': 90, 'shot': '07a-restarting'},
        {'wait': FAILED, 'timeout': 240, 'shot': '07b-failed-stopped-too-often'},
        {'wait': 'stopped too often'},
        {'wait': 'Retry', 'timeout': 30},
        {'gone': FAILED, 'timeout': 150, 'shot': '07c-retried-by-another-client'},
    ]},
    # nia: the native app acts (the recorder sent what the iPhone draft and console send); the web only watches.
    {'name': '08-nia-first-session', 'rec': 'nia', 'from': '2026-10-18T06:09:35.612Z', 'to': '2026-10-18T06:12:40.000Z',
     'surface': 'compose', 'agent': NIA_WS, 'steps': [
        {'wait': WAITING, 'timeout': 60, 'shot': '08a-waiting-no-key-no-first-session'},
        {'wait': 'DeepSeek', 'timeout': 90, 'shot': '08b-key-added-first-session-offered'},
        {'type': 'T07-NIA-S1 a first session from the iPhone composer while the runner waits for capacity', 'send': True},
        {'wait': WAITING, 'timeout': 60, 'shot': '08c-first-session-queued-waiting'},
        {'wait': PREPARING, 'timeout': 200, 'shot': '08d-preparing'},
        {'wait': 'Answering: T07-NIA-S1', 'timeout': 120, 'shot': '08e-answered'},
    ]},
    {'name': '09-nia-sleep-wake', 'rec': 'nia', 'from': '2026-10-18T06:12:40.000Z', 'to': '2026-10-18T06:14:51.000Z',
     'surface': 'console', 'agent': NIA_WS, 'session': NIA_S1, 'steps': [
        {'wait': STOPPING, 'timeout': 90, 'shot': '09a-going-to-sleep'},
        {'wait': ASLEEP, 'timeout': 90, 'shot': '09b-asleep'},
        {'type': 'T07-NIA-M1 wake the sleeping runner with a message from the iPhone', 'send': True},
        {'wait': WAKING, 'timeout': 30, 'shot': '09c-waking-after-the-message'},
        {'wait': 'Answering: T07-NIA-M1', 'timeout': 120, 'shot': '09d-answered'},
    ]},
    {'name': '10-nia-out-of-memory-retry', 'rec': 'nia', 'from': '2026-10-18T06:14:53.000Z', 'to': '2026-10-18T06:18:40.000Z',
     'surface': 'console', 'agent': NIA_WS, 'session': NIA_S1, 'steps': [
        {'wait': 'ran out of memory and stopped', 'timeout': 90, 'shot': '10a-restarting-out-of-memory'},
        {'wait': FAILED, 'timeout': 240, 'shot': '10b-failed-kept-running-out-of-memory'},
        {'wait': 'kept running out of memory'},
        {'press': 'Retry', 'timeout': 30},
        {'wait': WAKING, 'timeout': 30, 'shot': '10c-retried-waking'},
        {'gone': WAKING, 'timeout': 150, 'shot': '10d-ready-again'},
    ]},
    {'name': '11-nia-quota-wait', 'rec': 'nia', 'from': '2026-10-18T06:18:47.000Z', 'to': '2026-10-18T06:20:45.000Z',
     'surface': 'console', 'agent': NIA_WS, 'session': NIA_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 60, 'shot': '11a-asleep'},
        {'type': 'T07-NIA-Q1 wake while the cluster quota has no room for the Pod', 'send': True},
        {'wait': "resource quota for managed runners has no room", 'timeout': 30, 'shot': '11b-waking-quota-has-no-room'},
        {'wait': 'Answering: T07-NIA-Q1', 'timeout': 150, 'shot': '11c-answered-once-there-was-room'},
    ]},
    {'name': '12-nia-volume-in-use', 'rec': 'nia', 'from': '2026-10-18T06:20:59.000Z', 'to': '2026-10-18T06:22:20.000Z',
     'surface': 'console', 'agent': NIA_WS, 'session': NIA_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 60, 'shot': '12a-asleep'},
        {'type': 'T07-NIA-V1 wake while an attachment of the volume is left behind', 'send': True},
        {'wait': "Something else is using this runner's data volume", 'timeout': 30, 'shot': '12b-waking-volume-held'},
        {'wait': 'Answering: T07-NIA-V1', 'timeout': 120, 'shot': '12c-answered-once-free'},
    ]},
    {'name': '13-nia-volume-deleted', 'rec': 'nia', 'from': '2026-10-18T06:24:00.000Z', 'to': 'END:nia-pvc.end',
     'surface': 'console', 'agent': NIA_WS, 'session': NIA_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 60, 'shot': '13a-asleep'},
        {'type': 'T07-NIA-D1 wake after the volume claim was deleted', 'send': True},
        {'wait': FAILED, 'timeout': 60},
        {'wait': "recorded data volume is gone", 'timeout': 30, 'shot': '13b-failed-volume-gone-no-retry'},
        {'absent': ['Retry']},
    ]},
    # wen asleep while the server runs with the switch on and a profile it cannot use: nothing reconciles.
    {'name': '14-wen-environment-unavailable', 'rec': 'wen', 'from': 'START:unavailable.start', 'to': 'END:unavailable.end',
     'surface': 'console', 'agent': WEN_WS, 'session': WEN_S1, 'steps': [
        {'wait': 'not configured correctly', 'timeout': 60, 'shot': '14a-asleep-environment-unavailable'},
        {'wait': ASLEEP},
    ]},
    # root, an existing account with its own runner, signs in with the switch on: its workspace and deep link as before.
    {'name': '15-root-on-own-workspace', 'rec': 'root-on', 'from': 'START:scene-root-on.start', 'to': 'END:scene-root-on.end',
     'surface': 'compose', 'agent': ROOT_WS, 'steps': [
        {'wait': 'Claude Code', 'timeout': 90},
        {'absent': MANAGED_WORDS + ['Register your own machine'], 'shot': '15-on-own-workspace-draft'},
    ]},
    {'name': '16-root-on-session', 'rec': 'root-on', 'from': 'START:scene-root-on.start', 'to': 'END:scene-root-on.end',
     'surface': 'console', 'agent': ROOT_WS, 'session': ROOT_SESSION, 'steps': [
        {'wait': 't06 self-managed t07', 'timeout': 90},
        {'absent': MANAGED_WORDS, 'shot': '16-on-session-deep-link'},
    ]},
    # Docker backend (the host's real Docker): eve; the native app acts, the web watches.
    {'name': '17-docker-first-session-then-at-the-cap', 'run': DOCK, 'rec': 'eve', 'from': 'START:scene-eve.start', 'to': 'END:eve-cap-1.end',
     'surface': 'compose', 'agent': EVE_WS, 'steps': [
        {'wait': WAITING, 'timeout': 60, 'shot': '17a-waiting-for-capacity'},
        {'wait': 'DeepSeek', 'timeout': 60, 'shot': '17b-first-session-offered'},
        {'type': 'T07-EVE-S1 a first session while the managed environment has no room', 'send': True},
        {'wait': WAITING, 'timeout': 60, 'shot': '17c-first-session-queued'},
        {'wait': CAP, 'timeout': 150, 'shot': '17d-preparing-at-the-container-cap'},
        {'wait': 'Answering: T07-EVE-S1', 'timeout': 150, 'shot': '17e-answered'},
    ]},
    {'name': '18-docker-wake-at-the-cap', 'run': DOCK, 'rec': 'eve', 'from': 'START:orphan-2.on', 'to': 'END:eve-cap-2.end',
     'surface': 'console', 'agent': EVE_WS, 'session': EVE_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 60, 'shot': '18a-asleep'},
        {'type': 'T07-EVE-M1 wake while the Docker host is at its cap', 'send': True},
        {'wait': CAP, 'timeout': 30, 'shot': '18b-waking-at-the-container-cap'},
        {'wait': 'Answering: T07-EVE-M1', 'timeout': 150, 'shot': '18c-answered'},
    ]},
    {'name': '19-docker-volume-in-use', 'run': DOCK, 'rec': 'eve', 'from': 'START:eve-cap-2.end', 'to': 'END:eve-volume-held.end',
     'surface': 'console', 'agent': EVE_WS, 'session': EVE_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 90, 'shot': '19a-asleep'},
        {'type': 'T07-EVE-V1 wake while another container holds the volume', 'send': True},
        {'wait': "Something else is using this runner's data volume", 'timeout': 30, 'shot': '19b-waking-volume-held'},
        {'wait': 'Answering: T07-EVE-V1', 'timeout': 150, 'shot': '19c-answered-once-free'},
    ]},
    {'name': '20-docker-volume-restored-retry', 'run': DOCK, 'rec': 'eve', 'from': 'START:eve-volume-held.end', 'to': 'END:eve-volume.end',
     'surface': 'console', 'agent': EVE_WS, 'session': EVE_S1, 'steps': [
        {'wait': ASLEEP, 'timeout': 120, 'shot': '20a-asleep'},
        {'type': 'T07-EVE-R1 wake after the volume was removed', 'send': True},
        {'wait': 'recorded data volume is gone', 'timeout': 30, 'shot': '20b-failed-volume-gone-no-retry'},
        {'absent': ['Retry']},
        {'wait': 'back as it was recorded', 'timeout': 200, 'shot': '20c-restored-retry-offered'},
        {'press': 'Retry', 'timeout': 60},
        {'gone': FAILED, 'timeout': 60, 'shot': '20d-retried'},
        {'wait': 'Answering: T07-EVE-R1', 'timeout': 200, 'shot': '20e-answered'},
    ]},
    # Where each app lands by itself (nothing named at launch), with the switch on: root on its own workspace, which
    # comes first; nia, a new account whose only workspace is the managed one, on it.
    {'name': '21-root-on-home', 'rec': 'root-on', 'from': 'START:scene-root-on.start', 'to': 'END:scene-root-on.end',
     'surface': 'home', 'steps': [
        {'wait': 'selfhost', 'timeout': 90},
        {'absent': ['Register your own machine', 'Set up a managed runner'], 'shot': '21-on-launch-landing'},
    ]},
    {'name': '22-nia-new-account-home', 'rec': 'nia', 'from': '2026-10-18T06:09:35.612Z', 'to': '2026-10-18T06:10:30.000Z',
     'surface': 'home', 'steps': [
        {'wait': 'Default', 'timeout': 90},
        {'absent': ['Register your own machine', 'Set up a managed runner'], 'shot': '22-new-account-launch-landing'},
    ]},
]


def pack(run_dir, scenes_dir, only):
    base_run, scenes_dir = Path(run_dir), Path(scenes_dir)
    for scene in SCENES:
        if only and scene['name'] not in only:
            continue
        run_dir = Path(scene.get('run', base_run))
        meta = {k: scene[k] for k in ('surface', 'agent', 'session', 'steps') if k in scene}
        end, start = scene['to'], scene['from']
        if end.startswith('END:'):
            end = (run_dir / end[4:]).read_text().strip()
        if start.startswith('START:'):
            start = (run_dir / start[6:]).read_text().strip()
        meta['recording'] = scene['rec']
        result = subprocess.run([sys.executable, '-I', str(KIT / 't07rec.py'), 'pack', '--out', str(run_dir / 'rec' / scene['rec']),
                                 '--name', scene['name'], '--from', start, '--to', end, '--meta', json.dumps(meta),
                                 '--scenes', str(scenes_dir)], capture_output=True, text=True)
        print(result.stdout.strip() or result.stderr.strip()[-600:])


if __name__ == '__main__':
    if sys.argv[1] == 'pack':
        pack(sys.argv[2], sys.argv[3], set(sys.argv[4:]))
