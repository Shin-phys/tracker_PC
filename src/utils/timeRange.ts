// src/utils/timeRange.ts
// ============================================================
// 解析区間（始点・終点）
//
// なぜ必要か
//   実験動画の頭と尻には、必ず「使えない時間」が入る。装置の準備、手が
//   フレームに入っている区間、着地後の跳ね返り、転がって止まるまで。
//   これらを含んだまま解析すると、次の 2 つが壊れる。
//
//   1. Butterworth の自動遮断周波数
//      残差の Durbin-Watson を最小化する方式は、記録全体に対して遮断周波数を
//      1 つ選ぶ。静止区間や衝突の不連続が混ざると、そちらに引きずられて
//      肝心の運動区間に対して不適切な値が選ばれる。
//   2. 中心差分
//      衝突の瞬間をまたいだ 1 点だけ、物理的に意味のない速度が出る。
//
//   区間を切るのは「見た目を整える」ためではなく、この 2 つを避けるため。
//
// 時刻の単位について
//   ここで扱う時刻はすべて **ファイル上の時刻**（video の mediaTime）。
//   FrameData.timestamp と同じ土俵なので、そのまま比較できる。
//   実時間への換算（スロー動画）は DataPanel 側で最後にかかるので、
//   区間の判定には影響しない。
// ============================================================

import { FrameData } from '../types';

/** 始点・終点。null は「指定なし」＝動画の端を意味する */
export interface TimeRange {
  /** 始点 [s]（ファイル上の時刻）。null なら動画の先頭 */
  start: number | null;
  /** 終点 [s]（ファイル上の時刻）。null なら動画の末尾 */
  end: number | null;
}

/** 区間未指定の初期値 */
export const FULL_RANGE: TimeRange = { start: null, end: null };

/**
 * 時刻比較の許容誤差 [s]。
 * 始点は「いま表示されているフレームの mediaTime」をそのまま入れるので
 * 本来は厳密に一致するが、シークバーから入れた場合に備えて余裕を持たせる。
 */
const EPS = 1e-6;

/**
 * 区間内の点数がこれを下回ると、Butterworth の自動遮断周波数の選択自体が
 * 不安定になる。UI で警告を出す閾値。
 */
export const MIN_RANGE_POINTS = 20;

/** 始点・終点のどちらかが指定されているか */
export function hasRange(r: TimeRange): boolean {
  return r.start !== null || r.end !== null;
}

/** 始点・終点の両方が指定されているか */
export function isFullySpecified(r: TimeRange): boolean {
  return r.start !== null && r.end !== null;
}

/** 実際の始点 [s]。未指定なら 0 */
export function rangeStart(r: TimeRange): number {
  return r.start ?? 0;
}

/** 実際の終点 [s]。未指定なら動画の末尾 */
export function rangeEnd(r: TimeRange, duration: number): number {
  return r.end ?? (duration > 0 ? duration : Infinity);
}

/** 区間の長さ [s]（ファイル上の時刻での長さ） */
export function rangeSpan(r: TimeRange, duration: number): number {
  const e = rangeEnd(r, duration);
  if (!isFinite(e)) return 0;
  return Math.max(0, e - rangeStart(r));
}

/** その時刻が区間内か */
export function inRange(r: TimeRange, t: number): boolean {
  if (r.start !== null && t < r.start - EPS) return false;
  if (r.end !== null && t > r.end + EPS) return false;
  return true;
}

/**
 * 始点と終点が逆に入れられた場合に入れ替える。
 * 「終点にする」を先に押してから戻って「始点にする」を押す操作は自然に起きる。
 */
export function normalizeRange(r: TimeRange): TimeRange {
  if (r.start !== null && r.end !== null && r.start > r.end) {
    return { start: r.end, end: r.start };
  }
  return r;
}

/** 記録データを区間内だけに絞る */
export function clipToRange(data: FrameData[], r: TimeRange): FrameData[] {
  if (!hasRange(r)) return data;
  return data.filter(fd => inRange(r, fd.timestamp));
}

/** 区間内に入っているフレーム数 */
export function countInRange(data: FrameData[], r: TimeRange): number {
  if (!hasRange(r)) return data.length;
  let n = 0;
  for (const fd of data) if (inRange(r, fd.timestamp)) n++;
  return n;
}

/**
 * 枠を引いたコマの時刻のうち、いちばん早いもの。枠が 1 つも無ければ null。
 *
 * テンプレートは「枠を引いた瞬間のコマの画」から作られるので、
 * この時刻より前へ戻して再生しても、そのコマに物体がいなければ追跡は始まらない。
 */
export function earliestRoiTime(roiTimes: number[]): number | null {
  if (roiTimes.length === 0) return null;
  return Math.min(...roiTimes);
}

/**
 * 「やり直し」で戻る先の時刻。
 *
 *   1. 区間の始点（指定されていればそこ。ユーザーが明示した位置を優先する）
 *   2. 枠を引いたコマ（区間が無いとき。ここより前へ戻しても追跡が始まらない）
 *   3. 動画の先頭（枠もまだ無いとき。従来どおりの挙動）
 *
 * 1 と 2 がずれている場合は、始点のコマに物体がいない可能性がある。
 * ここでは黙って辻褄を合わせず、UI 側で警告して直す手段を出す
 * （勝手に別の位置へ飛ぶほうが、原因の分からない不具合になりやすい）。
 */
export function restartTimeFor(r: TimeRange, roiTimes: number[]): number {
  if (r.start !== null) return r.start;
  return earliestRoiTime(roiTimes) ?? 0;
}

/** 枠を引いたコマの、いちばん早いものと遅いものの差 [s] */
export function roiTimeSpread(roiTimes: number[]): number {
  if (roiTimes.length < 2) return 0;
  return Math.max(...roiTimes) - Math.min(...roiTimes);
}

/**
 * 「同じコマとみなす」許容差 [s]。1.5 コマ分。
 * ちょうど 1 コマだと、シークの丸めで隣のコマに着地しただけでも警告が出る。
 */
export function sameFrameTolerance(fps: number): number {
  return 1.5 / (fps > 0 ? fps : 30);
}

/** 表示用の秒数（小数 3 桁） */
export function fmtTime(t: number): string {
  return t.toFixed(3);
}
