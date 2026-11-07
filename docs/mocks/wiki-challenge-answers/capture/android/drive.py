#!/usr/bin/env python3
"""Drive the debug APK (CI artifact of 91f77563d, src/android identical to this tree) on emulator-5554 against the
private stack (gateway http://10.0.2.2:2734): sign in, open Wiki -> Activity -> Review, photograph the challenge card,
press Re-confirm and photograph what follows, then the entry page's own Retire... dialog. Run under ui.lock.
usage: python3 -I drive.py <out-dir> <apk>"""
import os, re, shutil, struct, subprocess, sys, time, json
import xml.etree.ElementTree as ET

ADB = os.environ.get('ADB') or shutil.which('adb') or '/opt/android-sdk/platform-tools/adb'
SERIAL = os.environ.get('SERIAL', 'emulator-5554')
PKG = os.environ.get('PKG', 'io.orbitd.android.debug')  # debug builds carry applicationIdSuffix .debug
OUT, APK = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
LOG = open(os.path.join(OUT, 'drive.log'), 'a')
SEED = json.load(open(os.environ.get('IDS_JSON', '/mnt/data/tmp/34tDf8/stack/seed.json')))
SERVER = os.environ.get('SERVER', 'http://10.0.2.2:2734')

def log(*a):
    line = time.strftime('%H:%M:%S') + ' ' + ' '.join(str(x) for x in a)
    print(line, flush=True); LOG.write(line + '\n'); LOG.flush()

