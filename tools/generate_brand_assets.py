"""Παράγει τα εικονίδια / εικόνες προεπισκόπησης του Relay στο public/.

Χρήση (χρειάζεται Pillow):
    python tools/generate_brand_assets.py

Αν υπάρχει το public/brand/kafkas-logo.png (επίσημο λογότυπο Καυκάς, διάφανο φόντο),
μπαίνει στην εικόνα προεπισκόπησης (og-image.png). Ξανατρέξε το script μετά την προσθήκη του.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
BRAND = PUBLIC / "brand"

NAVY = (24, 41, 87)        # --v-strong #182957
NAVY_LIGHT = (36, 59, 122)  # --v #243b7a
CYAN = (8, 167, 199)       # --s #08a7c7
WHITE = (255, 255, 255)
MUTED = (184, 198, 229)

FONT_DIR = Path("C:/Windows/Fonts")


def font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        path = FONT_DIR / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def mark(size, padding_ratio=0.0, background=None):
    """Τετράγωνο εικονίδιο: κυανό στρογγυλεμένο τετράγωνο με λευκό «R»."""
    img = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = int(size * padding_ratio)
    box = [pad, pad, size - pad, size - pad]
    inner = size - 2 * pad
    draw.rounded_rectangle(box, radius=int(inner * 0.24), fill=CYAN)
    f = font(int(inner * 0.62), bold=True)
    draw.text((size / 2, size / 2 + inner * 0.02), "R", font=f, fill=WHITE, anchor="mm")
    return img


def og_image():
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), NAVY)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, h - 12, w, h], fill=CYAN)
    img.paste(mark(150), (90, 150), mark(150))
    draw.text((270, 172), "Relay", font=font(104, bold=True), fill=WHITE)
    draw.text((92, 350), "Από τις συζητήσεις σε ενέργειες", font=font(52, bold=True), fill=WHITE)
    draw.text((92, 420), "με υπεύθυνο και προθεσμία.", font=font(52), fill=MUTED)

    logo_path = BRAND / "kafkas-logo.png"
    if logo_path.exists():
        logo = Image.open(logo_path).convert("RGBA")
        logo.thumbnail((300, 110))
        img.paste(logo, (w - logo.width - 90, 90), logo)
    else:
        draw.text((w - 90, 110), "ΚΑΥΚΑΣ", font=font(40, bold=True), fill=MUTED, anchor="ra")
    return img


def main():
    BRAND.mkdir(parents=True, exist_ok=True)
    mark(512).save(PUBLIC / "icon-512.png")
    mark(192).save(PUBLIC / "icon-192.png")
    mark(512, padding_ratio=0.12, background=NAVY + (255,)).save(PUBLIC / "icon-maskable-512.png")
    mark(180, padding_ratio=0.08, background=NAVY + (255,)).convert("RGB").save(PUBLIC / "apple-touch-icon.png")
    mark(64).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    og_image().save(PUBLIC / "og-image.png", optimize=True)
    print("brand assets written to", PUBLIC)


if __name__ == "__main__":
    main()
