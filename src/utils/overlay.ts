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
