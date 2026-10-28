"""把 docs/frames/*.jpg 合成 docs/demo.gif（等比缩放到 960 宽，10fps 左右）。"""
import glob
import os
from PIL import Image

FRAMES = sorted(glob.glob("docs/frames/*.jpg"))
WIDTH = 960
DELAY = 120  # ms/帧

frames = []
for p in FRAMES:
    im = Image.open(p).convert("RGB")
    h = round(im.height * WIDTH / im.width)
    im = im.resize((WIDTH, h), Image.LANCZOS)
    frames.append(im)

# 用第一帧做全局调色板，避免逐帧调色板造成的闪烁
pal = frames[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
pframes = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]

out = "docs/demo.gif"
pframes[0].save(
    out,
    save_all=True,
    append_images=pframes[1:],
    duration=DELAY,
    loop=0,
    optimize=True,
    disposal=2,
)
print(f"{out}: {len(pframes)} frames, {WIDTH}x{frames[0].height}, {os.path.getsize(out)/1024:.0f}KB")
