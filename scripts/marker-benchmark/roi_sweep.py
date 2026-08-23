"""
枠の大きさ（マーカー径に対する倍率）を、物体の有無で振る。

狙い
  枠に写り込んだ「動かない背景」はマーカーと一緒に動かないので、
  次のコマでは必ずずれている。周りを入れるほど照合の足を引っ張るはず。
  一方で周りを入れないと枠が「どこにでも一致」しやすくなる。
  さらに現実では、シールは動く物体の上にあるので、周りの一部は
  マーカーと一緒に動く。この 3 つ目の要素で結論が変わるかを見る。

  on_object=False : シールが静止背景に直接貼ってある（不利な想定）
  on_object=True  : シールが動く物体（一辺 2.5D）の上にある（現実に近い）
"""
import json
import numpy as np
import engine

engine.SCENE = 96
engine.CENTER = 48.0
SS, CENTER = engine.SS, engine.CENTER

FACTORS = [1.0, 1.15, 1.4, 1.7, 2.0]
KINDS = ['white_dot', 'cross_thick', 'quad_circle', 'bullseye']
D = 30
BODY = 2.5          # 物体の一辺 = 2.5D（枠 2.0D まで完全に覆う）
N = 150
N_BG = 5


def cell(kind, factor, on_object, seed):
    rng = np.random.default_rng(seed)
    bgs = [engine.make_background('textured', np.random.default_rng(seed * 31 + i))
           for i in range(N_BG)]
    tex = engine.make_body_texture(BODY * D * SS, np.random.default_rng(seed + 7))
    errs, margins, scores = [], [], []
    S = 0
    for t in range(N):
        bg = bgs[t % N_BG]
        kw = dict(body=BODY, body_tex=tex) if on_object else {}
        ref = engine.render(bg, kind, D, 0.0, 0.0, 0.8, 0.0, 3.0, rng, **kw)
        tmpl, S = engine.make_template(ref, D, factor)
        dx = round(rng.uniform(-2, 2) * SS) / SS
        dy = round(rng.uniform(-2, 2) * SS) / SS
        test = engine.render(bg, kind, D, dx, dy, 0.8, 0.0, 3.0, rng, **kw)
        cx, cy, sc, peak, second = engine.locate(tmpl, S, S, test)
        errs.append((cx - (CENTER + dx), cy - (CENTER + dy)))
        margins.append(peak - second)
        scores.append(sc)
    e = np.array(errs)
    r = np.hypot(e[:, 0], e[:, 1])
    ok = r < 1.0
    return {'marker': kind, 'factor': factor, 'roi_px': int(S),
            'on_object': on_object,
            'rms': float(np.sqrt(np.mean(r[ok] ** 2))) if ok.any() else float('nan'),
            'fail_rate': float(1 - ok.mean()),
            'margin': float(np.mean(margins)),
            'score': float(np.mean(scores))}


if __name__ == '__main__':
    rows = []
    for on_obj in (False, True):
        for ki, k in enumerate(KINDS):
            for fi, f in enumerate(FACTORS):
                rows.append(cell(k, f, on_obj, 3000 + ki * 13 + fi))
                r = rows[-1]
                tag = '物体あり' if on_obj else '背景直貼り'
                print(f'  {tag} {k:12s} x{f:<5} 枠{r["roi_px"]:3d}px  '
                      f'rms={r["rms"]:.4f} margin={r["margin"]:.3f} '
                      f'fail={r["fail_rate"]:.3f}', flush=True)
    json.dump(rows, open('results_roi.json', 'w'), indent=1)
