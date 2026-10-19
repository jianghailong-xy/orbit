import re, sys

log = open(sys.argv[1]).read().splitlines()
recs = []
for line in log:
    m = re.match(r"^(\d+:\d+:\d+\.\d+) (scroll|metrics|mark) (.*)$", line)
    if not m: continue
    wall, kind, body = m.groups()
    seq = up = None
    m2 = re.match(r"^#(\d+) t=([\d.]+) (.*)$", body)
    if m2:
        seq, up, body = int(m2.group(1)), float(m2.group(2)), m2.group(3)
    else:
        m3 = re.match(r"^(.*?) t=([\d.]+)$", body)
        if m3 and kind == "mark":
            body, up = m3.group(1), float(m3.group(2))
    recs.append((up, seq, kind, body))

recs.sort(key=lambda r: (r[0] if r[0] is not None else 0))

def show(lo, hi, label, filt=None):
    print("\n=== %s (t=%.2f..%.2f) ===" % (label, lo, hi))
    for up, seq, kind, body in recs:
        if up is None or not (lo <= up <= hi): continue
        if filt and not filt(body): continue
        tag = {None:"?", "sample":"S", "geo":"G", "phase":"P"}.get(None)
        if body.startswith("sample"):
            m = re.search(r"off=([\d.-]+) content=([\d.-]+) gap=([\d.-]+).*?<- off=([\d.-]+) content=([\d.-]+) gap=([\d.-]+) (.*)$", body)
            print("  t=%8.3f #%s  off=%7.1f content=%7.1f gap=%7.1f  <- off=%7.1f content=%7.1f gap=%7.1f  %s"
                  % (up, seq, float(m.group(1)), float(m.group(2)), float(m.group(3)),
                     float(m.group(4)), float(m.group(5)), float(m.group(6)), m.group(7)))
        elif body.startswith("geo "):
            m = re.search(r"off=([\d.-]+) size=([\d.-]+) .*visible=([\d.-]+)\.\.([\d.-]+)", body)
            print("  t=%8.3f #%s  GEO  off=%8.1f size=%8.1f visible=%.1f..%.1f gap=%7.1f"
                  % (up, seq, float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)),
                     float(m.group(2)) - float(m.group(4))))
        elif body.startswith("phase"):
            print("  t=%8.3f #%s  %s" % (up, seq, body))
        elif body.startswith("publish") or body.startswith("follow") or body.startswith("repin") \
             or body.startswith("hold") or body.startswith("held"):
            print("  t=%8.3f #%s  * %s" % (up, seq, body))
        elif kind == "mark":
            print("  t=%8.3f      MARK %s" % (up, body))
        elif body.startswith("metrics"):
            pass

marks = {}
for up, seq, kind, body in recs:
    if kind == "mark": marks[body] = up

run = sys.argv[2]  # light | dark
m = lambda name: marks["%s-%s" % (name, run)]
show(m("0-opened") - 8, m("0-opened") + 0.6, "%s: opened (pre-turn pin)" % run)
show(m("1-turn-started") - 4, m("1-turn-started") + 0.4, "%s: turn start" % run)
for n, names in [(1, ("2-think1-box", "3a-fold1-plus0", "3c-fold1-settled")),
                 (2, ("2-think2-box", "4a-fold2-plus0", "4c-fold2-settled")),
                 (3, ("2-think3-box", "6a-fold3-plus0", "6c-fold3-settled"))]:
    def find(*cands):
        for c in cands:
            k = "%s-%s" % (c, run)
            if k in marks: return marks[k]
        return None
    box, plus0, settled = (find(x, x.replace("settled", "missing")) for x in names)
    if box is None or plus0 is None or settled is None: 
        print("missing marks for fold", n); continue
    show(box - 1.2, box + 0.15, "%s: think%d box (pre-fold)" % (run, n))
    show(box + 0.15, plus0 + 0.55, "%s: FOLD%d publish -> +0.55s" % (run, n))
    show(plus0 + 0.55, settled + 0.35, "%s: fold%d settle" % (run, n))
show(m("8a-rest-plus0") - 6, m("8b-rest") + 0.5, "%s: reply + end -> rest" % run)
