import re, sys

def load(path):
    recs = []
    for line in open(path):
        m = re.match(r"^(\S+) (scroll|metrics|mark) (.*)$", line)
        if not m: continue
        wall, kind, body = m.groups()
        m2 = re.match(r"^#(\d+) t=([\d.]+) (.*)$", body)
        if m2:
            seq, up, body = int(m2.group(1)), float(m2.group(2)), m2.group(3)
        elif kind == "mark":
            m3 = re.match(r"^(.*?) t=([\d.]+)$", body)
            if not m3: continue
            body, up, seq = m3.group(1), float(m3.group(2)), None
        else:
            continue
        recs.append((up, seq, body))
    recs.sort(key=lambda r: r[0])
    return recs

def fold_table(path, run):
    recs = load(path)
    marks = {b: u for u, s, b in recs if s is None}
    def m(name, *alts):
        for n in (name,) + alts:
            k = "%s-%s" % (n, run)
            if k in marks: return marks[k]
        return None
    # pre-fold state: last sample before the fold publish; fold frames: samples between box mark and settled mark
    out = []
    for n, box, plus0, settled in [
        (1, "2-think1-box", "3a-fold1-plus0", ("3c-fold1-settled", "3c-fold1-missing")),
        (2, "2-think2-box", "4a-fold2-plus0", ("4c-fold2-settled", "4c-fold2-missing")),
        (3, "2-think3-box", "6a-fold3-plus0", ("6c-fold3-settled", "6c-fold3-missing"))]:
        tb, t0 = m(box), m(plus0)
        ts = m(*settled)
        rows = []
        last_sample = None
        for up, seq, body in recs:
            if body.startswith("sample"):
                mm = re.search(r"off=([\d.-]+) content=([\d.-]+) gap=([\d.-]+) inset=([\d.-]+) <- off=([\d.-]+) content=([\d.-]+)", body)
                if mm and up <= ts + 0.3:
                    last_sample = (up, mm)
                    if tb - 6 <= up <= ts + 0.3:
                        rows.append((up, mm))
        out.append((n, tb, t0, ts, rows))
    return out

for platform in ("ios", "mac"):
    for run in (("light", "dark") if platform == "ios" else ("light",)):
        print("\n######## %s %s" % (platform, run))
        for n, tb, t0, ts, rows in fold_table("/tmp/tfold-results/shots-diag/diag/%s/metrics.log" % platform, run):
            print("\n-- fold%d (box@%.2f +0@%.2f settled@%.2f)" % (n, tb, t0, ts))
            for up, mm in rows:
                d_off = float(mm.group(1)) - float(mm.group(5))
                d_content = float(mm.group(2)) - float(mm.group(6))
                print("   t=%8.3f  off %7.1f -> %7.1f (%+6.1f)   content %7.1f -> %7.1f (%+6.1f)   gap=%.1f%s"
                      % (up, float(mm.group(5)), float(mm.group(1)), d_off,
                         float(mm.group(6)), float(mm.group(2)), d_content,
                         float(mm.group(3)),
                         "   <== MARK+%.2fs" % (up - t0) if abs(up - t0) < 0.6 else ""))