def adb(*args, check=True, timeout=120, binary=False):
    r = subprocess.run([ADB, '-s', SERIAL, *args], capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError('adb %s -> %s %s' % (' '.join(args), r.returncode, r.stderr.decode(errors='replace')[:400]))
    return r.stdout if binary else r.stdout.decode(errors='replace')

def sh(cmd, **kw):
    return adb('shell', cmd, **kw)

def shot(name):
    data = adb('exec-out', 'screencap', '-p', binary=True)
    path = os.path.join(OUT, name + '.png')
    open(path, 'wb').write(data)
    log('shot', name, len(data))
    return path

BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
def nodes():
    for _ in range(3):
        out = sh('uiautomator dump /sdcard/rv-ui.xml >/dev/null 2>&1; cat /sdcard/rv-ui.xml', check=False)
        if '<hierarchy' in out:
            break
        time.sleep(1)
    try:
        root = ET.fromstring(out[out.index('<?xml'):] if '<?xml' in out else out)
    except Exception:
        return []
    res = []
    for n in root.iter('node'):
        m = BOUNDS.match(n.get('bounds', ''))
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        res.append({'text': n.get('text', ''), 'desc': n.get('content-desc', ''), 'cls': n.get('class', ''),
                    'clickable': n.get('clickable') == 'true', 'enabled': n.get('enabled') == 'true',
                    'box': (x1, y1, x2, y2)})
    return res

def find(text=None, desc=None, contains=False, timeout=40, quiet=False):
    t0 = time.time()
    while True:
        for n in nodes():
            v = n['text'] if text is not None else n['desc']
            want = text if text is not None else desc
            if (want in v) if contains else (v == want):
                return n
        if time.time() - t0 > timeout:
            if not quiet:
                tag = 'fail-%d' % int(time.time())
                shot(tag)
                open(os.path.join(OUT, tag + '.xml'), 'w').write(sh('cat /sdcard/rv-ui.xml', check=False))
            raise RuntimeError('not found: text=%r desc=%r' % (text, desc))
        time.sleep(1)

def stable(text=None, desc=None, timeout=30):
    """The node once two reads a second apart put it in the same place: the login page animates in."""
    t0, last = time.time(), None
    while True:
        n = find(text=text, desc=desc, timeout=timeout)
        if last is not None and n['box'] == last['box']:
            return n
        if time.time() - t0 > timeout:
            return n
        last = n
        time.sleep(1.0)

def center(n):
    x1, y1, x2, y2 = n['box']
    return (x1 + x2) // 2, (y1 + y2) // 2

def tap(n):
    x, y = center(n); sh('input tap %d %d' % (x, y)); log('tap', n['text'] or n['desc'], x, y)

def type_text(s):
    sh("input text '%s'" % s.replace(' ', '%s').replace("'", ''))

def screen_size():
    m = re.search(r'(\d+)x(\d+)', sh('wm size'))
    return int(m.group(1)), int(m.group(2))

def touch_device():
    out = sh('getevent -lp')
    dev, best = None, None
    for block in out.split('add device')[1:]:
        m = re.search(r'\d+: (/dev/input/event\d+)', block)
        if m and 'ABS_MT_POSITION_X' in block:
            mx = re.search(r'ABS_MT_POSITION_X\s*:\s*value \d+, min (\d+), max (\d+)', block)
            my = re.search(r'ABS_MT_POSITION_Y\s*:\s*value \d+, min (\d+), max (\d+)', block)
            dev, best = m.group(1), (int(mx.group(2)), int(my.group(2)))
            break
    return dev, best

def ev(t, c, v):
    return struct.pack('<qqHHi', 0, 0, t, c, v)

def triple_tap(n):
    """Three taps inside the double-tap timeout, written straight to the touch device (adb input is too slow)."""
    dev, (mx, my) = touch_device()
    w, h = screen_size()
    x, y = center(n)
    dx, dy = int(x * mx / w), int(y * my / h)
    EV_SYN, EV_KEY, EV_ABS = 0, 1, 3
    down = (ev(EV_ABS, 0x2f, 0) + ev(EV_ABS, 0x39, 77) + ev(EV_ABS, 0x35, dx) + ev(EV_ABS, 0x36, dy)
            + ev(EV_ABS, 0x3a, 60) + ev(EV_ABS, 0x30, 6) + ev(EV_KEY, 0x14a, 1) + ev(EV_SYN, 0, 0))
    up = ev(EV_ABS, 0x2f, 0) + ev(EV_ABS, 0x39, -1) + ev(EV_KEY, 0x14a, 0) + ev(EV_SYN, 0, 0)
    local = os.path.join(OUT, 'tap.bin'); open(local, 'wb').write(down + up)
    adb('push', local, '/data/local/tmp/rv-tap.bin')
    sh('for i in 1 2 3; do cat /data/local/tmp/rv-tap.bin > %s; sleep 0.09; done' % dev)
    log('triple tap', dev, x, y, '->', dx, dy)

def swipe_up(frac=0.55, ms=500):
    w, h = screen_size()
    sh('input swipe %d %d %d %d %d' % (w // 2, int(h * 0.80), w // 2, int(h * (0.80 - frac)), ms))
    time.sleep(1.2)

def main():
    log('device', sh('getprop ro.build.version.release').strip(), screen_size())
    adb('root', check=False); time.sleep(2); adb('wait-for-device')
    old_stylus = sh('settings get secure stylus_handwriting_enabled').strip()
    sh('settings put secure stylus_handwriting_enabled 0')
    sh('settings put system screen_off_timeout 1800000')
    sh('cmd uimode night no', check=False)
    # Install over whatever is there: another task's debug key may have signed the installed app.
    if ('package:%s\n' % PKG) in sh('pm list packages %s' % PKG).replace('\r', '') + '\n':
        sh('pm uninstall %s' % PKG, check=False)
    adb('install', '-r', APK, timeout=300)
    sh('pm grant %s android.permission.POST_NOTIFICATIONS' % PKG, check=False)
    sh('am start -W -n %s/io.orbitd.android.MainActivity' % PKG)
    find(desc='Orbit', timeout=60)
    logo = stable(desc='Orbit')
    log('logo settled at', logo['box'])
    shot('a00-login')
    triple_tap(logo)
    try:
        field = find(text='Server address', contains=True, timeout=10, quiet=True)
    except RuntimeError:
        x, y = center(logo)
        log('evdev triple tap opened nothing; trying three overlapping input taps')
        sh('input tap %d %d & sleep 0.06; input tap %d %d & sleep 0.06; input tap %d %d; wait' % (x, y, x, y, x, y))
        field = find(text='Server address', contains=True, timeout=15)
    shot('a01-server-dialog')
    edit = [n for n in nodes() if n['cls'].endswith('EditText')][0]
    tap(edit); time.sleep(0.5)
    sh('input keycombination 113 29', check=False); sh('input keyevent 67', check=False)  # ctrl+a, delete
    held = [n for n in nodes() if n['cls'].endswith('EditText')]
    if held and held[0]['text'] not in ('', 'Server address'):
        sh('input keyevent ' + ' '.join(['67'] * 40), check=False)
    type_text(SERVER); time.sleep(0.5)
    log('server field now', [n['text'] for n in nodes() if n['cls'].endswith('EditText')])
    shot('a02-server-typed')
    tap(find(text='Save'))
    time.sleep(2)
    def fill(index, value, secret=False):
        """Type into the index-th field, read it back, and type again until it holds the value: the first keystroke
        after a focus can be lost while the keyboard comes up, and the page moves when it does."""
        for attempt in range(4):
            field = [n for n in nodes() if n['cls'].endswith('EditText')][index]
            tap(field); time.sleep(1.5)
            sh('input keycombination 113 29', check=False); sh('input keyevent ' + ' '.join(['67'] * 30), check=False)
            type_text(value); time.sleep(1.0)
            held = [n for n in nodes() if n['cls'].endswith('EditText')][index]['text']
            ok = (len(held) == len(value) and set(held) <= {'•', '*'}) if secret else held == value
            log('field', index, 'attempt', attempt, 'holds', held if not secret else '%d dots' % len(held), 'ok' if ok else 'retry')
            if ok:
                return
        raise RuntimeError('field %d never held its value' % index)
    log('login fields', len([n for n in nodes() if n['cls'].endswith('EditText')]))
    fill(0, 'owner@orbit.test')
    fill(1, 'orbit-board-34tDf8', secret=True)
    shot('a03-login-filled')
    tap(find(text='Sign In'))
    nav = find(desc='Open navigation', timeout=40)
    time.sleep(3)
    shot('a04-signed-in')
    # The Wiki from the drawer (orbit://wiki is no host the manifest declares), then Activity, then Review.
    tap(nav); time.sleep(1.5)
    tap(find(text='Wiki', timeout=15)); time.sleep(4)
    shot('b00-wiki-home')
    try:
        act = find(desc='Activity', timeout=40, quiet=True)
    except RuntimeError:
        act = find(text='Activity', timeout=10)
    tap(act); time.sleep(3)
    shot('b01-activity')
    banner = find(text='proposals to review', contains=True, timeout=30)
    tap(banner); time.sleep(4)
    shot('c00-review-top')
    for i in range(1, 8):
        swipe_up()
        shot('c%02d-review-scroll' % i)
        if any(n['text'] == 'Re-confirm' for n in nodes()):
            break
    # Bring the three answers fully on screen, then press Re-confirm and watch what follows.
    rc = find(text='Re-confirm')
    w, h = screen_size()
    if center(rc)[1] > h * 0.75:
        swipe_up(0.25); rc = find(text='Re-confirm')
    shot('d00-answers')
    all_nodes = nodes()
    json.dump([n for n in all_nodes if n['text'] in ('Re-confirm', 'Amend', 'Retire') or 'Agents stop' in n['text']],
              open(os.path.join(OUT, 'answers-nodes.json'), 'w'), indent=1)
    x, y = center(rc)
    t0 = time.time()
    sh('input tap %d %d' % (x, y))
    log('pressed Re-confirm at', x, y)
    for label in ('d01-after-press-a', 'd02-after-press-b', 'd03-after-press-c'):
        shot(label); log(label, 'at', round(time.time() - t0, 2), 's')
    after = nodes()
    json.dump({'pressed_at': [x, y], 'under_finger': [n for n in after if n['box'][0] <= x <= n['box'][2] and n['box'][1] <= y <= n['box'][3]],
               'texts': [n['text'] for n in after if n['text']][:80]}, open(os.path.join(OUT, 'after-press.json'), 'w'), indent=1, ensure_ascii=False)
    time.sleep(3); shot('d04-after-press-5s')
    # The entry page's own Retire... (the product's irreversible pattern on Android), on an entry still challenged.
    entry = SEED['entryIds']['34s2IFZlpqkEDdbKZwcj3']
    sh("am start -W -a android.intent.action.VIEW -d 'orbit-wiki:%s' %s" % (entry, PKG))
    time.sleep(4)
    shot('e00-entry')
    more = None
    for n in nodes():
        if n['desc'] in ('More', 'More actions', 'More options'):
            more = n
    if more:
        tap(more); time.sleep(1.5); shot('e01-entry-menu')
        tap(find(text='Retire…', timeout=10)); time.sleep(1.5); shot('e02-retire-dialog')
        tap(find(text='Cancel', timeout=10)); time.sleep(1)
    else:
        log('no More button on the entry page; descs:', [n['desc'] for n in nodes() if n['desc']][:30])
    sh('settings put secure stylus_handwriting_enabled %s' % (old_stylus if old_stylus not in ('', 'null') else '1'), check=False)
    log('done')

try:
    main()
except Exception as e:
    log('FAILED', repr(e))
    try:
        shot('zz-failure')
    except Exception:
        pass
    sys.exit(1)
