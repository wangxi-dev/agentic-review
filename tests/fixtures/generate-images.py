"""Regenerate the local PNG/JPEG/WebP fixtures (optional developer utility; needs Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT = Path("C:/Windows/Fonts/segoeui.ttf")
BOLD = Path("C:/Windows/Fonts/seguisb.ttf")

def font(size, bold=False):
    path = BOLD if bold else FONT
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default(size=size)

def make(changed=False):
    image = Image.new("RGB", (640, 360), "#edf1f6")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((28, 28, 612, 332), radius=20, fill="white", outline="#c4cedc", width=2)
    draw.rounded_rectangle((52, 54, 102, 104), radius=12, fill="#2155b5")
    draw.text((61, 61), "ar", font=font(27, True), fill="white")
    draw.text((120, 61), "Review with clarity", font=font(30, True), fill="#1c293c")
    draw.text((52, 136), "Local files. Clear feedback.", font=font(24), fill="#495b72")
    draw.rounded_rectangle((52, 194, 588, 244), radius=9, fill="#dce8ff" if changed else "#e5f5ea")
    draw.text((70, 204), "Updated artwork" if changed else "Ready for review", font=font(22, True), fill="#173f87" if changed else "#19613a")
    draw.text((52, 275), "PNG / JPEG / WebP", font=font(19, True), fill="#495b72")
    return image

sample = make()
sample.save(HERE / "sample.png")
sample.save(HERE / "sample.jpg", quality=90)
sample.save(HERE / "sample.webp", quality=90)
make(True).save(HERE / "changed.png")
