"""レポートに載せるマーカーの見本画像（実際の描画エンジンで作る）"""
import numpy as np, cv2, engine, base64, json
from markers import MARKERS
engine.SCENE = 96; engine.CENTER = 48.0
rng = np.random.default_rng(3)
bg = engine.make_background('plain', rng)
out = {}
for kind, label in MARKERS:
    # 大きく描いて形が分かるようにする（拡大は最近傍で、画素の姿をそのまま見せる）
    img = engine.render(bg, kind, 30, 0, 0, 0.6, 0, 0, rng)
    crop = img[48-24:48+24, 48-24:48+24]
    big = cv2.resize(crop, (192, 192), interpolation=cv2.INTER_NEAREST)
    ok, buf = cv2.imencode('.png', big)
    out[kind] = base64.b64encode(buf.tobytes()).decode()
json.dump(out, open('previews.json', 'w'))
print('previews:', list(out), 'bytes', sum(len(v) for v in out.values()))
