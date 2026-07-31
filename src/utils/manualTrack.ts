// src/utils/manualTrack.ts
// ============================================================
// 手動トラッキング（コマごとに人が点を打つ）の記録操作。
//
// 自動追跡との違いは「フレームが最初から存在しない」こと。
// 自動追跡は再生しながら毎フレーム記録を作るが、手動では
// 打った時刻にだけ記録が生まれる。しかも打つ順序は時間順とは限らない
// （見落としたコマに戻って打ち足すことがある）ので、
// 時刻でソートされた状態を保ちながら挿入する必要がある。
//
// 記録は自動追跡と同じ historyData に入れる。
// 別々に持つと、フィルタ・グラフ・CSV をすべて二重化することになるうえ、
// 「自動で7割追って残りを手動で埋める」使い方ができなくなる。
// 手で打った点は manual: true が付くので、CSV で後から区別できる。
//
// 取り消しに備えて、変更内容を表す小さな記録（ManualEdit）を返す。
// 履歴全体をコピーして戻す方式にしないのは、自動追跡済みの
// 数千フレームを 1 クリックごとに複製することになるため。
// ============================================================

import { FrameData, Point } from '../types';

/** historyData の 1 物体分のエントリ */
type FrameObject = FrameData['objects'][string];

/** 取り消し用に、1 回の操作で何をしたかを覚えておく */
export interface ManualEdit {
  /** insert = フレームごと作った / update = 既存フレームを書き換えた */
  kind: 'insert' | 'update';
  /** 対象フレームの時刻。index ではなく時刻で覚えるのは、
   *  後から別のコマを挿入して index がずれても追えるようにするため */
  time: number;
  objId: string;
  /** update のとき、書き換える前の値 */
  prev?: FrameObject;
}

/** 時刻がこの範囲内なら「同じコマ」とみなす */
const sameFrame = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * 手動で打った点を記録に反映する。
 *
 * @param history   記録（この配列を直接書き換える）
 * @param objId     対象オブジェクト
 * @param fileTime  ファイル上の時刻 [s]（実際に表示されたフレームの mediaTime）
 * @param px        画像座標
 * @param real      実寸座標（呼び出し側で toReal 済み）
 * @param tol       同じコマとみなす時刻の許容差 [s]
 * @param frameIndex 新規フレームに付ける通し番号
 * @returns 取り消し用の記録
 */
export function placeManualPoint(
  history: FrameData[],
  objId: string,
  fileTime: number,
  px: Point,
  real: Point,
  tol: number,
  frameIndex: number
): ManualEdit {
  // ---- 同じコマの記録が既にあるか探す ----
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < history.length; i++) {
    const d = Math.abs(history[i].timestamp - fileTime);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }

  const entry: FrameObject = {
    xPx: px.x, yPx: px.y,
    xM: real.x, yM: real.y,
    // 速度は DataPanel が平滑化後の座標から中心差分で出し直すので、
    // ここでは 0 を入れておけばよい
    vx: 0, vy: 0, speedMs: 0,
    score: 1, lost: false, manual: true,
  };

  if (best >= 0 && sameFrame(history[best].timestamp, fileTime, tol)) {
    const fd = history[best];
    const prev = fd.objects[objId];
    fd.objects[objId] = entry;
    return prev
      ? { kind: 'update', time: fd.timestamp, objId, prev: { ...prev } }
      : { kind: 'insert', time: fd.timestamp, objId };
  }

  // ---- 新しいコマとして挿入する（時刻順を保つ） ----
  const fd: FrameData = {
    frameIndex,
    timestamp: fileTime,
    objects: { [objId]: entry },
    distances: {},
  };
  let at = history.length;
  for (let i = 0; i < history.length; i++) {
    if (history[i].timestamp > fileTime) { at = i; break; }
  }
  history.splice(at, 0, fd);
  return { kind: 'insert', time: fileTime, objId };
}

/**
 * placeManualPoint の取り消し。
 *
 * @returns 取り消せたか（対象が見つからなければ false）
 */
export function undoManualPoint(
  history: FrameData[],
  edit: ManualEdit,
  tol: number
): boolean {
  const idx = history.findIndex(f => sameFrame(f.timestamp, edit.time, tol));
  if (idx < 0) return false;
  const fd = history[idx];

  if (edit.kind === 'update' && edit.prev) {
    fd.objects[edit.objId] = { ...edit.prev };
    return true;
  }

  // insert の取り消し
  delete fd.objects[edit.objId];
  // そのコマに誰も残っていなければ、コマごと消す。
  // 空のフレームを残すと、グラフや CSV に中身のない行が出る
  if (Object.keys(fd.objects).length === 0) history.splice(idx, 1);
  return true;
}

