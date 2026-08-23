# -*- coding: utf-8 -*-
import json, statistics as st
import charts
from charts import SHORT

main = json.load(open('results_main.json'))
roi  = json.load(open('results_roi.json'))
body = json.load(open('results_body.json'))
prev = json.load(open('previews.json'))

M = {(r['cond'], r['marker']): r for r in main}
ORDER = ['white_dot','black_dot','cross_thin','cross_thick','quad_circle','checker','bullseye']
CONDS = ['base','plain','blur','noise','small','motion','ruled','rot15']
CONDJP = {
 'base':'標準（枠に静止背景が入る）','plain':'無地の背景','blur':'ピントが甘い σ2.5',
 'noise':'ノイズ σ10（暗所）','small':'マーカー小 D16','motion':'モーションブラー 5px',
 'ruled':'方眼紙の背景','rot15':'物体が 15° 回転',
}

# ---- Chart A: base の rms 昇順
rows = sorted([(SHORT[k], M[('base',k)]['rms'],
                f"{SHORT[k]}: RMS {M[('base',k)]['rms']:.4f} px / 一致度 {M[('base',k)]['score']:.3f}")
               for k in ORDER], key=lambda r: r[1])
chartA = charts.hbar(rows, 0.26, '位置の RMS 誤差 [px]（小さいほど良い）',
                     '形状別の位置誤差', highlight='白い丸（現行）')

# ---- Chart B: 枠の倍率
FA = [1.0,1.15,1.4,1.7,2.0]
def agg(on):
    ys, band = [], []
    for f in FA:
        v = [r['rms'] for r in roi if r['on_object']==on and r['factor']==f]
        ys.append(st.mean(v)); band.append((min(v), max(v)))
    return ys, band
y0,b0 = agg(False); y1,b1 = agg(True)
chartB = charts.lines(
    [('静止背景の上','ser2', y0, b0), ('動く物体の上','ser1', y1, b1)],
    FA, 0.7, '枠の大きさ（マーカー径の何倍か）', 'RMS 誤差 [px]',
    '枠の倍率と誤差', ylog=True)

# ---- Chart C: 回転
rowsC = [(SHORT[k], M[('base',k)]['score'], M[('rot15',k)]['score']) for k in ORDER]
chartC = charts.grouped(rowsC, 1.0, 'テンプレートとの一致度（TM_CCOEFF_NORMED）',
                        '回転による一致度の低下', '回転なし', '15° 回転',
                        refline=0.45, reflabel='0.45 未満で LOST 判定')

# ---- 表: 条件 × 形状
def cell(v, lo, hi):
    t = max(0.0, min(1.0, (v - lo) / (hi - lo)))
    return f'style="--t:{t:.3f}"'
tbl = ['<div class="tablewrap"><table class="matrix"><thead><tr><th>条件</th>'
       + ''.join(f'<th>{SHORT[k]}</th>' for k in ORDER) + '</tr></thead><tbody>']
for c in CONDS:
    vals = [M[(c,k)]['rms'] for k in ORDER]
    lo, hi = min(vals), max(vals)
    tbl.append(f'<tr><th scope="row">{CONDJP[c]}</th>')
    for k in ORDER:
        r = M[(c,k)]
        f = r['fail_rate']
        extra = f'<span class="fail">破綻 {f*100:.0f}%</span>' if f > 0.005 else ''
        tbl.append(f'<td {cell(r["rms"], lo, hi)} title="RMS {r["rms"]:.4f} px / '
                   f'一致度 {r["score"]:.3f} / 破綻 {f*100:.1f}%">'
                   f'<span class="num">{r["rms"]:.3f}</span>{extra}</td>')
    tbl.append('</tr>')
tbl.append('</tbody></table></div>')
matrix = '\n'.join(tbl)

# ---- マーカー見本
cards = []
NOTE = {
 'white_dot':'いま使っている白い丸シール。印刷なし。','black_dot':'白い丸シールに黒丸（径 0.6D）。',
 'cross_thin':'白い正方形シールに細い十字。','cross_thick':'白い正方形シールに太い十字。',
 'quad_circle':'写真測量で標準的な 4 分割ターゲット。','checker':'校正ボードの角と同じ構造。',
 'bullseye':'白 D ／ 黒 0.62D ／ 白 0.31D の同心円。',
}
for k in ORDER:
    r = M[('base',k)]
    cards.append(
      f'<figure class="mk"><img src="data:image/png;base64,{prev[k]}" alt="{SHORT[k]}" '
      f'width="192" height="192">'
      f'<figcaption><b>{SHORT[k]}</b><span>{NOTE[k]}</span>'
      f'<span class="mkval">RMS <b>{r["rms"]:.3f}</b> px</span></figcaption></figure>')
gallery = '\n'.join(cards)

json.dump({'chartA':chartA,'chartB':chartB,'chartC':chartC,
           'matrix':matrix,'gallery':gallery},
          open('fragments.json','w'))
print('fragments written',
      {k: len(v) for k, v in json.load(open('fragments.json')).items()})
