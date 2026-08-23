"""
マーカー形状の生成。

すべて「一辺 D のシール」として同じ面積を占めるように描く。
比較の土俵をそろえないと、単に大きいマーカーが有利になるだけになる。

描画は SS 倍のスーパーサンプリング座標系で行い、あとで INTER_AREA で
縮小する。これで任意のサブピクセル位置に正確に置ける
（実際のカメラの画素は面積積分なので、INTER_AREA が物理的にも正しい）。
"""
import numpy as np
import cv2

# 紙とインクの輝度。印刷物の実測に近い値
PAPER = 235
INK = 25


def _disc(canvas, cx, cy, r, value):
    cv2.circle(canvas, (int(round(cx)), int(round(cy))), int(round(r)),
               float(value), -1, lineType=cv2.LINE_8)


def draw_marker(canvas, kind, cx, cy, D, ss, angle_deg=0.0):
    """
    canvas: SS 倍解像度の float32 画像（背景が描かれている）
    cx, cy: マーカー中心（SS 倍座標）
    D:      シールの外径 / 一辺（SS 倍）
    """
    # マーカーだけを別レイヤに描いてから回転させる。
    # 背景ごと回すと背景の模様まで回ってしまう。
    pad = int(np.ceil(D * 0.75)) + 4
    size = 2 * pad
    layer = np.zeros((size, size), np.float32)
    alpha = np.zeros((size, size), np.float32)
    c = pad
    R = D / 2.0

    if kind == 'white_dot':
        # 現行の運用: 白い丸シールをそのまま貼る
        _disc(alpha, c, c, R, 1.0)
        _disc(layer, c, c, R, PAPER)

    elif kind == 'black_dot':
        # 白い丸シールに黒い丸を印刷（単純だが等方的で高コントラスト）
        _disc(alpha, c, c, R, 1.0)
        _disc(layer, c, c, R, PAPER)
        _disc(layer, c, c, R * 0.60, INK)

    elif kind in ('cross_thin', 'cross_thick'):
        # 白い正方形シールに黒い十字
        wfrac = 0.125 if kind == 'cross_thin' else 0.25
        arm = D * wfrac / 2.0
        x0, x1 = int(round(c - R)), int(round(c + R))
        alpha[x0:x1, x0:x1] = 1.0
        layer[x0:x1, x0:x1] = PAPER
        a0, a1 = int(round(c - arm)), int(round(c + arm))
        layer[x0:x1, a0:a1] = INK   # 縦棒
        layer[a0:a1, x0:x1] = INK   # 横棒

    elif kind == 'quad_circle':
        # 白黒4分割の円（写真測量で標準的なターゲット）
        _disc(alpha, c, c, R, 1.0)
        _disc(layer, c, c, R, PAPER)
        m = np.zeros((size, size), np.float32)
        yy, xx = np.mgrid[0:size, 0:size]
        q = ((xx >= c) ^ (yy >= c))
        m[q] = 1.0
        d = np.zeros((size, size), np.float32)
        _disc(d, c, c, R, 1.0)
        layer[(m > 0) & (d > 0)] = INK

    elif kind == 'checker':
        # 2x2 市松の正方形（校正ボードの角と同じ構造）
        x0, x1 = int(round(c - R)), int(round(c + R))
        alpha[x0:x1, x0:x1] = 1.0
        layer[x0:x1, x0:x1] = PAPER
        ci = int(round(c))
        layer[x0:ci, x0:ci] = INK
        layer[ci:x1, ci:x1] = INK

    elif kind == 'bullseye':
        # 同心円。回転しても模様が変わらない
        _disc(alpha, c, c, R, 1.0)
        _disc(layer, c, c, R, PAPER)
        _disc(layer, c, c, R * 0.62, INK)
        _disc(layer, c, c, R * 0.31, PAPER)

    else:
        raise ValueError(kind)

    if abs(angle_deg) > 1e-9:
        M = cv2.getRotationMatrix2D((c, c), angle_deg, 1.0)
        layer = cv2.warpAffine(layer, M, (size, size), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        alpha = cv2.warpAffine(alpha, M, (size, size), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    # canvas へ合成。中心が (cx, cy) に来るように整数位置へ置き、
    # 端数はレイヤ側の描画位置ではなくここで扱う……のではなく、
    # 呼び出し側が cx, cy を SS 倍座標で渡すので、丸め誤差は 1/SS px に収まる。
    ox = int(round(cx)) - c
    oy = int(round(cy)) - c
    H, W = canvas.shape
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(W, ox + size), min(H, oy + size)
    if x1 <= x0 or y1 <= y0:
        return
    sx0, sy0 = x0 - ox, y0 - oy
    sx1, sy1 = sx0 + (x1 - x0), sy0 + (y1 - y0)
    a = alpha[sy0:sy1, sx0:sx1]
    l = layer[sy0:sy1, sx0:sx1]
    canvas[y0:y1, x0:x1] = canvas[y0:y1, x0:x1] * (1 - a) + l * a


MARKERS = [
    ('white_dot',   '白い丸シール（現行）'),
    ('black_dot',   '白シール＋黒丸'),
    ('cross_thin',  '十字（腕 D/8）'),
    ('cross_thick', '十字（腕 D/4）'),
    ('quad_circle', '白黒4分割の円'),
    ('checker',     '2×2 市松の正方形'),
    ('bullseye',    '同心円'),
]
