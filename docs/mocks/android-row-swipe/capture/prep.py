# prep.py <board dir> <android shots dir>: the frames the board draws, 680 px wide (2x of the 340 pt they are drawn at), 256 colours.
# The iPhone frames come from the 10-02 swipe probe's artifact (swipe-shots-ios); its own log strip at the foot is cut off.
import sys, os, glob
from PIL import Image
board, shots = sys.argv[1], sys.argv[2]
IOS = "/mnt/data/tmp/34sMy8/swipe-shots"
TODAY = os.path.join(board, "..", "android-cold-start-landing", "frames", "proto-saved-longpress.png")
def run(name, theme="dark", nav="gesture"): return f"{shots}/{theme}-{nav}/row-swipe/{theme}/{name}.png"
want = {
  "ios-open-left": (f"{IOS}/three-1-left.png", 2420), "ios-open-right": (f"{IOS}/open-2-right.png", 2420),
  "ios-open-right-light": (f"{IOS}/open-5-right-light.png", 2420), "ios-completed-right": (f"{IOS}/completed-1-right.png", 2420),
  "ios-trash-left": (f"{IOS}/trash-2-left.png", 2420),
  "a-open-left": (run("02-open-left"), None), "a-open-right": (run("05-open-right"), None), "a-armed": (run("07-full-swipe-armed"), None),
  "a-cannot": (run("09-cannot-complete"), None), "a-open-left-light": (run("02-open-left", "light"), None),
  "a-completed-right": (run("20-completed-right"), None), "a-trash-asks": (run("24-trash-asks-first"), None),
  "a-project-right": (run("15-project-row-right"), None), "a-member-left": (run("17-member-left-no-move"), None),
  "today-longpress": (TODAY, None), "a-menu": (run("14-long-press-menu"), None),
  "a-zones-gesture": (run("01-rest"), None), "a-strip-drawer": (run("26-right-swipe-in-the-strip-opens-the-drawer"), None),
  "a-zones-threebutton": (run("01-rest", "dark", "threebutton"), None),
}
for old in glob.glob(f"{board}/frames/*.png"): os.remove(old)
total = 0
for name, (src, cut) in want.items():
    if not os.path.exists(src): print("missing", name, src); continue
    im = Image.open(src).convert("RGB")
    if cut: im = im.crop((0, 0, im.width, cut))
    w = 680; h = round(im.height * w / im.width)
    out = f"{board}/frames/{name}.png"
    im.resize((w, h), Image.LANCZOS).quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(out, optimize=True)
    total += os.path.getsize(out)
print("frames", len(want), "bytes", total)
