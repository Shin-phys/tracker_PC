// src/utils/trailEdit.ts
// ============================================================
// 記録済みの軌跡から点を捨てる操作。
//
// なぜ「直す」ではなく「捨てる」なのか
//   追跡が壊れたとき、壊れているのは「飛んだそのコマ」ではない。
//   テンプレートが別のものに乗り移るまでには、たいてい数コマの
//   じわじわしたドリフトがある。移動量の中央値から 3 倍外れた時点で
//   やっと検出できるので、そこまでの数コマは既に汚れている。
//
//   1 点を正しい位置へ直しても、その手前の汚れた点と、壊れたまま
//   残っているテンプレートはそのままだから、再開すれば同じ場所で
//   また壊れる。信用できる最後のコマまで戻して捨て、そこから
//   撮り直すほうが速いし、データも素直になる。
//
//   どこまで戻すかは人が決める。自動で決めると、切りすぎたとき・
//   切り足らないときに手当てできない。
// ============================================================

import { FrameData, Point } from '../types';

export interface TruncateResult {
  /** 残した記録 */
  kept: FrameData[];
  /** 捨てたコマ数 */
  dropped: number;
  /** 残した最後のコマの時刻 [s]。何も残らなければ null */
  lastTime: number | null;
}

/**
 * keepUntil のコマまでを残し、それより後を捨てる。
 *
 * @param tol 同じコマとみなす時刻の許容差。keepUntil 自身を
 *            取りこぼさないために足す。
 */
export function truncateAfter(
  data: FrameData[], keepUntil: number, tol: number
): TruncateResult {
  const kept = data.filter(f => f.timestamp <= keepUntil + tol);
  return {
    kept,
    dropped: data.length - kept.length,
    lastTime: kept.length > 0 ? kept[kept.length - 1].timestamp : null,
  };
}

/**
 * 1 つの物体の 1 点だけを消す。
 *
 * グラフを見て後から外れ値に気づいたときのための操作。
 * 2 階差分も当てはめも、1 点の跳ねで台無しになる。
 *
 * その物体の記録だけを消し、コマ自体は残す（他の物体の点が入っている）。
 * 残りが空になったコマは呼び出し側で捨てる必要はない。記録が無い物体は
 * 軌跡でもグラフでも単に飛ばされる。
 *
 * @returns 実際に消せたか
 */
export function dropPointAt(
  data: FrameData[], objId: string, t: number, tol: number
): boolean {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < data.length; i++) {
    if (!data[i].objects[objId]) continue;
    const d = Math.abs(data[i].timestamp - t);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > tol) return false;
  delete data[best].objects[objId];
  return true;
}

/** 戻る先の候補として見せる 1 点 */
export interface TrailPoint {
  /** ファイル上の時刻 [s] */
  time: number;
  /** 画像座標 */
  point: Point;
  /** 直前の点からの移動量 [px]。中央値から外れていれば怪しい */
  step: number;
}

/**
 * before より前にある、その物体の記録点を新しい順に最大 n 個返す。
 *
 * 「ここまでは正しい」を人に選ばせるための候補。数字ではなく
 * 映像の上の点として見せたいので、画像座標と時刻を組にして返す。
 */
export function pointsBefore(
  data: FrameData[], objId: string, before: number, n: number
): TrailPoint[] {
  const out: TrailPoint[] = [];
  let prev: Point | null = null;
  for (let i = 0; i < data.length; i++) {
    const f = data[i];
    if (f.timestamp > before) break;
    const it = f.objects[objId];
    // 飛んだと判定した点は候補に出さない。
    // これを「正しい最後の点」として選べてしまうと、捨てたい点が残る。
    if (!it || it.lost || it.suspect) { prev = null; continue; }
    const p = { x: it.xPx, y: it.yPx };
    out.push({
      time: f.timestamp,
      point: p,
      step: prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0,
    });
    prev = p;
  }
  return out.slice(-n);
}

/** 疑わしい印を外す（誤検出だったとき） */
export function clearSuspect(data: FrameData[], objId: string): void {
  for (let i = 0; i < data.length; i++) {
    const it = data[i].objects[objId];
    if (it && it.suspect) delete it.suspect;
  }
}
