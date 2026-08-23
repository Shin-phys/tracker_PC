"""
tracker.ts と同じ手順で位置を推定し、既知の真値と比べる。

再現しているもの
  ・グレースケール（マーカーは無彩色なので変換式の差は出ない）
  ・cv2.matchTemplate(..., TM_CCOEFF_NORMED)
  ・相関マップのピーク近傍 3x3 への 2 次曲面フィット（閉形式）
  ・1px を超えたら 1 次元放物線へフォールバック

画像の作り方
  SS 倍の座標系で描いてから INTER_AREA で縮小する。
  実際のカメラの画素は面積積分なので、これが物理的に正しい標本化になる。
  マーカーは SS 倍座標の整数位置に置くので、1x でのサブピクセル位置は
  必ず k/SS。真値は丸めではなく厳密に決まる。
"""
import numpy as np
import cv2
from markers import draw_marker

SS = 10                 # スーパーサンプリング倍率（真値の刻みは 1/SS px）
SCENE = 128             # 1x でのシーン一辺 [px]
CENTER = 64.0           # マーカーの基準位置（1x）


# ---------------------------------------------------------------- 背景
def make_background(kind, rng):
    n = SCENE * SS
    if kind == 'plain':
        return np.full((n, n), 110.0, np.float32)
    if kind == 'textured':
        # 低周波のむら。実験室の壁や机の面に相当する
        small = rng.normal(0, 1, (SCENE // 4, SCENE // 4)).astype(np.float32)
        big = cv2.resize(small, (n, n), interpolation=cv2.INTER_CUBIC)
        return (110.0 + 25.0 * big).astype(np.float32)
    if kind == 'ruled':
        # 方眼紙。直線が多いので十字が紛れやすいはず、という仮説の検証用
        bg = np.full((n, n), 205.0, np.float32)
        lw = SS                      # 線幅 1px（実寸）。細すぎるとボケで消えて
        for i in range(0, SCENE, 10):  # 「無地の背景」を測っているだけになる
            bg[i * SS:i * SS + lw, :] = 105.0
            bg[:, i * SS:i * SS + lw] = 105.0
        return bg
    raise ValueError(kind)


# ---------------------------------------------------------------- 撮像
def draw_body(canvas, cx, cy, side_ss, tex):
    """
    マーカーを貼ってある「物体そのもの」。マーカーと一緒に動く。
    これを入れないと、枠の中の周辺はすべて動かない背景になり、
    現実より不利な条件で測ることになる（台車の車体、球の表面など）。
    """
    h = int(round(side_ss / 2))
    x0, y0 = int(round(cx)) - h, int(round(cy)) - h
    H, W = canvas.shape
    a0, b0 = max(0, x0), max(0, y0)
    a1, b1 = min(W, x0 + 2 * h), min(H, y0 + 2 * h)
    if a1 <= a0 or b1 <= b0:
        return
    patch = tex[(b0 - y0):(b0 - y0) + (b1 - b0), (a0 - x0):(a0 - x0) + (a1 - a0)]
    canvas[b0:b1, a0:a1] = patch


def render(bg_ss, kind, D, dx, dy, blur, motion, noise, rng, angle=0.0,
           body=0.0, body_tex=None):
    """
    dx, dy は 1x での変位。1/SS の倍数を渡すこと（真値が厳密になる）。
    blur   : レンズのボケ（ガウス σ, 1x px）
    motion : 露光中の水平移動量（1x px）
    noise  : センサノイズ（σ, 0-255）
    body   : マーカーを載せた物体の一辺（D の倍数）。0 なら物体を描かない
    """
    canvas = bg_ss.copy()
    cx = (CENTER + dx) * SS
    cy = (CENTER + dy) * SS
    if body > 0 and body_tex is not None:
        draw_body(canvas, cx, cy, body * D * SS, body_tex)
    draw_marker(canvas, kind, cx, cy, D * SS, SS, angle)

    if motion > 0:
        k = max(1, int(round(motion * SS)))
        canvas = cv2.blur(canvas, (k, 1))
    if blur > 0:
        s = blur * SS
        k = int(2 * round(3 * s) + 1)
        canvas = cv2.GaussianBlur(canvas, (k, k), s)

    img = cv2.resize(canvas, (SCENE, SCENE), interpolation=cv2.INTER_AREA)
    if noise > 0:
        img = img + rng.normal(0, noise, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8)


# ------------------------------------------------- サブピクセル（tracker.ts と同じ）
def _parabolic(res, mx, my):
    h, w = res.shape
    dx = dy = 0.0
    if 0 < mx < w - 1:
        a, b, c = res[my, mx - 1], res[my, mx], res[my, mx + 1]
        d = a - 2 * b + c
        if abs(d) > 1e-12:
            dx = 0.5 * (a - c) / d
    if 0 < my < h - 1:
        a, b, c = res[my - 1, mx], res[my, mx], res[my + 1, mx]
        d = a - 2 * b + c
        if abs(d) > 1e-12:
            dy = 0.5 * (a - c) / d
    return float(np.clip(dx, -1, 1)), float(np.clip(dy, -1, 1))


def quadratic_peak(res, mx, my):
    h, w = res.shape
    if not (0 < mx < w - 1 and 0 < my < h - 1):
        return _parabolic(res, mx, my)
    z0, z1, z2 = res[my - 1, mx - 1], res[my - 1, mx], res[my - 1, mx + 1]
    z3, z4, z5 = res[my,     mx - 1], res[my,     mx], res[my,     mx + 1]
    z6, z7, z8 = res[my + 1, mx - 1], res[my + 1, mx], res[my + 1, mx + 1]
    a = (z0 + z2 + z3 + z5 + z6 + z8) / 6 - (z1 + z4 + z7) / 3
    b = (z0 + z1 + z2 + z6 + z7 + z8) / 6 - (z3 + z4 + z5) / 3
    c = (z0 - z2 - z6 + z8) / 4
    d = (-z0 + z2 - z3 + z5 - z6 + z8) / 6
    e = (-z0 - z1 - z2 + z6 + z7 + z8) / 6
    det = 4 * a * b - c * c
    if not (det > 1e-12) or a >= 0 or b >= 0:
        return _parabolic(res, mx, my)
    dx = (-2 * b * d + c * e) / det
    dy = (c * d - 2 * a * e) / det
    if not (np.isfinite(dx) and np.isfinite(dy)) or abs(dx) > 1 or abs(dy) > 1:
        return _parabolic(res, mx, my)
    return float(dx), float(dy)


def peak_to_sidelobe(res, mx, my, exclude=5):
    """
    最良ピークと、そこから離れた場所の 2 番目のピークの比。
    小さいほど「他の場所とも似ている」＝追跡が飛びやすい。
    """
    r = res.copy()
    h, w = r.shape
    y0, y1 = max(0, my - exclude), min(h, my + exclude + 1)
    x0, x1 = max(0, mx - exclude), min(w, mx + exclude + 1)
    peak = float(r[my, mx])
    r[y0:y1, x0:x1] = -1e9
    second = float(r.max())
    return peak, second


# ---------------------------------------------------------------- 追跡 1 回
def locate(template, tw, th, search):
    """search 全体の中でテンプレートを探し、サブピクセル中心を返す"""
    res = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
    _, maxv, _, maxloc = cv2.minMaxLoc(res)
    mx, my = maxloc
    dx, dy = quadratic_peak(res, mx, my)
    cx = mx + dx + tw / 2.0
    cy = my + dy + th / 2.0
    peak, second = peak_to_sidelobe(res, mx, my)
    return cx, cy, float(maxv), peak, second


def make_body_texture(side_ss, rng, base=75.0, amp=18.0):
    """物体の表面。無地だと現実より有利になるので、軽く模様を入れる"""
    n = int(round(side_ss))
    small = rng.normal(0, 1, (max(4, n // 40), max(4, n // 40))).astype(np.float32)
    big = cv2.resize(small, (n, n), interpolation=cv2.INTER_CUBIC)
    return (base + amp * big).astype(np.float32)


def make_template(img, D, factor=1.4):
    """
    枠の大きさ = factor × D。
    既定の 1.4 は README の「シールの周りの模様が少し入るくらい」に相当する。
    偶数にそろえて、枠の中心が CENTER にちょうど乗るようにする。
    """
    S = int(round(D * factor))
    if S % 2 == 1:
        S += 1
    x0 = int(CENTER) - S // 2
    return img[x0:x0 + S, x0:x0 + S].copy(), S
