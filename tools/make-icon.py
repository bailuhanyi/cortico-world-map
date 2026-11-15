"""
生成扩展图标 assets/icon.png（512×512，市场要求 ≤512KB）。

画意：一张折起来的小地图，摊在桌面上，上面只有几个圆点和一个「家」的标记——
**没有连线、没有路径**。这是这个插件最要紧的一件事：它给的是「有哪些地方」，
不是「怎么走过去」。所以图上也不画任何线。

配色取 Coo 主题的薄荷绿 #00a870 作底，纸张是暖白，圆点用薄荷和暖橙，
「家」那个点大一点、带一圈。缩到 64px 时仍能看出「一张纸 + 几个点」。

约定：所有坐标都写在 512 的坐标系里，统一由 S() 乘上超采样倍数再画，
最后缩回 512 —— 这样写法直观，边缘又由 LANCZOS 磨平。

用法：python tools/make-icon.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'icon.png'
SIZE = 512
SS = 4                       # 超采样倍数
N = SIZE * SS

MINT = (0, 168, 112)
MINT_DEEP = (0, 122, 82)
NIGHT = (26, 30, 62)
PAPER = (250, 246, 236)
PAPER_EDGE = (226, 218, 200)
INK = (58, 62, 74)
LAMP = (255, 176, 74)


def S(v):
    """512 坐标系 → 超采样画布坐标。"""
    return int(round(v * SS))


def main():
    img = Image.new('RGB', (N, N), MINT)
    d = ImageDraw.Draw(img)

    # 底色：薄荷绿，往上稍亮往下稍深，像桌面被灯照着。
    top = (8, 186, 128)
    for y in range(N):
        t = y / N
        c = tuple(int(top[i] + (MINT_DEEP[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (N, y)], fill=c)

    # ---- 纸：一张略微倾斜的地图 ----
    # 四个角（顺时针），左边高一点，像摊在桌上没摆正。
    corners = [(74, 132), (428, 96), (446, 382), (96, 416)]
    poly = [(S(x), S(y)) for x, y in corners]

    # 纸下的一层阴影：整体往下挪一点、压深。
    shadow = [(S(x + 6), S(y + 12)) for x, y in corners]
    d.polygon(shadow, fill=(0, 96, 64))

    d.polygon(poly, fill=PAPER)

    # 纸的折痕：两条竖线把纸分三栏，暗示「这是一张折过的地图」。
    def lerp(p, q, t):
        return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

    for t in (1 / 3, 2 / 3):
        a = lerp(corners[0], corners[1], t)
        b = lerp(corners[3], corners[2], t)
        d.line([(S(a[0]), S(a[1])), (S(b[0]), S(b[1]))], fill=PAPER_EDGE, width=S(3))

    # 纸边：一圈淡墨描边，让纸从底色里浮出来。
    d.line(poly + [poly[0]], fill=PAPER_EDGE, width=S(4), joint='curve')

    # ---- 地方：几个圆点。**没有线把它们连起来** ----
    spots = [
        (176, 214, 20, MINT, True),     # 家：大一点、带一圈
        (300, 188, 13, INK, False),
        (354, 300, 13, LAMP, False),
        (204, 336, 13, INK, False),
        (150, 292, 10, MINT, False),
    ]
    for x, y, r, color, ring in spots:
        if ring:
            d.ellipse((S(x - r - 13), S(y - r - 13), S(x + r + 13), S(y + r + 13)),
                      outline=color, width=S(5))
        d.ellipse((S(x - r), S(y - r), S(x + r), S(y + r)), fill=color)

    # 「家」那一点中间留个白芯，缩到 64px 也认得出它是不同的那个。
    hx, hy = spots[0][0], spots[0][1]
    d.ellipse((S(hx - 7), S(hy - 7), S(hx + 7), S(hy + 7)), fill=PAPER)

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT, 'PNG', optimize=True)
    # 控制台是 GBK，别打印对勾这类非 GBK 字符
    kb = OUT.stat().st_size / 1024
    print(f'[ok] {OUT.relative_to(ROOT)}  {SIZE}x{SIZE}  {kb:.1f} KB')
    if kb > 512:
        raise SystemExit('[fail] 超过 512KB，市场会拒收')


if __name__ == '__main__':
    main()
