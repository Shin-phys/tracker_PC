// src/utils/colorKey.ts — 彩度で対象を絞る鍵を実測して決める
import { ColorKey, Rect } from '../types';
import { FrameSource } from './frameSource';

/** 彩度（OpenCV の HSV の S と同じ定義、0-255） */
export function satOf(r: number, g: number, b: number): number {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (mx === 0) return 0;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  return ((mx - mn) * 255) / mx;
}

/** 彩度が鍵に合う度合い 0〜1。境界は soft 幅でなめらかにする */
export function membership(s: number, key: ColorKey): number {
  const t = key.dir === 'low'
    ? (key.thr + key.soft - s) / (2 * key.soft)
    : (s - key.thr + key.soft) / (2 * key.soft);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export interface KeyMeasurement {
  /** 使える鍵。裾が重なっていたら null */
  key: ColorKey | null;
  /** 対象側の彩度の中央値 */
  targetMid: number;
  /** 周囲側の彩度の中央値 */
  surroundMid: number;
  /** 対象側の裾（向きに応じて 5% 点か 95% 点） */
  targetTail: number;
  /** 周囲側の裾 */
  surroundTail: number;
  /** 画面に出す一言。使えないときだけ中身が入る */
  msg: string;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/**
 * 枠の中と周囲の彩度を測って、鍵を決める。
 *
 * どこを測るか
 *   対象 … 枠の内側 60%。枠の縁は背景が混ざるので外す。
 *   周囲 … 枠の外から「枠＋探索半径の上限」まで。ここが追跡中に
 *           対抗馬になりうる範囲なので、それより広く測る意味はない。
 *
 * しきい値は中央値の中間ではなく**裾の中間**に置く。中央値で割ると、
 * 分布の広い側の半分近くが向こう側に落ちる。裾（5%／95% 点）が
 * 重なっているなら、そもそも彩度では分けられないので null を返す。
 *
 * @param searchPx 探索半径の上限 [px]
 */
export function measureColorKey(
  src: FrameSource, roi: Rect, searchPx: number
): KeyMeasurement {
  const cx = roi.x + roi.width / 2;
  const cy = roi.y + roi.height / 2;
  const inner = Math.max(2, Math.round(Math.min(roi.width, roi.height) * 0.3));
  const R = Math.round(Math.max(roi.width, roi.height) / 2 + Math.max(4, searchPx));

  const region = src.getRegion(cx - R, cy - R, R * 2, R * 2);
  const fail = (msg: string): KeyMeasurement => ({
    key: null, targetMid: 0, surroundMid: 0, targetTail: 0, surroundTail: 0, msg,
  });
  if (!region) return fail('');

  const tgt: number[] = [];
  const sur: number[] = [];
  const hx = roi.width / 2;
  const hy = roi.height / 2;
  for (let r = 0; r < region.height; r++) {
    const fy = region.y0 + r;
    for (let c = 0; c < region.width; c++) {
      const fx = region.x0 + c;
      const j = (r * region.width + c) * 4;
      const s = satOf(region.rgba[j], region.rgba[j + 1], region.rgba[j + 2]);
      const dx = Math.abs(fx - cx);
      const dy = Math.abs(fy - cy);
      if (dx <= inner && dy <= inner) tgt.push(s);
      else if (dx > hx || dy > hy) sur.push(s);
    }
  }
  if (tgt.length < 16 || sur.length < 64) return fail('');

  const ta = Float64Array.from(tgt).sort();
  const sa = Float64Array.from(sur).sort();
  const tMid = percentile(ta, 0.5);
  const sMid = percentile(sa, 0.5);

  const dir: 'high' | 'low' = tMid >= sMid ? 'high' : 'low';
  const tTail = percentile(ta, dir === 'high' ? 0.05 : 0.95);
  const sTail = percentile(sa, dir === 'high' ? 0.95 : 0.05);
  const separated = dir === 'high' ? tTail > sTail : tTail < sTail;
  const gap = Math.abs(tTail - sTail);

  const base = {
    targetMid: tMid, surroundMid: sMid, targetTail: tTail, surroundTail: sTail,
  };
  if (!separated) {
    return {
      ...base, key: null,
      msg: `彩度では分けられません（対象 ${Math.round(tMid)}／周囲 ${Math.round(sMid)}、`
        + `裾が重なっています）。輝度だけで追跡します。`,
    };
  }
  return {
    ...base,
    key: { dir, thr: (tTail + sTail) / 2, soft: Math.max(8, gap * 0.25) },
    msg: '',
  };
}

/** 鍵を人に見せる一言 */
export function describeKey(k: ColorKey): string {
  return k.dir === 'low'
    ? `対象のほうが彩度が低い（しきい値 ${Math.round(k.thr)} 以下を対象とみなす）`
    : `対象のほうが彩度が高い（しきい値 ${Math.round(k.thr)} 以上を対象とみなす）`;
}
