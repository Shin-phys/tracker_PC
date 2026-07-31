// src/utils/timeScale.ts
// ============================================================
// スロー動画の時間軸を実時間に直す。
//
// なぜ必要か
//   動画から読める時刻（mediaTime / currentTime）は「ファイル上の時刻」で、
//   撮影時の実時間とは必ずしも一致しない。
//   スマホの 240fps スローモーションは 30fps のファイルとして
//   書き出されることが多く、この場合ファイル上の 8 秒が実際には 1 秒。
//   補正しないと速度も加速度も 1/8 になり、重力加速度を測ると 1.2 m/s² になる。
//
//   ファイルのfps は実フレーム間隔から自動計測できるので、
//   ユーザーに入れてもらうのは撮影fps（スマホの撮影設定の数字）だけでよい。
//
//     実時間 = ファイル上の時刻 × (ファイルfps ÷ 撮影fps)
//
//   通常の動画では両者が一致するので倍率は 1 になり、何も起きない。
//
// 設計上の判断
//   historyData に記録する時刻は「ファイル上の時刻」のまま持つ。
//   動画側の事実なのでシークがそのまま使えるし、
//   撮影fps を後から直しても追跡をやり直さずに済む。
//   換算は表示・CSV を作る直前の 1 箇所だけで行う。
// ============================================================

import { FpsSettings } from '../types';

/** よく使う撮影fps（スマホのスロー設定に合わせた） */
export const CAPTURE_FPS_PRESETS = [30, 60, 120, 240, 480] as const;

/**
 * ファイル上の時刻に掛ける倍率。
 * 撮影fps が未設定（0）か、値が不正なときは 1（等倍）を返す。
 */
export const timeScale = (fps: FpsSettings): number => {
  const file = fps.value;
  const capture = fps.captureFps;
  if (!(file > 0) || !(capture > 0)) return 1;
  const s = file / capture;
  return isFinite(s) && s > 0 ? s : 1;
};

/** 等倍かどうか（UI で注意書きを出すかの判定に使う） */
export const isTimeScaled = (fps: FpsSettings): boolean =>
  Math.abs(timeScale(fps) - 1) > 1e-9;

/** ファイル上の時刻 → 実時間 */
export const toRealTime = (t: number, fps: FpsSettings): number =>
  t * timeScale(fps);

/** 実時間 → ファイル上の時刻（グラフから動画へシークするときに使う） */
export const toFileTime = (t: number, fps: FpsSettings): number => {
  const s = timeScale(fps);
  return s > 0 ? t / s : t;
};

/** 「再生 8.40 s → 実時間 1.05 s」のような確認用の文字列 */
export const describeTimeScale = (fps: FpsSettings): string => {
  const s = timeScale(fps);
  if (Math.abs(s - 1) < 1e-9) return '等倍（実時間そのまま）';
  // 1/8 のような分数で見せたほうが直感的
  const inv = 1 / s;
  const nice = Math.abs(inv - Math.round(inv)) < 1e-6 ? `1/${Math.round(inv)}` : s.toFixed(4);
  return `×${nice}（再生 1 秒 → 実時間 ${s.toFixed(4)} 秒）`;
};
