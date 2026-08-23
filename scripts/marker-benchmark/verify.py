"""ベンチマーク自体が正しく測れているかの点検"""
import numpy as np, engine
from markers import MARKERS
engine.SCENE = 96; engine.CENTER = 48.0
SS, CENTER = engine.SS, engine.CENTER
D = 30

print('■ 1. ヌルテスト（ノイズ 0・無地背景・変位 0 なら誤差はゼロのはず）')
rng = np.random.default_rng(0)
bg = engine.make_background('plain', rng)
for kind, _ in MARKERS:
    ref = engine.render(bg, kind, D, 0, 0, 0.8, 0, 0.0, rng)
    t, S = engine.make_template(ref, D)
    cx, cy, sc, _, _ = engine.locate(t, S, S, ref)
    print(f'   {kind:12s} err=({cx-CENTER:+.6f}, {cy-CENTER:+.6f}) score={sc:.4f}')

print('\n■ 2. 既知の変位をノイズ 0 で復元できるか（推定量そのものの偏り）')
for kind in ['white_dot', 'cross_thick', 'bullseye']:
    errs = []
    for k in range(1, 10):
        d = k / SS
        ref = engine.render(bg, kind, D, 0, 0, 0.8, 0, 0.0, rng)
        t, S = engine.make_template(ref, D)
        test = engine.render(bg, kind, D, d, 0, 0.8, 0, 0.0, rng)
        cx, _, _, _, _ = engine.locate(t, S, S, test)
        errs.append(cx - (CENTER + d))
    print(f'   {kind:12s} 最大 {max(abs(e) for e in errs):.4f} px '
          f'（ノイズが無くても残る分＝ピクセルロッキング）')

print('\n■ 3. ボケを強くするとピクセルロッキングは減るか（理論の予測）')
for blur in [0.4, 0.8, 1.5, 2.5]:
    row = []
    for kind in ['white_dot', 'cross_thick']:
        errs = []
        for k in range(1, 10):
            d = k / SS
            ref = engine.render(bg, kind, D, 0, 0, blur, 0, 0.0, rng)
            t, S = engine.make_template(ref, D)
            test = engine.render(bg, kind, D, d, 0, blur, 0, 0.0, rng)
            cx, _, _, _, _ = engine.locate(t, S, S, test)
            errs.append(cx - (CENTER + d))
        row.append(max(abs(e) for e in errs))
    print(f'   ボケ σ={blur:<4} 白丸 {row[0]:.4f} px / 十字(太) {row[1]:.4f} px')

print('\n■ 4. 種を変えても順位は変わらないか（base 条件）')
import bench
bench.N_TRIALS = 120
for tag, off in [('種A', 1000), ('種B', 55000), ('種C', 99000)]:
    r = [(k, bench.run_cell(k, bench.CONDITIONS[0], off + i)['rms'])
         for i, (k, _) in enumerate(MARKERS)]
    order = ' > '.join(k for k, _ in sorted(r, key=lambda x: x[1]))
    print(f'   {tag}: {order}')
