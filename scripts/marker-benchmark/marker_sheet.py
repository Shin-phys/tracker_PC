# -*- coding: utf-8 -*-
"""
印刷用マーカーシート（A4・実寸）。

ベクタで描いているので、拡大縮小せず「実際のサイズ」で印刷すれば
記載どおりの寸法になる。印刷ダイアログでは必ず
「100%」「実際のサイズ」を選ぶこと（「用紙に合わせる」は不可）。
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
import os
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

# 日本語フォントは可能なら PDF に埋め込む。
# CID フォントの参照だけで済ませると、閲覧環境に Adobe-Japan1 の対応表が無い場合
# （Linux の poppler など）に文字がまったく出ない。
# 環境ごとに置き場所が違うので、見つかったものを使う。
_CANDIDATES = [
    # Linux
    ('/usr/share/fonts/truetype/fonts-japanese-gothic.ttf', 0),
    ('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 0),
    # macOS
    ('/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc', 0),
    ('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
    ('/Library/Fonts/Arial Unicode.ttf', 0),
    # Windows
    ('C:/Windows/Fonts/meiryo.ttc', 0),
    ('C:/Windows/Fonts/YuGothM.ttc', 0),
]


def _register_jp():
    for path, idx in _CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            pdfmetrics.registerFont(TTFont('JPGo', path, subfontIndex=idx))
            return 'JPGo'
        except Exception:
            continue
    # 埋め込めるフォントが見つからなければ CID フォント参照にする。
    # Acrobat / macOS のプレビューなら表示できる。
    pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
    return 'HeiseiKakuGo-W5'


JP = _register_jp()
W, H = A4
CUT = colors.Color(0.72, 0.75, 0.78)
INK = colors.black


# ----------------------------------------------------------- マーカー描画
def cross(c, cx, cy, d):
    r = d / 2.0
    arm = d / 8.0                      # 腕幅 = 径の 1/4 → 片側 1/8
    c.setFillColor(colors.white); c.setStrokeColor(colors.white)
    c.rect(cx - r, cy - r, d, d, stroke=0, fill=1)
    c.setFillColor(INK)
    c.rect(cx - arm, cy - r, 2 * arm, d, stroke=0, fill=1)
    c.rect(cx - r, cy - arm, d, 2 * arm, stroke=0, fill=1)


def bullseye(c, cx, cy, d):
    r = d / 2.0
    c.setFillColor(colors.white); c.circle(cx, cy, r, stroke=0, fill=1)
    c.setFillColor(INK);          c.circle(cx, cy, r * 0.62, stroke=0, fill=1)
    c.setFillColor(colors.white); c.circle(cx, cy, r * 0.31, stroke=0, fill=1)


def blackdot(c, cx, cy, d):
    r = d / 2.0
    c.setFillColor(colors.white); c.circle(cx, cy, r, stroke=0, fill=1)
    c.setFillColor(INK);          c.circle(cx, cy, r * 0.60, stroke=0, fill=1)


def quad(c, cx, cy, d):
    r = d / 2.0
    c.setFillColor(colors.white); c.circle(cx, cy, r, stroke=0, fill=1)
    c.setFillColor(INK); c.setStrokeColor(INK); c.setLineWidth(0)
    # 対角の 2 象限だけ黒く塗る（右上と左下）
    for start in (0, 180):
        c.wedge(cx - r, cy - r, cx + r, cy + r, start, 90, stroke=0, fill=1)


SHAPES = {
    'cross':    (cross,    '十字（太）', '回転しない対象に最良'),
    'bullseye': (bullseye, '同心円',     '回る対象はこれ'),
    'blackdot': (blackdot, '白地に黒丸', '迷ったときの無難な選択'),
    'quad':     (quad,     '白黒4分割',  '写真測量の標準ターゲット'),
}
SIZES = [10, 14, 18, 22, 26, 32]   # mm


def cutmark(c, cx, cy, d):
    """
    四隅のトンボだけを描く。
    マーカーを囲む線を引いてしまうと、その線ごとテンプレートに入り込んで
    模様の一部になる。切る位置さえ分かればよいので、角の短い線で示す。
    """
    c.setStrokeColor(CUT); c.setLineWidth(0.3)
    m = d / 2.0 + 1.2 * mm          # 切り取り位置（周囲 1.2mm の余白を残す）
    t = 2.2 * mm                    # トンボの長さ
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = cx + sx * m, cy + sy * m
            c.line(x, y, x - sx * t, y)
            c.line(x, y, x, y - sy * t)


def header(c, title, sub):
    c.setFillColor(INK)
    c.setFont(JP, 15); c.drawString(18 * mm, H - 20 * mm, title)
    c.setFont(JP, 8.5); c.setFillColor(colors.Color(.3, .33, .36))
    y = H - 27 * mm
    for line in sub:
        c.drawString(18 * mm, y, line); y -= 4.6 * mm
    c.setStrokeColor(colors.Color(.8, .83, .86)); c.setLineWidth(0.5)
    c.line(18 * mm, y - 1 * mm, W - 18 * mm, y - 1 * mm)
    return y - 8 * mm


def sheet(c, kinds, title, sub):
    y = header(c, title, sub)
    for kind in kinds:
        fn, name, note = SHAPES[kind]
        c.setFillColor(INK); c.setFont(JP, 10)
        c.drawString(18 * mm, y, f'{name}  —  {note}')
        y -= 6 * mm
        x = 20 * mm
        rowtop = y
        for d_mm in SIZES:
            d = d_mm * mm
            cx = x + d / 2
            cy = rowtop - 21 * mm
            fn(c, cx, cy, d)
            cutmark(c, cx, cy, d)
            c.setFillColor(colors.Color(.45, .48, .5)); c.setFont(JP, 6.5)
            c.drawCentredString(cx, rowtop - 43 * mm, f'{d_mm} mm')
            x += d + 9 * mm
        y = rowtop - 51 * mm
    return y


def sizing_table(c, y):
    c.setFillColor(INK); c.setFont(JP, 10)
    c.drawString(18 * mm, y, 'どの大きさを使うか')
    y -= 6 * mm
    c.setFont(JP, 8)
    c.setFillColor(colors.Color(.3, .33, .36))
    c.drawString(18 * mm, y,
                 '画面上で 20〜30 px になる大きさにします。'
                 '必要な実寸 = 視野の横幅 [mm] ÷ 横の画素数 [px] × 25')
    y -= 7 * mm
    rows = [('視野の横幅', '1920 px で撮る場合', '推奨サイズ')]
    for fov, px in [(0.5, 1920), (1.0, 1920), (1.5, 1920), (2.0, 1920), (3.0, 1920)]:
        need = fov * 1000 / px * 25
        pick = min(SIZES, key=lambda s: (abs(s - need), -s))  # 同点なら大きいほう
        rows.append((f'{fov:.1f} m', f'{need:.0f} mm 相当', f'{pick} mm'))
    colx = [18 * mm, 58 * mm, 100 * mm]
    for i, r in enumerate(rows):
        c.setFont(JP, 8 if i else 7.5)
        c.setFillColor(INK if i else colors.Color(.45, .48, .5))
        for xx, cell in zip(colx, r):
            c.drawString(xx, y, cell)
        y -= 5.2 * mm
    return y


c = canvas.Canvas('marker_sheet.pdf', pagesize=A4)
c.setTitle('MotionTrace Pro 追跡マーカー（実寸印刷用）')
c.setAuthor('MotionTrace Pro')

SUB1 = [
 '印刷ダイアログで「実際のサイズ（100%）」を選んでください。「用紙に合わせる」では寸法が狂います。',
 '光沢紙は照明が映り込むので避け、普通紙かマット紙に印刷してください。',
 '四隅のトンボが切り取り位置です（周囲に 1.2mm の白い余白が残ります）。丸いマーカーはトンボに内接する円で切ってください。',
]
y = sheet(c, ['cross', 'bullseye'], 'MotionTrace Pro 追跡マーカー（1/2）', SUB1)
sizing_table(c, y)
c.showPage()

SUB2 = [
 '回転する対象（球・輪・振り子のおもり）には、同心円か黒丸を使ってください。',
 '十字・4分割・市松は 15 度回っただけで、一致度が LOST 判定の際まで落ちます。',
 '線が画面上で 3px を切ると、ボケとブレで模様が消えます。小さすぎる印刷は逆効果です。',
]
sheet(c, ['blackdot', 'quad'], 'MotionTrace Pro 追跡マーカー（2/2）', SUB2)
c.showPage()
c.save()
print('marker_sheet.pdf written')