// ------------------------------------------------------------
// 何コマおきに打つか
// ------------------------------------------------------------
//
// これは見た目の好みではなく、結果の精度を直接決める。
// 加速度は位置を 2 回微分して出すので、クリックのぶれは 1/Δt² で拡大される。
// 間隔を詰めるほど「丁寧に測っている」気がするが、実際は逆に悪化する。
//
// 合成データ（自由落下・40 点・クリック精度 ±0.6px・240fps 撮影）での実測:
//
//     1 コマおき (  4.2 ms) → 重力加速度のばらつき 40.7 %
//     2 コマおき (  8.3 ms) → 11.4 %
//     4 コマおき ( 16.7 ms) →  2.7 %
//     8 コマおき ( 33.3 ms) →  0.7 %
//    16 コマおき ( 66.7 ms) →  0.2 %
//
// 偏りは出ない（平均は常に真値）ので、問題はばらつきだけ。
// 目安として実時間で 30〜50ms 空けたい。
// ------------------------------------------------------------

/** これを下回ると精度が苦しくなる実時間の間隔 [s] */
export const MANUAL_INTERVAL_WARN = 0.015;
/** 目標にしたい実時間の間隔 [s] */
export const MANUAL_INTERVAL_TARGET = 0.04;

/**
 * 「n コマおき」が実時間で何秒になるか。
 * @param scale 時間スケール（スロー動画の換算倍率）
 */
export const manualStepInterval = (
  step: number, fileFps: number, scale: number
): number => (fileFps > 0 ? (step * scale) / fileFps : 0);

/**
 * 実時間で MANUAL_INTERVAL_TARGET に近くなるコマ数を勧める。
 * 通常の 30fps 動画なら 1〜2 コマ、240fps スローなら 10 コマ前後になる。
 */
export const recommendManualStep = (
  fileFps: number, scale: number, max = 30
): number => {
  if (!(fileFps > 0) || !(scale > 0)) return 1;
  const perFrame = scale / fileFps;
  if (!(perFrame > 0)) return 1;
  return Math.max(1, Math.min(max, Math.round(MANUAL_INTERVAL_TARGET / perFrame)));
};

/**
 * 手動で打った点の数（進捗表示用）。
 * 自動追跡ぶんと混ざっているので manual フラグで数える。
 */
export const countManualPoints = (history: FrameData[], objId?: string): number => {
  let n = 0;
  for (const fd of history) {
    for (const [id, it] of Object.entries(fd.objects)) {
      if (it.manual && (!objId || id === objId)) n++;
    }
  }
  return n;
};

/**
 * そのコマの対象を全部打ち終わったか。
 *
 * 「打ったら次のコマへ進む」判定に使う。打つ順番を入れ替えられるようにすると
 * 「残り 1 つだったか」を打つ前に判断できなくなるので、
 * 打ったあとに記録そのものを見て判定する。
 */
export function isFrameComplete(
  history: FrameData[],
  order: string[],
  fileTime: number,
  tol: number
): boolean {
  if (order.length === 0) return false;
  const fd = history.find(f => sameFrame(f.timestamp, fileTime, tol));
  if (!fd) return false;
  return order.every(id => {
    const it = fd.objects[id];
    return !!it && it.manual && !it.lost;
  });
}

/**
 * 次に打つべき物体を決める。
 *
 * 「各コマで全物体を打ち、最後の 1 つで自動的にコマを進める」流れなので、
 * そのコマでまだ打っていない物体のうち、並び順で最初のものを返す。
 * すでに全部打ってあるコマに戻ってきた場合は先頭から打ち直せるよう
 * 先頭の物体を返す。
 *
 * @returns 次に打つ物体の id と、それがそのコマの最後の 1 つかどうか
 */
export function nextManualTarget(
  history: FrameData[],
  order: string[],
  fileTime: number,
  tol: number
): { objId: string | null; isLast: boolean } {
  if (order.length === 0) return { objId: null, isLast: false };

  const fd = history.find(f => sameFrame(f.timestamp, fileTime, tol));
  const placed = new Set<string>();
  if (fd) {
    for (const id of order) {
      const it = fd.objects[id];
      if (it && it.manual) placed.add(id);
    }
  }

  const remaining = order.filter(id => !placed.has(id));
  if (remaining.length === 0) {
    // 全部打ち終わっているコマ。打ち直し用に先頭を返す
    return { objId: order[0], isLast: order.length === 1 };
  }
  return { objId: remaining[0], isLast: remaining.length === 1 };
}
