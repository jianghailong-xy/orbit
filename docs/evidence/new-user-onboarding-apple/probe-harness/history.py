import sys
from PIL import Image, ImageDraw, ImageFont
S, OUT = sys.argv[1:3]
H, PAD = 1100, 40
F = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
rows = [("history-managed", "Managed default draft"), ("history-machine", "Bare machine"), ("history-none", "No machine")]
ims = []
for scene, label in rows:
    for plat, name in (("ios", scene), ("mac", "mac-" + scene)):
        im = Image.open("%s/%s/%s.png" % (S, plat, name)).convert("RGB")
        ims.append(("%s — %s" % (label, "iPhone" if plat == "ios" else "Mac"), im.resize((round(im.width * H / im.height), H), Image.LANCZOS)))
W = sum(i.width for _, i in ims) + PAD * (len(ims) + 1)
c = Image.new("RGB", (W, H + 160), "white"); d = ImageDraw.Draw(c)
d.text((PAD, 24), "An account that has had a session: no welcome card, every page as before", fill="black", font=F)
x = PAD
for label, im in ims:
    d.text((x, 90), label, fill=(90, 90, 90), font=f); c.paste(im, (x, 140)); x += im.width + PAD
c.save(OUT, optimize=True); print(OUT, c.size)
