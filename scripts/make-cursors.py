"""도끼 커서 이미지 생성기.

원본(img/cursor/src/axe-original.jpg, 흰 배경 JPG)에서 배경을 투명하게 따고
상태별 커서 PNG(1x, 2x)를 img/cursor/ 에 만든다. 핫스팟 좌표는 css/cursor.css 에 쓸 값을 출력.

    python scripts/make-cursors.py

필요: Pillow
"""
import math
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "img/cursor/src/axe-original.jpg"
OUT = ROOT / "img/cursor"

AXE = 40          # 도끼 자체 크기(CSS px) — 기존 기본 커서와 동일
CANVAS = 48       # 회전해도 잘리지 않게 여유를 둔 캔버스(CSS px)
SCALES = (1, 2)   # 1x, 2x(고배율 화면)


def cut_background(im: Image.Image) -> Image.Image:
    """테두리에서 이어진 흰 배경만 flood fill 로 투명 처리 (날의 밝은 부분은 유지)."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    seen = bytearray(w * h)
    q = deque([(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)])
    while q:
        x, y = q.popleft()
        if not (0 <= x < w and 0 <= y < h) or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b = px[x, y]
        if r > 232 and g > 232 and b > 232:
            mp[x, y] = 0
            q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = im.convert("RGBA")
    out.putalpha(mask)
    bbox = mask.point(lambda v: 255 if v > 40 else 0).getbbox()
    out = out.crop(bbox)
    s = max(out.size)
    sq = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sq.paste(out, (0, 0))
    return sq


def blade_tip(img: Image.Image) -> tuple[float, float]:
    """도끼날 왼쪽 끝(가장 왼쪽의 불투명 픽셀 중 가장 위) — 클릭 지점."""
    a = img.split()[3]
    w, h = img.size
    ap = a.load()
    for x in range(w):
        ys = [y for y in range(h) if ap[x, y] > 128]
        if ys:
            return x + 0.5, min(ys) + 0.5
    return 0, 0


def place(master: Image.Image, angle: float, px: int) -> tuple[Image.Image, tuple[float, float]]:
    """도끼를 px 배율 캔버스에 놓고 angle(도, 시계 방향 +)만큼 회전. 날 끝 좌표도 같이 변환."""
    axe = round(AXE * px)
    canvas = round(CANVAS * px)
    small = master.resize((axe, axe), Image.LANCZOS)
    tx, ty = blade_tip(small)
    off = (canvas - axe) // 2
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    layer.paste(small, (off, off))
    tx, ty = tx + off, ty + off
    if angle:
        layer = layer.rotate(-angle, resample=Image.BICUBIC, center=(canvas / 2, canvas / 2))
        c = canvas / 2
        r = math.radians(angle)
        dx, dy = tx - c, ty - c
        tx, ty = c + dx * math.cos(r) - dy * math.sin(r), c + dx * math.sin(r) + dy * math.cos(r)
    return layer, (tx, ty)


def with_shadow(img: Image.Image, px: int) -> Image.Image:
    """밝은/어두운 배경 어디서나 보이게 옅은 그림자."""
    a = img.split()[3]
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sh.putalpha(a.point(lambda v: v * 0.45))
    sh = sh.filter(ImageFilter.GaussianBlur(0.9 * px))
    base = Image.new("RGBA", img.size, (0, 0, 0, 0))
    base.alpha_composite(sh, (round(1 * px), round(1.5 * px)))
    base.alpha_composite(img)
    return base


def speed_lines(img: Image.Image, px: int) -> Image.Image:
    """누르는 중: 날 옆에 내려찍는 효과선."""
    d = ImageDraw.Draw(img)
    # 날이 지나온 자리(위·오른쪽)에 휘두른 방향(왼쪽 아래)으로 짧은 선 3개. 흰 테두리로 어두운 배경에서도 보이게
    lines = [((9, 5), (6, 10)), ((14, 6), (11, 11)), ((19, 8), (16, 13))]
    for col, wd in (((255, 255, 255, 210), 2.6), ((40, 40, 40, 230), 1.2)):
        for (x0, y0), (x1, y1) in lines:
            d.line([(x0 * px, y0 * px), (x1 * px, y1 * px)], fill=col, width=max(1, round(wd * px)))
    return img


def no_badge(img: Image.Image, px: int) -> Image.Image:
    """불가: 오른쪽 아래 금지 표시."""
    d = ImageDraw.Draw(img)
    cx, cy, r = 36 * px, 36 * px, 7.5 * px
    w = max(2, round(2.2 * px))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 235), outline=(200, 30, 30, 255), width=w)
    k = r * 0.68
    d.line([(cx - k, cy - k), (cx + k, cy + k)], fill=(200, 30, 30, 255), width=w)
    return img


def main():
    master = cut_background(Image.open(SRC))
    states = {
        "axe": dict(angle=0),                         # 기본
        "axe-pointer": dict(angle=18),                # 클릭 가능: 치켜든 각도
        "axe-active": dict(angle=-22, fx=speed_lines),  # 누르는 중: 내려찍기
        "axe-not-allowed": dict(angle=0, fx=no_badge),  # 불가
    }
    hotspots = {}
    for name, cfg in states.items():
        for px in SCALES:
            img, (hx, hy) = place(master, cfg["angle"], px)
            img = with_shadow(img, px)
            if "fx" in cfg:
                img = cfg["fx"](img, px)
            suffix = "" if px == 1 else f"@{px}x"
            img.save(OUT / f"{name}{suffix}.png", optimize=True)
            if px == 1:
                hotspots[name] = (round(hx), round(hy))
    for k, v in hotspots.items():
        print(f"{k}: {v[0]} {v[1]}")


if __name__ == "__main__":
    main()
