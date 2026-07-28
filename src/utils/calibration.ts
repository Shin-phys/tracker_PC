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
 * 画像座標 → 実寸座標。
 * plane モードでは射影変換、それ以外は一定倍率。
 * 未校正のときは px をそのまま返す（px 単位で記録できる）。
 */
export const toReal = (calib: ScaleCalibration, p: Point, imageHeight = 0): Point => {
  if (calib.mode === 'plane' && calib.homography) {
    return applyHomography(calib.homography as Matrix3, p);
  }
  const s = calib.pxPerUnit > 0 ? calib.pxPerUnit : 1;
  const x = p.x / s;
  // yUp のときは画像の下端を原点にして上向きを正にする
  const y = calib.yUp && imageHeight > 0 ? (imageHeight - p.y) / s : p.y / s;
  return { x, y };
};

/** 実寸座標 → 画像座標（校正の検証表示などに使う） */
export const toImage = (calib: ScaleCalibration, p: Point, imageHeight = 0): Point | null => {
  if (calib.mode === 'plane' && calib.homography) {
    const inv = invertHomography(calib.homography as Matrix3);
    return inv ? applyHomography(inv, p) : null;
  }
  const s = calib.pxPerUnit > 0 ? calib.pxPerUnit : 1;
  return {
    x: p.x * s,
    y: calib.yUp && imageHeight > 0 ? imageHeight - p.y * s : p.y * s,
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
