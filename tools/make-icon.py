# ExperiPhoto のアイコンを描く（緑の角丸に白いカメラ。Research Hub の赤い「RH」と見分けられる色）
#   python3 tools/make-icon.py
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
GREEN = (15, 110, 86, 255)
WHITE = (255, 255, 255, 255)


def draw(size, maskable=False):
    s = 4  # 大きく描いて縮め、縁を滑らかにする
    W = size * s
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, W, W], fill=GREEN)  # 端末が形を切り抜くので全面を塗る
        k = 0.62
    else:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=GREEN)
        k = 0.78
    cx = cy = W / 2
    bw, bh = W * 0.62 * k, W * 0.42 * k  # カメラの胴
    top = cy - bh / 2 + W * 0.03 * k
    d.rounded_rectangle([cx - bw / 2, top, cx + bw / 2, top + bh], radius=int(W * 0.07 * k), fill=WHITE)
    hw, hh = bw * 0.36, W * 0.08 * k  # 上の出っぱり
    d.rounded_rectangle([cx - hw / 2, top - hh * 0.8, cx + hw / 2, top + hh * 0.5], radius=int(hh * 0.4), fill=WHITE)
    r = bh * 0.34  # レンズ
    lc = top + bh / 2
    d.ellipse([cx - r, lc - r, cx + r, lc + r], fill=GREEN)
    r2 = r * 0.62
    d.ellipse([cx - r2, lc - r2, cx + r2, lc + r2], fill=WHITE)
    r3 = r * 0.3
    d.ellipse([cx - r3, lc - r3, cx + r3, lc + r3], fill=GREEN)
    fr = W * 0.025 * k  # フラッシュの点
    fx, fy = cx + bw / 2 - W * 0.07 * k, top + W * 0.06 * k
    d.ellipse([fx - fr, fy - fr, fx + fr, fy + fr], fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")
draw(512, maskable=True).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
