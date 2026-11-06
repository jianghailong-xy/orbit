# prep2.py <board dir>: the frames the second board uses, at 2x of the 340 pt they are drawn at, squeezed to 256 colours.
import sys, os, glob
from PIL import Image
board = sys.argv[1]; S = "/mnt/data/android-landing-board/shots"; R = "/root/.orbit/worktrees/01a19cd9-99a4-71b7-a00c-9441db20765a"
want = {
  "ios-list-dark": f"{R}/docs/evidence/needs-you-capsule/ios/ios-list-dark.png",
  "today-first-2-two-lines": f"{S}/today/landing-board/today-first-2-two-lines.png",
  "today-first-4-list": f"{S}/today/landing-board/today-first-4-list.png",
  "proto-saved-page": f"{S}/proto2/landing-board/proto-saved-page.png",
  "proto-relaunch-2-fresh": f"{S}/proto2/landing-board/proto-relaunch-2-fresh.png",
  "proto-saved-menu": f"{S}/proto2/landing-board/proto-saved-menu.png",
  "proto-saved-longpress": f"{S}/proto2/landing-board/proto-saved-longpress.png",
  "proto-relaunch-3-scrolled": f"{S}/proto2/landing-board/proto-relaunch-3-scrolled.png",
  "proto-completed-1-loading": f"{S}/proto2/landing-board/proto-completed-1-loading.png",
  "proto-first-1-loading": f"{S}/proto2/landing-board/proto-first-1-loading.png",
  "proto-empty-failed": f"{S}/proto2-empty/landing-board/proto-empty-failed.png",
  "proto-offline": f"{S}/proto2/landing-board/proto-offline.png",
  "proto-offline-drawer": f"{S}/proto2/landing-board/proto-offline-drawer.png",
}
for old in glob.glob(f"{board}/frames/*.png"): os.remove(old)
total = 0
for name, src in want.items():
    im = Image.open(src).convert("RGB")
    w = 680; h = round(im.height * w / im.width)
    out = f"{board}/frames/{name}.png"
    im.resize((w, h), Image.LANCZOS).quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(out, optimize=True)
    total += os.path.getsize(out)
print("frames", len(want), "bytes", total)
