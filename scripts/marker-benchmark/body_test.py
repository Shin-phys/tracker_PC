"""
物体の表面が「のっぺりしている」場合。

実験室の台車や球は、たいてい単色のプラスチックで模様がない。
その場合、枠の中で位置を決められる情報はマーカーの模様しか無い。
物体の模様が豊かな場合と比べて、形状の差がどう出るかを見る。
"""
import json
import numpy as np
import engine
from markers import MARKERS

engine.SCENE = 96; engine.CENTER = 48.0
SS, CENTER = engine.SS, engine.CENTER
D, BODY, N = 30, 2.5, 150

CASES = [
    ('body_plain', 3.0,  '物体が単色（模様のない台車・球）'),
    ('body_tex',  18.0,  '物体に模様がある（木目・ラベル・ネジ）'),
]

rows = []
for tag, amp, label in CASES:
    for mi, (kind, _l) in enumerate(MARKERS):
        seed = 4000 + mi
        rng = np.random.default_rng(seed)
        bgs = [engine.make_background('textured', np.random.default_rng(seed * 31 + i))
               for i in range(5)]
        tex = engine.make_body_texture(BODY * D * SS, np.random.default_rng(seed + 7),
                                       base=75.0, amp=amp)
        errs, scores, margins = [], [], []
        for t in range(N):
            bg = bgs[t % 5]
            ref = engine.render(bg, kind, D, 0, 0, 0.8, 0, 3.0, rng, body=BODY, body_tex=tex)
            tmpl, S = engine.make_template(ref, D)
            dx = round(rng.uniform(-2, 2) * SS) / SS
            dy = round(rng.uniform(-2, 2) * SS) / SS
            test = engine.render(bg, kind, D, dx, dy, 0.8, 0, 3.0, rng, body=BODY, body_tex=tex)
            cx, cy, sc, peak, second = engine.locate(tmpl, S, S, test)
            errs.append((cx - (CENTER + dx), cy - (CENTER + dy)))
            scores.append(sc); margins.append(peak - second)
        e = np.array(errs); r = np.hypot(e[:, 0], e[:, 1]); ok = r < 1.0
        row = {'case': tag, 'label': label, 'marker': kind,
               'rms': float(np.sqrt(np.mean(r[ok] ** 2))),
               'fail_rate': float(1 - ok.mean()),
               'score': float(np.mean(scores)), 'margin': float(np.mean(margins))}
        rows.append(row)
        print(f'  {tag:11s} {kind:12s} rms={row["rms"]:.4f} '
              f'margin={row["margin"]:.3f} fail={row["fail_rate"]:.3f}', flush=True)
json.dump(rows, open('results_body.json', 'w'), indent=1)
