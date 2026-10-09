// src/utils/restart.ts — 「次に追跡が始まる地点」を一箇所で決める
import { Checkpoint, Rect, SeedHint, TrackedObject } from '../types';

/** 追跡が次に始まる地点 */
export interface Origin {
  /** その地点での枠 */
  roi: Rect;
  /** その地点のファイル上の時刻 [s] */
  time: number;
  /** その地点での初速。無ければ null */
  seed: SeedHint | null;
  /** 中断からの再開か（最初の枠から始まるなら false） */
  resumed: boolean;
}

/**
 * 追跡が次に始まる地点を返す。
 *
 * initialRoi / initialTime は「ユーザーが最初のステップで引いた枠」で、
 * 中断では書き換えない。中断から再開する地点は checkpoint に入る。
 * 「いまどこから走り出すのか」を知りたい側は、この二つのどちらを見るべきか
 * 判断せずに、ここを呼ぶ。
 *
 * 2 点目の判定（指した位置から何 px 動いたか）や初速の計算は、
 * 走り出す地点を起点にしないと意味を持たない。中断後に initialRoi を
 * 起点にすると、何百コマ前の位置から移動量を測ってしまう。
 *
 * @returns 枠がまだ無ければ null
 */
export function originOf(o: TrackedObject): Origin | null {
  if (o.checkpoint) {
    return {
      roi: o.checkpoint.roi,
      time: o.checkpoint.time,
      seed: o.checkpoint.seed,
      resumed: true,
    };
  }
  if (o.initialRoi && o.initialTime !== null) {
    return { roi: o.initialRoi, time: o.initialTime, seed: o.seed, resumed: false };
  }
  return null;
}

/** 枠の大きさだけが欲しいとき。大きさは撮影中ずっと変わらない */
export function sizeOf(o: TrackedObject): Rect | null {
  return o.checkpoint?.roi ?? o.initialRoi ?? o.roi ?? null;
}

/** 中断点を作る。位置が決まらなければ null */
export function makeCheckpoint(
  size: Rect, at: { x: number; y: number }, time: number, seed: SeedHint | null
): Checkpoint {
  return {
    roi: {
      x: Math.round(at.x - size.width / 2),
      y: Math.round(at.y - size.height / 2),
      width: Math.round(size.width),
      height: Math.round(size.height),
    },
    time,
    seed,
  };
}
