// src/utils/overlay.ts
// ============================================================
// 映像に重ねる印の描き方。
//
// なぜ utils に置くか
//   components は PC 版とスマホ版で別物だが、「狙う点をどう描くか」は
//   精度に直結する共通の判断なので、両者で同じものを使う。
// ============================================================

/**
 * 十字マーカー。**中心に隙間を空けるのが肝。**
 *
 * 塗りつぶした丸で点を示すと、狙っている画素そのものが自分の描画で隠れる。
 * 半径 7px の丸なら直径 15px が不透明になり、その下に何があるか見えない。
 * 測量のレチクルも画像編集ソフトの精密カーソルも、例外なく中心が空いた
 * 十字なのはこのためで、手で点を打つ・直すときの精度がそのまま変わる。
 *
 * 手動記録の誤差は 1/Δt² で速度・加速度へ拡大するので、クリックのばらつきが
 * 半分になれば、同じコマ送り幅で速度の誤差もそのまま半分になる。
 *
 * 自動追跡には影響しない（トラッカーが見るのは映像であって、この描画ではない）。
 *
 * @param k  高DPI 対応の拡大率
 * @param arm 腕の長さ [CSS px]
 * @param gap 中心に空ける半径 [CSS px]。ここを 0 にすると意味がなくなる
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  k = 1,
  arm = 11,
  gap = 3.2,
  weight = 1.6
): void {
  const a = arm * k;
  const g = gap * k;
  const segs: [number, number, number, number][] = [
    [x - a, y, x - g, y],
    [x + g, y, x + a, y],
    [x, y - a, x, y - g],
    [x, y + g, x, y + a],
  ];

  const stroke = () => {
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of segs) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  };

  const prevCap = ctx.lineCap;
  ctx.lineCap = 'round';
  // 暗いフチを先に引く。白い紙や明るい対象の上でも線が見えるように
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = (weight + 1.8) * k;
  stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = weight * k;
  stroke();
  ctx.lineCap = prevCap;
}

/**
 * 校正点の印。**十字だけ**。囲みも塗りも置かない。
 *
 * 狙っている画素の上に何かを重ねた時点で、そこは目分量になる。
 * 校正の縮尺は「実寸 ÷ 基準のピクセル長」なので、その目分量はそのまま
 * 長さ・速度・加速度の誤差として残る。基準が 33px なら 1px の狂いが 3%。
 *
 * だから腕は細く、半透明にして下の絵を透かし、中心には穴を空ける。
 * 濃い縁取りを内側に敷いてあるので、白い紙の上でも黒い机の上でも見える。
 * 掴める範囲は描画とは別に持っているので、印を小さくしても操作性は落ちない。
 *
 * @param focused 選択中（矢印キーやドラッグの対象）なら濃く・大きく描く
 * @param badge   点に付ける短い文字（平面校正の 1〜4）。腕の間の空きに置く
 */
export function drawCalibPoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  k = 1,
  focused = false,
  badge?: string
): void {
  // 大きさは元の丸（半径 7px）と同じ差し渡しに収める。
  // 印は位置を示すためのもので、大きくしても精度は上がらない。
  // むしろ腕が長いほど、その下にある目盛りや縁が隠れる面積が増える。
  const arm = focused ? 9 : 7;

  ctx.save();
  // 半透明。狙っている目盛りや球の縁を、印の下から透かして見せる
  ctx.globalAlpha = focused ? 0.95 : 0.7;
  drawCrosshair(ctx, x, y, color, k, arm, 2.2, focused ? 1.7 : 1.3);
  ctx.restore();

  if (badge) {
    // 腕と腕の間（右上の空き）へ。囲みは付けず、縁取りだけで読ませる
    ctx.save();
    ctx.font = `bold ${11 * k}px Inter, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 2.6 * k;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineJoin = 'round';
    ctx.strokeText(badge, x + 4 * k, y - 4 * k);
    ctx.fillStyle = color;
    ctx.fillText(badge, x + 4 * k, y - 4 * k);
    ctx.restore();
  }
}
