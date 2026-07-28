// src/utils/butterworth.ts
// ============================================================
// Kinovea と同じ方式の座標フィルタ
//
// なぜ必要か
//   位置を微分して速度・加速度を出すと、微小なノイズが Δt で割られて
//   大きく増幅される。位置の誤差が 0.14px でも、30fps で差分を取ると
//   速度には 4px/s 前後のノイズが乗る。微分の前に平滑化するのが定石。
//
// 方式（Kinovea のドキュメント記載の手順に合わせた）
//   1. 2 次 Butterworth 低域通過フィルタを、順方向と逆方向の 2 回かける
//      → 位相ずれ（時間的なズレ）が打ち消され、ピーク位置がずれない
//      [Winter, Biomechanics and Motor Control of Human Movement, 4th ed.]
//   2. 端の立ち上がりを避けるため、両端を 10 点だけ「端点まわりの反射」で
//      外挿してからフィルタし、あとで捨てる
//      [Smith G. (1989) J. Biomech. 22(9), 967-971]
//   3. 遮断周波数は 0.5Hz 〜 ナイキスト周波数まで走査し、
//      残差（元データ − 平滑化データ）の自己相関が最も小さくなる値を選ぶ。
//      自己相関の指標には Durbin-Watson 統計量を使い、2.0 に最も近いものを採る。
//      残差が白色ノイズに近い ＝ 信号を削りすぎても残しすぎてもいない、という考え方。
//      [Challis J. (1999) J. Applied Biomechanics 15(3)]
// ============================================================

/** 両端の反射パディング点数 */
const PAD = 10;

/**
 * 2 次 Butterworth 低域通過を「順方向 → 逆方向」の 2 パスで適用する。
 * @param data 等間隔サンプリングされた系列
 * @param dt   サンプリング間隔 [s]
 * @param fc   遮断周波数 [Hz]（2 パス合計での -3dB 点）
 */
export function butterworthZeroPhase(data: number[], dt: number, fc: number): number[] {
  const n = data.length;
  if (n < 4 || !(dt > 0) || !(fc > 0)) return [...data];

  const fs = 1 / dt;
  const nyquist = fs / 2;
  if (fc >= nyquist) return [...data];

  // 2 パスかけると遮断特性が鋭くなり、実効的な遮断周波数が下がる。
  // 合計の -3dB 点を指定した fc に合わせるための補正係数
  //   C = (2^(1/2) - 1)^(1/4) ≈ 0.802
  const C = Math.pow(Math.SQRT2 - 1, 0.25);
  const fcCorrected = Math.min(fc / C, nyquist * 0.999);

  // 双一次変換（プリワープあり）
  const w = Math.tan((Math.PI * fcCorrected) / fs);
  const w2 = w * w;
  const den = 1 + Math.SQRT2 * w + w2;

  const b0 = w2 / den;
  const b1 = 2 * b0;
  const b2 = b0;
  const a1 = (2 * (w2 - 1)) / den;
  const a2 = (1 - Math.SQRT2 * w + w2) / den;

  // --- 反射パディング（端点まわりで折り返す）---
  const pad = Math.min(PAD, n - 1);
  const ext: number[] = new Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * data[0] - data[pad - i];
    ext[n + pad + i] = 2 * data[n - 1] - data[n - 2 - i];
  }
  for (let i = 0; i < n; i++) ext[pad + i] = data[i];

  const pass = (src: number[]): number[] => {
    const m = src.length;
    const out = new Array<number>(m);
    // 初期値は先頭値で埋めて過渡応答を抑える
    out[0] = src[0];
    out[1] = src[1];
    for (let i = 2; i < m; i++) {
      out[i] =
        b0 * src[i] + b1 * src[i - 1] + b2 * src[i - 2] - a1 * out[i - 1] - a2 * out[i - 2];
    }
    return out;
  };

  const forward = pass(ext);
  const backward = pass([...forward].reverse()).reverse();

  return backward.slice(pad, pad + n);
}

/**
 * Durbin-Watson 統計量。
 * 残差が互いに独立（白色）なら 2 に近く、
 * 正の自己相関が残っている（＝平滑化しすぎて信号を削った）と 0 に近づく。
 */
export function durbinWatson(residuals: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 1; i < residuals.length; i++) {
    const d = residuals[i] - residuals[i - 1];
    num += d * d;
  }
  for (let i = 0; i < residuals.length; i++) den += residuals[i] * residuals[i];
  return den > 1e-20 ? num / den : 2;
}

export interface FilterResult {
  values: number[];
  /** 選ばれた遮断周波数 [Hz] */
  cutoff: number;
  /** そのときの Durbin-Watson 統計量（2 に近いほど良い） */
  dw: number;
}

/**
 * 遮断周波数を自動選択して平滑化する。
 * 0.5Hz からナイキスト周波数まで走査し、
 * 残差の自己相関が最も小さい（DW が 2 に最も近い）ものを採用する。
 */
export function autoFilter(data: number[], dt: number, steps = 60): FilterResult {
  const n = data.length;
  if (n < 12 || !(dt > 0)) return { values: [...data], cutoff: 0, dw: 2 };

  const nyquist = 1 / (2 * dt);
  const fMin = 0.5;
  const fMax = nyquist * 0.9;
  if (fMax <= fMin) return { values: [...data], cutoff: 0, dw: 2 };

  let best: FilterResult = { values: [...data], cutoff: fMax, dw: Infinity };
  let bestScore = Infinity;

  for (let i = 0; i < steps; i++) {
    // 対数スケールで走査（低周波側を細かく見る）
    const t = i / (steps - 1);
    const fc = fMin * Math.pow(fMax / fMin, t);
    const filtered = butterworthZeroPhase(data, dt, fc);

    const res = new Array<number>(n);
    for (let k = 0; k < n; k++) res[k] = data[k] - filtered[k];

    const dw = durbinWatson(res);
    const score = Math.abs(dw - 2);
    if (score < bestScore) {
      bestScore = score;
      best = { values: filtered, cutoff: fc, dw };
    }
  }
  return best;
}

/**
 * 中心差分による微分。端は片側差分。
 * 非等間隔でも使えるよう、時刻配列を受け取る。
 */
export function derivative(values: number[], times: number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = times[b] - times[a];
    out[i] = dt > 1e-12 ? (values[b] - values[a]) / dt : 0;
  }
  return out;
}

/** 時刻列から代表的なサンプリング間隔（中央値）を求める */
export function medianDt(times: number[]): number {
  if (times.length < 2) return 0;
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const v = times[i] - times[i - 1];
    if (v > 1e-9) d.push(v);
  }
  if (d.length === 0) return 0;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
