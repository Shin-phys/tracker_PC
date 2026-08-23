"""
マーカー形状のベンチマーク本体。

測るもの
  rms       : 位置推定の誤差 [px]（サブピクセル精度そのもの）
  fail_rate : 1px 以上外した割合（＝そもそも捕まえ損ねた割合）
  score     : TM_CCOEFF_NORMED の一致度（lostThreshold 0.45 との距離）
  margin    : 最良ピーク − 離れた場所の 2 番目のピーク
              小さいほど「他の場所とも似ている」＝軌跡が飛びやすい
"""
import sys, json, time
import numpy as np
import engine
from markers import MARKERS

engine.SCENE = 96
engine.CENTER = 48.0
SS = engine.SS
CENTER = engine.CENTER

CONDITIONS = [
    # name,            bg,         D,  blur, motion, noise, angle
    ('base',          'textured',  30, 0.8,  0.0,    3.0,   0.0),
    ('plain',         'plain',     30, 0.8,  0.0,    3.0,   0.0),
    ('blur',          'textured',  30, 2.5,  0.0,    3.0,   0.0),
    ('noise',         'textured',  30, 0.8,  0.0,   10.0,   0.0),
    ('small',         'textured',  16, 0.8,  0.0,    3.0,   0.0),
    ('motion',        'textured',  30, 0.8,  5.0,    3.0,   0.0),
    ('ruled',         'ruled',     30, 0.8,  0.0,    3.0,   0.0),
    ('rot15',         'textured',  30, 0.8,  0.0,    3.0,  15.0),
]
COND_LABEL = {
    'base':   '標準（ピント良好・低ノイズ・静止）',
    'plain':  '無地の背景（枠内に模様が入らない）',
    'blur':   'ピントが甘い（σ 2.5px）',
    'noise':  'ノイズが多い（σ 10 / 暗所）',
    'small':  'マーカーが小さい（D 16px）',
    'motion': 'モーションブラー（露光中 5px 移動）',
    'ruled':  '方眼紙の背景（直線が多い）',
    'rot15':  '物体が 15° 回転した',
}

N_TRIALS = 150
N_BG = 5


def run_cell(kind, cond, seed):
    name, bgk, D, blur, motion, noise, angle = cond
    rng = np.random.default_rng(seed)
    bgs = [engine.make_background(bgk, np.random.default_rng(seed * 977 + i))
           for i in range(N_BG)]

    errs, scores, margins = [], [], []
    for t in range(N_TRIALS):
        bg = bgs[t % N_BG]
        # 枠を引いた瞬間のコマ（テンプレートはここから作られる）
        ref = engine.render(bg, kind, D, 0.0, 0.0, blur, motion, noise, rng, 0.0)
        tmpl, S = engine.make_template(ref, D)
        # 真の変位。1/SS の倍数に丸めるので真値は厳密
        dx = round(rng.uniform(-2, 2) * SS) / SS
        dy = round(rng.uniform(-2, 2) * SS) / SS
        test = engine.render(bg, kind, D, dx, dy, blur, motion, noise, rng, angle)
        cx, cy, sc, peak, second = engine.locate(tmpl, S, S, test)
        errs.append((cx - (CENTER + dx), cy - (CENTER + dy)))
        scores.append(sc)
        margins.append(peak - second)

    e = np.array(errs)
    r = np.hypot(e[:, 0], e[:, 1])
    ok = r < 1.0
    return {
        'marker': kind, 'cond': name,
        'rms': float(np.sqrt(np.mean(r[ok] ** 2))) if ok.any() else float('nan'),
        'rms_all': float(np.sqrt(np.mean(r ** 2))),
        'fail_rate': float(1 - ok.mean()),
        'score': float(np.mean(scores)),
        'score_min': float(np.min(scores)),
        'margin': float(np.mean(margins)),
        'n': int(N_TRIALS),
    }


def run_bias(kind, cond, seed, reps=30):
    """真の変位の端数に対する誤差の平均＝ピクセルロッキングの S 字"""
    name, bgk, D, blur, motion, noise, angle = cond
    rng = np.random.default_rng(seed)
    bgs = [engine.make_background(bgk, np.random.default_rng(seed * 131 + i))
           for i in range(N_BG)]
    fracs = [i / 10 for i in range(11)]
    out = []
    for f in fracs:
        acc = []
        for t in range(reps):
            bg = bgs[t % N_BG]
            ref = engine.render(bg, kind, D, 0.0, 0.0, blur, motion, noise, rng, 0.0)
            tmpl, S = engine.make_template(ref, D)
            test = engine.render(bg, kind, D, f, 0.0, blur, motion, noise, rng, angle)
            cx, cy, sc, _, _ = engine.locate(tmpl, S, S, test)
            acc.append(cx - (CENTER + f))
        out.append({'frac': f, 'bias': float(np.mean(acc)), 'sd': float(np.std(acc))})
    return out


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'main'
    t0 = time.time()
    if which == 'main':
        rows = []
        for ci, cond in enumerate(CONDITIONS):
            for mi, (kind, _label) in enumerate(MARKERS):
                rows.append(run_cell(kind, cond, seed=1000 + ci * 17 + mi))
                print(f'  {cond[0]:8s} {kind:12s} '
                      f'rms={rows[-1]["rms"]:.4f} fail={rows[-1]["fail_rate"]:.3f} '
                      f'score={rows[-1]["score"]:.3f} margin={rows[-1]["margin"]:.3f}',
                      flush=True)
        json.dump(rows, open('results_main.json', 'w'), indent=1)
    else:
        base = CONDITIONS[0]
        out = {}
        for mi, (kind, _l) in enumerate(MARKERS):
            out[kind] = run_bias(kind, base, seed=2000 + mi)
            amp = max(abs(p['bias']) for p in out[kind])
            print(f'  bias {kind:12s} 最大 {amp:.4f} px', flush=True)
        json.dump(out, open('results_bias.json', 'w'), indent=1)
    print('elapsed', round(time.time() - t0, 1), 's')
