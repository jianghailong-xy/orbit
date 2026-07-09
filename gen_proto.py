#!/usr/bin/env python3
import os
from PIL import ImageFont

DEJA = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
reg = lambda s: ImageFont.truetype(DEJA, s)
bld = lambda s: ImageFont.truetype(DEJB, s)
w_reg = lambda t, s: reg(s).getlength(t)
w_bld = lambda t, s: bld(s).getlength(t)

W, H = 744, 812
S = []
def e(x): S.append(x)

e(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="DejaVu Sans">')
e('<defs>')
e('<radialGradient id="coral" cx="32%" cy="26%" r="95%"><stop offset="0" stop-color="#e79070"/><stop offset="0.5" stop-color="#d97757"/><stop offset="1" stop-color="#b0563a"/></radialGradient>')
e('<radialGradient id="green" cx="32%" cy="26%" r="95%"><stop offset="0" stop-color="#63bd90"/><stop offset="1" stop-color="#2f8f5f"/></radialGradient>')
# background
e(f'<rect width="{W}" height="{H}" fill="#101012"/>')

PW, PH = 320, 690
AX, AY = 32, 52
BX, BY = 392, 52

def clip(idp, ox, oy):
    e(f'<clipPath id="{idp}"><rect x="{ox}" y="{oy}" width="{PW}" height="{PH}" rx="42"/></clipPath>')
clip("clipA", AX, AY)
clip("clipB", BX, BY)
e('</defs>')

def prompt_glyph(cx, cy, sw, scale=1.0):
    s = scale
    return (f'<path d="M {cx-9*s} {cy-9*s} L {cx-1*s} {cy-0.5*s} L {cx-9*s} {cy+8*s}" '
            f'fill="none" stroke="#fff" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="M {cx+2*s} {cy+9*s} L {cx+12*s} {cy+9*s}" fill="none" stroke="#fff" '
            f'stroke-width="{sw}" stroke-linecap="round"/>')

def caption(cx, y, main, sub):
    e(f'<text x="{cx}" y="{y}" font-size="14" font-weight="bold" fill="#c7c7cc" text-anchor="middle">{main}'
      f'<tspan fill="#8e8e93" font-weight="normal"> {sub}</tspan></text>')

def phone(ox, oy, sheet=False):
    e(f'<g clip-path="url(#{"clipB" if sheet else "clipA"})">')
    # shell
    e(f'<rect x="{ox}" y="{oy}" width="{PW}" height="{PH}" rx="42" fill="#000"/>')
    # status bar
    e(f'<text x="{ox+26}" y="{oy+27}" font-size="14" font-weight="bold" fill="#fff">4:56</text>')
    e(f'<text x="{ox+278}" y="{oy+27}" font-size="12.5" fill="#fff" text-anchor="end">5G</text>')
    bx = ox+284
    e(f'<rect x="{bx}" y="{oy+16}" width="24" height="12" rx="3" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="1.3"/>')
    e(f'<rect x="{bx+2}" y="{oy+18}" width="13" height="8" rx="1.5" fill="#34c759"/>')
    e(f'<rect x="{bx+24.5}" y="{oy+19.5}" width="2" height="5" rx="1" fill="#fff" fill-opacity="0.5"/>')
    # header back button
    cx, cy = ox+33, oy+68
    e(f'<circle cx="{cx}" cy="{cy}" r="17" fill="#1c1c1e"/>')
    e(f'<path d="M {cx+4} {cy-6} L {cx-4} {cy} L {cx+4} {cy+6}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
    # hero avatar
    hx = ox+160
    acy = oy+230
    e(f'<circle cx="{hx}" cy="{acy}" r="34" fill="url(#coral)" stroke="#fff" stroke-opacity="0.16" stroke-width="1"/>')
    e(prompt_glyph(hx, acy, 3.2, 1.0))
    # name chip + chevron
    name = "orbit @ claude"
    nw = w_bld(name, 22)
    chev_w = 15
    total = nw + 6 + chev_w
    gx = hx - total/2
    nby = oy+322
    e(f'<rect x="{gx-14}" y="{nby-25}" width="{total+28}" height="35" rx="11" fill="#fff" fill-opacity="0.05"/>')
    e(f'<text x="{gx}" y="{nby}" font-size="22" font-weight="bold" fill="#fff">{name}</text>')
    dcx = gx + nw + 6 + chev_w/2
    dcy = nby-8
    e(f'<path d="M {dcx-5} {dcy-2} L {dcx} {dcy+3} L {dcx+5} {dcy-2}" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
    # sub + hint
    e(f'<text x="{hx}" y="{oy+356}" font-size="14" fill="#9a9aa0" text-anchor="middle">New session  ·  Opus 4.8  ·  Max</text>')
    e(f'<text x="{hx}" y="{oy+380}" font-size="14" fill="#636366" text-anchor="middle">Send a task to get started.</text>')
    # composer
    cyt = oy+560
    e(f'<rect x="{ox+12}" y="{cyt}" width="296" height="52" rx="24" fill="#1c1c1e"/>')
    pcx, pcy = ox+30, cyt+26
    e(f'<path d="M {pcx} {pcy-7} L {pcx} {pcy+7} M {pcx-7} {pcy} L {pcx+7} {pcy}" stroke="#8e8e93" stroke-width="2" stroke-linecap="round"/>')
    e(f'<text x="{ox+50}" y="{cyt+32}" font-size="16" fill="#8e8e93">Message…</text>')
    scx, scy = ox+286, cyt+26
    e(f'<circle cx="{scx}" cy="{scy}" r="17" fill="#2c2c2e"/>')
    e(f'<path d="M {scx} {scy+6} L {scx} {scy-6} M {scx-5} {scy-1} L {scx} {scy-6} L {scx+5} {scy-1}" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
    # bottom bar
    parts = ["Auto", "orbit @ claude", "Opus 4.8", "Max"]
    gap = 13
    gauge_w = 26
    pw = [w_bld(p, 12) for p in parts]
    pct_w = w_bld("3%", 12)
    total_bb = sum(pw) + gap*len(parts) + gauge_w + 5 + pct_w
    bx0 = ox+160 - total_bb/2
    by = oy+642
    cur = bx0
    for p, wp in zip(parts, pw):
        e(f'<text x="{cur}" y="{by+4}" font-size="12" font-weight="bold" fill="#8e8e93">{p}</text>')
        cur += wp + gap
    e(f'<rect x="{cur}" y="{by-3}" width="{gauge_w}" height="7" rx="3.5" fill="#2c2c2e"/>')
    e(f'<rect x="{cur}" y="{by-3}" width="5" height="7" rx="2.5" fill="#8e8e93"/>')
    cur += gauge_w + 5
    e(f'<text x="{cur}" y="{by+4}" font-size="12" font-weight="bold" fill="#8e8e93">3%</text>')

    if sheet:
        # scrim
        e(f'<rect x="{ox}" y="{oy+42}" width="{PW}" height="{PH-42}" fill="#000" fill-opacity="0.55"/>')
        st = oy+356
        e(f'<rect x="{ox}" y="{st}" width="{PW}" height="{PH-356+40}" rx="18" fill="#1c1c1e"/>')
        e(f'<rect x="{ox+142}" y="{st+9}" width="36" height="5" rx="2.5" fill="#48484a"/>')
        e(f'<text x="{ox+160}" y="{st+34}" font-size="15" font-weight="bold" fill="#fff" text-anchor="middle">Switch agent</text>')
        rows = [
            ("coral", "orbit @ claude", "root · Opus 4.8", True),
            ("green", "orbit @ codex", "root · GPT-5", False),
            ("coral", "husong @ claude", "husong · Sonnet 5", False),
        ]
        ry = st+48
        rh = 57
        for grad, nm, subt, sel in rows:
            if sel:
                e(f'<rect x="{ox}" y="{ry}" width="{PW}" height="{rh}" fill="#fff" fill-opacity="0.06"/>')
            acx2, acy2 = ox+40, ry+rh/2
            e(f'<circle cx="{acx2}" cy="{acy2}" r="19" fill="url(#{grad})" stroke="#fff" stroke-opacity="0.14"/>')
            e(prompt_glyph(acx2, acy2, 2.0, 0.56))
            e(f'<text x="{ox+70}" y="{acy2-3}" font-size="15" font-weight="bold" fill="#fff">{nm}</text>')
            e(f'<text x="{ox+70}" y="{acy2+15}" font-size="12.5" fill="#8e8e93">{subt}</text>')
            if sel:
                kx, ky = ox+292, acy2
                e(f'<path d="M {kx-6} {ky} L {kx-2} {ky+4} L {kx+6} {ky-5}" fill="none" stroke="#d97757" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>')
            e(f'<rect x="{ox+70}" y="{ry+rh}" width="{PW-70}" height="1" fill="#fff" fill-opacity="0.06"/>')
            ry += rh
        # New agent row
        acx2, acy2 = ox+40, ry+rh/2
        e(f'<circle cx="{acx2}" cy="{acy2}" r="19" fill="none" stroke="#48484a" stroke-width="1.6" stroke-dasharray="3 3"/>')
        e(f'<path d="M {acx2} {acy2-6} L {acx2} {acy2+6} M {acx2-6} {acy2} L {acx2+6} {acy2}" stroke="#8e8e93" stroke-width="2" stroke-linecap="round"/>')
        e(f'<text x="{ox+70}" y="{acy2+5}" font-size="15" font-weight="bold" fill="#8e8e93">New agent…</text>')

    e('</g>')

caption(AX+PW/2, 32, "① 新会话空态", "· agent 成为主角")
caption(BX+PW/2, 32, "② 点 agent 名", "· 一键切换")
phone(AX, AY, sheet=False)
phone(BX, BY, sheet=True)
e('</svg>')

open("/tmp/proto.svg", "w").write("\n".join(S))
print("wrote /tmp/proto.svg", os.path.getsize("/tmp/proto.svg"), "bytes")
