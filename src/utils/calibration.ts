// src/utils/calibration.ts
import { ScaleCalibration, Point, LengthUnit, UNIT_TO_M } from '../types';
import {
  computeHomography, applyHomography, invertHomography,
  isConvexQuad, localPxPerUnit, Matrix3,
} from './homography';

/** 2点間のピクセル距離 */
export const pixelDistance = (a: Point, b: Point): number =>
  Math.hypot(b.x - a.x, b.y - a.y);

/** 校正が完了しているか */
export const isCalibrated = (c: ScaleCalibration): boolean =>
  c.mode === 'plane' ? c.homography !== null : c.pxPerUnit > 0;

/**
 * 校正設定から縮尺を再計算して返す。
 * 実長さ・単位・線・四隅など、校正に関わる値を変えたら必ずこれを通す。
 */
export const recalcScale = (
  calib: ScaleCalibration,
  boxWidthPx?: number
): ScaleCalibration => {
  // ---------- plane モード ----------
  if (calib.mode === 'plane') {
    const pts = calib.planePoints;
    const W = calib.planeWidth;
    const H = calib.planeHeight;
    if (pts.length !== 4 || !(W > 0) || !(H > 0) || !isConvexQuad(pts)) {
      return { ...calib, homography: null };
    }
    // クリック順（左上→右上→右下→左下）を実寸座標へ対応づける。
    // 画像のY軸は下向きなので、yUp のときは実寸側のYを反転して渡す。
    const dst: Point[] = calib.yUp
      ? [{ x: 0, y: H }, { x: W, y: H }, { x: W, y: 0 }, { x: 0, y: 0 }]
      : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const Hm = computeHomography(pts, dst);
    return { ...calib, homography: Hm };
  }

  // ---------- line / box モード ----------
  const real = calib.realSizeValue;
  if (!(real > 0)) return { ...calib, pxPerUnit: 0, homography: null };

  if (calib.mode === 'line') {
    if (calib.linePoints.length === 2) {
      const d = pixelDistance(calib.linePoints[0], calib.linePoints[1]);
      return { ...calib, pxPerUnit: d > 0 ? d / real : 0, homography: null };
    }
    return { ...calib, pxPerUnit: 0, homography: null };
  }

  if (boxWidthPx && boxWidthPx > 0) {
    return { ...calib, pxPerUnit: boxWidthPx / real, homography: null };
  }
  return { ...calib, homography: null };
};

/**
 * 出力を m にそろえるための係数。
 *
 * 基準の長さは cm や mm で入力してもらうほうが自然（A4 なら 29.7cm）だが、
 * 記録に残る数値は m に統一する。速度が m/s、加速度が m/s² になり、
 * 教科書の式にそのまま入る。CSV とグラフと計測値で桁が食い違うこともなくなる。
 *
 * 未校正のときは px をそのまま扱うので 1 を返す（px を 0.01 倍しても意味がない）。
 */
export const metersPerUnit = (calib: ScaleCalibration): number =>
  isCalibrated(calib) ? UNIT_TO_M[calib.unit] : 1;

/** 記録・出力に使う単位の表示名。校正済みなら m、未校正なら px */
export const outputUnit = (calib: ScaleCalibration): string =>
  isCalibrated(calib) ? 'm' : 'px';

/**
 * 画像座標 → 実寸座標 [m]。
 * plane モードでは射影変換、それ以外は一定倍率。
 * 未校正のときは px をそのまま返す（px 単位で記録できる）。
 */
export const toReal = (calib: ScaleCalibration, p: Point, imageHeight = 0): Point => {
  const k = metersPerUnit(calib);
  if (calib.mode === 'plane' && calib.homography) {
    const Hm = calib.homography as Matrix3;
    const q = applyHomography(Hm, p);
    if (!calib.origin) return { x: q.x * k, y: q.y * k };
    // plane モードでは、原点も同じ射影変換で実寸へ移してから引く。
    // 画像座標のまま引くと、遠近のかかり方が場所ごとに違うので合わない。
    const o = applyHomography(Hm, calib.origin);
    return { x: (q.x - o.x) * k, y: (q.y - o.y) * k };
  }
  const s = calib.pxPerUnit > 0 ? calib.pxPerUnit : 1;
  // 原点が未設定なら従来どおり画像の左上（yUp なら左下）を基準にする
  const ox = calib.origin ? calib.origin.x : 0;
  const oy = calib.origin
    ? calib.origin.y
    : (calib.yUp && imageHeight > 0 ? imageHeight : 0);
  return {
    x: ((p.x - ox) / s) * k,
    // yUp のときは上向きが正になるよう向きを反転する
    y: (calib.yUp ? (oy - p.y) / s : (p.y - oy) / s) * k,
  };
};

