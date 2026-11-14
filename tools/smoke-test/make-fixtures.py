"""Создаёт фикстуры для smoke.mjs в tools/smoke-test/out: decals/sponsors PNG, папку скина (с мусорным .dds и UTF-16 конфигом) и модель-коробку."""
import json, os
from PIL import Image, ImageDraw
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(os.path.join(T, "skin", "My Skin"), exist_ok=True)
d = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0)); g = ImageDraw.Draw(d)
g.rectangle((0, 300, 1024, 520), fill=(255, 85, 0, 255)); g.ellipse((600, 100, 900, 400), fill=(255, 255, 255, 255))
s = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0)); ImageDraw.Draw(s).rectangle((100, 600, 500, 700), fill=(0, 160, 255, 255))
for base in (T, os.path.join(T, "skin", "My Skin")):
    d.save(os.path.join(base, "decals.png")); s.save(os.path.join(base, "sponsors.png"))
for n in ("decals_0.dds", "sponsors_1.dds"):
    open(os.path.join(T, "skin", "My Skin", n), "wb").write(b"x" * 10)
cfg = json.dumps({"carModelType": 35, "raceNumber": 77, "customSkinName": "My Skin"}, ensure_ascii=False)
open(os.path.join(T, "skin", "My Skin", "car.json"), "wb").write(b"\xff\xfe" + cfg.encode("utf-16-le"))
x0, x1, y0, y1, z0, z1 = -2.3, 2.3, 0.3, 1.3, -1, 1
v = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
out = ["o body"] + [f"v {a} {b} {c}" for a, b, c in v] + ["vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1"]
for f in [(1,2,3,4),(5,6,7,8),(1,2,6,5),(4,3,7,8),(1,4,8,5),(2,3,7,6)]:
    out.append("f " + " ".join(f"{i}/{k+1}" for k, i in enumerate(f)))
open(os.path.join(T, "model.obj"), "w").write("\n".join(out))
print("fixtures ->", T)
