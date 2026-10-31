"""compare.py WEB_PNG ANDROID_PNG TOP BOTTOM OUT_PNG TITLE: one state of the board, the web as built beside the Android emulator.

The Android capture is cut to rows TOP..BOTTOM (the transcript, or the review sheet) and both are scaled to one height, under a line
naming each; the sheet is quantized to 256 colours so it stays small in the repository.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

web_path, android_path, top, bottom, out, title = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
HEIGHT, PAD, HEAD = 1000, 32, 120
web = Image.open(web_path).convert("RGB")
android = Image.open(android_path).convert("RGB")
android = android.crop((0, top, android.width, bottom))
scaled = [image.resize((round(image.width * HEIGHT / image.height), HEIGHT), Image.LANCZOS) for image in (web, android)]
width = PAD * 3 + sum(image.width for image in scaled)
sheet = Image.new("RGB", (width, HEAD + HEIGHT + PAD), "#e9eaed")
draw = ImageDraw.Draw(sheet)
# DejaVu Sans where the host has it: Pillow's own default font has no em dash.
def font(size):
    try: return ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError: return ImageFont.load_default(size=size)
draw.text((PAD, 18), title, fill="#1c1c1e", font=font(34))
x = PAD
for image, label in zip(scaled, (f"web as built · {web_path.split('/')[-1]}", "Android · emulator-5554, API 36")):
    draw.text((x, 72), label, fill="#555861", font=font(26))
    sheet.paste(image, (x, HEAD))
    draw.rectangle((x - 1, HEAD - 1, x + image.width, HEAD + HEIGHT), outline="#b9bcc4")
    x += image.width + PAD
sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(out, optimize=True)
print(out, sheet.size)
