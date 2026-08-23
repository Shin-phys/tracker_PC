# -*- coding: utf-8 -*-
"""レポート用の SVG。色は CSS 変数で指す（テーマ切替に追随させるため）。"""
import json
from markers import MARKERS

LABEL = dict(MARKERS)
SHORT = {
    'white_dot': '白い丸（現行）', 'black_dot': '白地に黒丸',
    'cross_thin': '十字 細 D/8', 'cross_thick': '十字 太 D/4',
    'quad_circle': '白黒4分割', 'checker': '2×2 市松', 'bullseye': '同心円',
}


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def hbar(rows, vmax, unit, caption, highlight=None, fmt='{:.3f}'):
    """rows: [(label, value, tooltip)] 昇順で渡す"""
    W, L, R = 760, 150, 78
    rowh, top, bot = 38, 8, 52
    plot = W - L - R
    H = top + rowh * len(rows) + bot
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" '
         f'aria-label="{esc(caption)}" class="chart">']
    # 目盛り
    ticks = 5
    for i in range(ticks + 1):
        v = vmax * i / ticks
        x = L + plot * i / ticks
        o.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + rowh*len(rows)}" '
                 f'class="grid"/>')
        o.append(f'<text x="{x:.1f}" y="{top + rowh*len(rows) + 20}" class="tick" '
                 f'text-anchor="middle">{v:.2f}</text>')
    for i, (lab, val, tip) in enumerate(rows):
        y = top + i * rowh
        w = max(2.5, plot * val / vmax)
        cls = 'bar bar--hi' if lab == highlight else 'bar'
        o.append(f'<g><title>{esc(tip)}</title>')
        o.append(f'<text x="{L-12}" y="{y+rowh/2+5}" class="cat" text-anchor="end">{esc(lab)}</text>')
        o.append(f'<rect x="{L}" y="{y+7}" width="{w:.1f}" height="{rowh-14}" rx="4" class="{cls}"/>')
        o.append(f'<text x="{L+w+9:.1f}" y="{y+rowh/2+5}" class="val">{fmt.format(val)}</text>')
        o.append('</g>')
    o.append(f'<text x="{L + plot/2:.0f}" y="{H-8}" class="axis" text-anchor="middle">{esc(unit)}</text>')
    o.append('</svg>')
    return '\n'.join(o)


def grouped(rows, vmax, unit, caption, s1, s2, refline=None, reflabel=''):
    """rows: [(label, v1, v2)]"""
    W, L, R = 760, 150, 60
    rowh, gap, top, bot = 44, 4, 10, 52
    plot = W - L - R
    H = top + rowh * len(rows) + bot
    bh = (rowh - gap - 10) / 2
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" '
         f'aria-label="{esc(caption)}" class="chart">']
    for i in range(6):
        x = L + plot * i / 5
        o.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top+rowh*len(rows)}" class="grid"/>')
        o.append(f'<text x="{x:.1f}" y="{top+rowh*len(rows)+20}" class="tick" text-anchor="middle">'
                 f'{vmax*i/5:.1f}</text>')
    if refline is not None:
        x = L + plot * refline / vmax
        o.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top+rowh*len(rows)}" class="ref"/>')
        o.append(f'<text x="{x+6:.1f}" y="{top+12}" class="reflab">{esc(reflabel)}</text>')
    for i, (lab, v1, v2) in enumerate(rows):
        y = top + i * rowh + 5
        for k, (v, cls, nm) in enumerate(((v1, 'ser1', s1), (v2, 'ser2', s2))):
            w = max(2.5, plot * v / vmax)
            yy = y + k * (bh + gap)
            o.append(f'<g><title>{esc(lab)} — {esc(nm)}: {v:.3f}</title>'
                     f'<rect x="{L}" y="{yy:.1f}" width="{w:.1f}" height="{bh:.1f}" rx="3.5" class="{cls}"/>'
                     f'<text x="{L+w+8:.1f}" y="{yy+bh/2+4:.1f}" class="val val--sm">{v:.2f}</text></g>')
        o.append(f'<text x="{L-12}" y="{y+rowh/2:.0f}" class="cat" text-anchor="end">{esc(lab)}</text>')
    o.append(f'<text x="{L+plot/2:.0f}" y="{H-8}" class="axis" text-anchor="middle">{esc(unit)}</text>')
    o.append('</svg>')
    return '\n'.join(o)


def lines(series, xs, ymax, xlabel, ylabel, caption, ylog=False):
    """series: [(name, cls, [y...], [(lo,hi)...] or None)]"""
    import math
    W, L, R, T, B = 760, 74, 132, 16, 46
    H = 340
    pw, ph = W - L - R, H - T - B

    def yy(v):
        if ylog:
            lo, hi = math.log10(0.006), math.log10(ymax)
            t = (math.log10(max(v, 0.006)) - lo) / (hi - lo)
        else:
            t = v / ymax
        return T + ph * (1 - t)

    def xx(i):
        return L + pw * i / (len(xs) - 1)

    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" '
         f'aria-label="{esc(caption)}" class="chart">']
    gl = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5] if ylog else [ymax*i/5 for i in range(6)]
    for g in gl:
        y = yy(g)
        o.append(f'<line x1="{L}" y1="{y:.1f}" x2="{L+pw}" y2="{y:.1f}" class="grid"/>')
        o.append(f'<text x="{L-10}" y="{y+4:.1f}" class="tick" text-anchor="end">{g:g}</text>')
    for i, x in enumerate(xs):
        o.append(f'<text x="{xx(i):.1f}" y="{T+ph+22}" class="tick" text-anchor="middle">{esc(str(x))}</text>')
    for name, cls, ys, band in series:
        if band:
            up = ' '.join(f'{xx(i):.1f},{yy(b[1]):.1f}' for i, b in enumerate(band))
            dn = ' '.join(f'{xx(i):.1f},{yy(b[0]):.1f}' for i, b in reversed(list(enumerate(band))))
            o.append(f'<polygon points="{up} {dn}" class="band {cls}"/>')
        pts = ' '.join(f'{xx(i):.1f},{yy(v):.1f}' for i, v in enumerate(ys))
        o.append(f'<polyline points="{pts}" class="line {cls}"/>')
        for i, v in enumerate(ys):
            o.append(f'<g><title>{esc(name)} 枠 ×{xs[i]}: {v:.4f} px</title>'
                     f'<circle cx="{xx(i):.1f}" cy="{yy(v):.1f}" r="5" class="dot {cls}"/></g>')
        o.append(f'<text x="{L+pw+10:.0f}" y="{yy(ys[-1])+4:.1f}" class="dlabel {cls}">{esc(name)}</text>')
    o.append(f'<text x="{L+pw/2:.0f}" y="{H-6}" class="axis" text-anchor="middle">{esc(xlabel)}</text>')
    o.append(f'<text x="14" y="{T+ph/2:.0f}" class="axis" text-anchor="middle" '
             f'transform="rotate(-90 14 {T+ph/2:.0f})">{esc(ylabel)}</text>')
    o.append('</svg>')
    return '\n'.join(o)