/** 実寸座標 [m] → 画像座標（校正の検証表示などに使う）。toReal の逆 */
export const toImage = (calib: ScaleCalibration, p: Point, imageHeight = 0): Point | null => {
  const k = metersPerUnit(calib);
  // toReal が最後に掛けた分をここで戻す
  const px = p.x / k;
  const py = p.y / k;
  if (calib.mode === 'plane' && calib.homography) {
    const Hm = calib.homography as Matrix3;
    const inv = invertHomography(Hm);
    if (!inv) return null;
    const o = calib.origin
      ? applyHomography(Hm, calib.origin)
      : { x: 0, y: 0 };
    return applyHomography(inv, { x: px + o.x, y: py + o.y });
  }
  const s = calib.pxPerUnit > 0 ? calib.pxPerUnit : 1;
  const ox = calib.origin ? calib.origin.x : 0;
  const oy = calib.origin
    ? calib.origin.y
    : (calib.yUp && imageHeight > 0 ? imageHeight : 0);
  return {
    x: px * s + ox,
    y: calib.yUp ? oy - py * s : py * s + oy,
  };
};

/**
 * ある画素位置における局所的な縮尺 (px / 実単位)。
 * plane モードでは場所によって変わるので、校正の妥当性確認に使う。
 */
export const pxPerUnitAt = (calib: ScaleCalibration, p: Point): number => {
  if (calib.mode === 'plane' && calib.homography) {
    const Hm = calib.homography as Matrix3;
    const inv = invertHomography(Hm);
    return inv ? localPxPerUnit(inv, p, Hm) : 0;
  }
  return calib.pxPerUnit;
};

/** plane モードで、画面内の縮尺が何%ばらついているか（遠近の強さの目安） */
export const scaleVariation = (
  calib: ScaleCalibration,
  width: number,
  height: number
): { min: number; max: number; spreadPct: number } | null => {
  if (calib.mode !== 'plane' || !calib.homography) return null;
  let mn = Infinity;
  let mx = 0;
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) {
      const s = pxPerUnitAt(calib, { x: (width * i) / 4, y: (height * j) / 4 });
      if (s > 0) {
        mn = Math.min(mn, s);
        mx = Math.max(mx, s);
      }
    }
  }
  if (!isFinite(mn) || mx <= 0) return null;
  return { min: mn, max: mx, spreadPct: (mx / mn - 1) * 100 };
};

/** 単位変換つきの表示ヘルパー: 1px が実世界で何 unit に相当するか */
export const unitPerPixel = (calib: ScaleCalibration): number =>
  calib.pxPerUnit > 0 ? 1 / calib.pxPerUnit : 0;

/** 校正値をメートル基準に換算 (px/m) */
export const pxPerMeter = (calib: ScaleCalibration): number =>
  calib.pxPerUnit > 0 ? calib.pxPerUnit / UNIT_TO_M[calib.unit] : 0;

/**
 * 単位を切り替えた時に「同じ実長さ」を保ったまま数値を変換する。
 * 例: 10 cm → m に切替 → 0.1 m
 */
export const convertValue = (
  value: number,
  from: LengthUnit,
  to: LengthUnit
): number => {
  const meters = value * UNIT_TO_M[from];
  const converted = meters / UNIT_TO_M[to];
  // 浮動小数の誤差を丸める（0.30000000000000004 対策）
  return parseFloat(converted.toPrecision(12));
};

/** 数値の見やすい整形 */
export const fmt = (v: number, digits = 2): string => {
  if (!isFinite(v)) return '—';
  if (v !== 0 && Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toFixed(digits);
};
