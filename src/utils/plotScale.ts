// src/utils/plotScale.ts
// 目盛りの刻みと書式。解析パネルの小さなグラフで使う。
// MotionGraph の中にあった同じ考え方を、使い回せる形に出しただけ。

/**
 * 目盛り間隔を 1 / 2 / 5 × 10^n から選ぶ。
 * 「range 以上で最小の候補」を採る素朴なやり方だと、5 と 10 の間が開きすぎて
 * 目盛りが 2 本しか出ないことがある。候補ごとに本数を出し、目標本数に
 * 一番近いものを選ぶ。
 */
export function niceStep(range: number, target: number): number {
  if (!(range > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(range / Math.max(1, target))));
  const cands = [mag, 2 * mag, 5 * mag, 10 * mag];
  let best = cands[0];
  let bestErr = Infinity;
  for (const s of cands) {
    const err = Math.abs(range / s - target);
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}

/** 目盛りの値を、刻みに見合った桁数で書く */
export function fmtTick(v: number, step: number): string {
  if (Math.abs(v) < step * 1e-6) return '0';
  if (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4) return v.toExponential(1);
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  return v.toFixed(decimals);
}

/** 範囲 [min,max] の中にある目盛りの値を並べる */
export function ticksFor(min: number, max: number, target: number): number[] {
  const step = niceStep(max - min, target);
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}
