"""Side by side: the web's shipped page (docs/mocks/new-user-onboarding/after/<web>.png), the iPhone shot and the
Mac shot of the same state. Usage: compose.py <shots dir with ios/ and mac/> <web after dir> <out dir>."""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SHOTS, WEB, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
PAIRS = [
    ("managed-preparing", "a-managed", "Managed runner preparing"),
    ("managed-model", "a-model", "Managed runner up, model step"),
    ("managed-ready", "a-ready", "Ready, an example picked"),
    ("machine", "a-machine", "Bare machine setup card"),
    ("register", "a-register", "No machine at all"),
]
H = 1400
PAD = 40
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
SMALL = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)


def scaled(path, h=H):
    im = Image.open(path).convert("RGB")
    return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)


def find(platform, scene):
    name = scene if platform == "ios" else "mac-" + scene
    for d in (os.path.join(SHOTS, platform), SHOTS):
        p = os.path.join(d, name + ".png")
        if os.path.exists(p):
            return p
    return None


for scene, web, title in PAIRS:
    panes = [("Web (shipped, after/%s.png)" % web, os.path.join(WEB, web + ".png")),
             ("iPhone", find("ios", scene)), ("Mac", find("mac", scene))]
    images = [(label, scaled(p)) for label, p in panes if p]
    width = sum(im.width for _, im in images) + PAD * (len(images) + 1)
    canvas = Image.new("RGB", (width, H + 160), "white")
    draw = ImageDraw.Draw(canvas)
    draw.text((PAD, 24), title, fill="black", font=FONT)
    x = PAD
    for label, im in images:
        draw.text((x, 90), label, fill=(90, 90, 90), font=SMALL)
        canvas.paste(im, (x, 140))
        draw.rectangle([x - 1, 139, x + im.width, 140 + H], outline=(200, 200, 200))
        x += im.width + PAD
    out = os.path.join(OUT, "%s.png" % scene)
    canvas.save(out, optimize=True)
    print(out, canvas.size, [label for label, _ in images])
