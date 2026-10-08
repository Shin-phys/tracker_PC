// src/utils/fit.ts
// ============================================================
// 当てはめ（最小二乗）と、その読み方に必要な数値。
//
// 設計の芯：**当てはめるのは生データ**
//   平滑化したデータに直線を当てはめると、傾き自体はあまり変わらないのに
//   残差が小さくなるので、R² と標準誤差だけが良くなる。平滑化は隣の点と
//   相関を作る操作なので、「独立な n 点」という最小二乗の前提が崩れ、
//   不確かさが実際より小さく出る。生徒に「誤差 0.3%」と読ませてしまう
//   のがいちばん悪い。グラフの見やすさのための平滑化と、数値を出すための
//   当てはめは、別の作業として分ける。
//
// もうひとつ：**傾きの標準誤差を必ず出す**
//   傾きだけ見せると、点が 8 点でも 200 点でも同じ重みで読まれてしまう。
//   se = s / √Sxx は、点数と区間の広さの両方で決まる。区間を広く取るほど
//   Sxx が増えて誤差が下がる、という当たり前の事実が数字で見える。
// ============================================================

export type FitModel = 'linear' | 'quadratic';

export interface FitResult {
  model: FitModel;
  /**
   * 係数（元の時刻 t のままの式）。
   *   linear:    y = coef[0] + coef[1] t
   *   quadratic: y = coef[0] + coef[1] t + coef[2] t²
   */
  coef: number[];
  /**
   * 物理量として読む係数の標準誤差。
   *   linear:    err[1] が傾きの標準誤差
   *   quadratic: err[2] が t² の係数の標準誤差
   * 平行移動で値の変わる係数（切片など）は、共分散を混ぜずに出せないので
   * 誤差を付けない（0 を入れる）。嘘の誤差を出すより空の方がよい。
   */
  err: number[];
  /** 決定係数 */
  r2: number;
  /** 残差の二乗平均平方根（データと同じ単位） */
  rmse: number;
  /** 使った点の数 */
  n: number;
  /** 残差（t, 実測 − 当てはめ） */
  residuals: { t: number; r: number }[];
  /** 当てはめた曲線の値 */
  evalAt: (t: number) => number;
}

/** 3x3 までの対称行列を Gauss-Jordan で解く。解と逆行列を返す */
function solveSym(
  a: number[][], b: number[]
): { sol: number[]; inv: number[][] } | null {
  const n = b.length;
  // [A | I | b] の拡大行列
  const m = a.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    b[i],
  ]);
  for (let c = 0; c < n; c++) {
    // 部分ピボット選択
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    }
    if (Math.abs(m[piv][c]) < 1e-14) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    const d = m[c][c];
    for (let j = 0; j < m[c].length; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f === 0) continue;
      for (let j = 0; j < m[r].length; j++) m[r][j] -= f * m[c][j];
    }
  }
  return {
    sol: m.map(row => row[2 * n]),
    inv: m.map(row => row.slice(n, 2 * n)),
  };
}

/**
 * 多項式の当てはめ。
 *
 * 時刻は平均を引いてから計算する。t が 2.4 s 付近で幅 0.3 s しかない
 * ような区間を素のまま 2 次で解くと、正規方程式の条件数が悪化して
 * 係数が桁で狂う（実際に起きる）。平均を引けば Σu = 0 になり、
 * 最高次の係数は平行移動で変わらないので、物理量としての読みは同じ。
 */
export function fitSeries(
  pts: { t: number; y: number }[], model: FitModel
): FitResult | null {
  const deg = model === 'linear' ? 1 : 2;
  const p = deg + 1;
  const n = pts.length;
  if (n < p + 1) return null;   // 自由度 0 では誤差が出せない

  const c = pts.reduce((s, q) => s + q.t, 0) / n;

  // 正規方程式 XᵀX b = Xᵀy（u = t - c の基底）
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const B: number[] = new Array(p).fill(0);
  pts.forEach(q => {
    const u = q.t - c;
    const basis: number[] = [1];
    for (let k = 1; k < p; k++) basis.push(basis[k - 1] * u);
    for (let i = 0; i < p; i++) {
      B[i] += basis[i] * q.y;
      for (let j = 0; j < p; j++) A[i][j] += basis[i] * basis[j];
    }
  });

  const solved = solveSym(A, B);
  if (!solved) return null;
  const b = solved.sol;

  // 残差と分散
  const evalU = (u: number) => {
    let v = 0;
    let pw = 1;
    for (let k = 0; k < p; k++) { v += b[k] * pw; pw *= u; }
    return v;
  };
  const yBar = pts.reduce((s, q) => s + q.y, 0) / n;
  let sse = 0;
  let sst = 0;
  const residuals = pts.map(q => {
    const r = q.y - evalU(q.t - c);
    sse += r * r;
    sst += (q.y - yBar) * (q.y - yBar);
    return { t: q.t, r };
  });
  const dof = n - p;
  const s2 = dof > 0 ? sse / dof : 0;

  // 元の t の式へ戻す
  // 1 次: y = (b0 - b1 c) + b1 t
  // 2 次: y = (b0 - b1 c + b2 c²) + (b1 - 2 b2 c) t + b2 t²
  const coef =
    p === 2
      ? [b[0] - b[1] * c, b[1]]
      : [b[0] - b[1] * c + b[2] * c * c, b[1] - 2 * b[2] * c, b[2]];

  // 物理量として読む係数の標準誤差。最高次は平行移動で不変なので
  // 中心化した基底での値をそのまま使える。
  const err = new Array(p).fill(0);
  err[p - 1] = Math.sqrt(Math.max(0, s2 * solved.inv[p - 1][p - 1]));

  return {
    model,
    coef,
    err,
    r2: sst > 0 ? 1 - sse / sst : 0,
    rmse: Math.sqrt(sse / n),
    n,
    residuals,
    evalAt: (t: number) => evalU(t - c),
  };
}

/** 標準重力加速度 [m/s²]。当てはめた加速度の読み合わせに使う */
export const G_STANDARD = 9.80665;

/**
 * 2 階差分から加速度を見積もる。Δt を何コマ分にするかで結果が変わる。
 *
 *   a = (y[i+k] − 2 y[i] + y[i−k]) / (k dt)²
 *
 * なぜ Δt を選ばせるのか
 *   分母が (k dt)² なので、k を 2 倍にすると位置のノイズの効きが 1/4 に
 *   なる。一方で k を広げると「その区間で加速度が一定」という前提が
 *   効いてくるので、等加速度でない運動では偏りが増える。
 *   どちらを取るかはデータを見ないと決められないので、k ごとの
 *   平均とばらつきを並べて、人に選んでもらう。
 */
export interface SecondDiffStat {
  /** 何コマ分を Δt に使ったか */
  k: number;
  /** 実時間での Δt [s] */
  dt: number;
  /** 加速度の平均 */
  mean: number;
  /** 加速度の標準偏差 */
  sd: number;
  /** 使えた点の数 */
  n: number;
}

export function secondDiffStats(
  t: number[], y: number[], ks: number[] = [1, 2, 4, 8]
): SecondDiffStat[] {
  const out: SecondDiffStat[] = [];
  const n = Math.min(t.length, y.length);
  if (n < 3) return out;
  // 刻みは中央値で代表させる（シークの丸めで 1 コマ分だけ揺れることがある）
  const steps: number[] = [];
  for (let i = 1; i < n; i++) steps.push(t[i] - t[i - 1]);
  steps.sort((a, b) => a - b);
  const dt0 = steps[Math.floor(steps.length / 2)];
  if (!(dt0 > 0)) return out;

  ks.forEach(k => {
    const vals: number[] = [];
    for (let i = k; i < n - k; i++) {
      const h = k * dt0;
      vals.push((y[i + k] - 2 * y[i] + y[i - k]) / (h * h));
    }
    if (vals.length < 2) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(
      vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (vals.length - 1)
    );
    out.push({ k, dt: k * dt0, mean, sd, n: vals.length });
  });
  return out;
}

// ------------------------------------------------------------
// 当てはめに渡す系列を作る
// ------------------------------------------------------------

/** 当てはめに使える量 */
export type FitQuantity = 'x' | 'y' | 'vx' | 'vy';

export interface RawSeries {
  /** 実時間 [s] */
  t: number[];
  /** 生の位置 */
  x: number[];
  y: number[];
  /** 生の位置から中心差分で出した速度 */
  vx: number[];
  vy: number[];
}

/**
 * 解析用の系列。**平滑化は通さない。**
 *
 * グラフ表示用の processedData はフィルタを通っているが、当てはめに
 * それを使うと不確かさが過小評価される（平滑化は隣の点と相関を作るので
 * 「独立な n 点」という前提が崩れる）。ここでは記録された座標をそのまま
 * 使い、速度だけ中心差分で出す。
 *
 * 時刻はここで実時間へ換算する（記録側はファイル上の時刻のまま）。
 *
 * @param range 実時間での範囲。null の要素は制限なし
 */
export function rawSeries(
  data: { timestamp: number; objects: { [id: string]: { xM: number; yM: number; lost: boolean; suspect?: boolean } } }[],
  objId: string,
  scale: number,
  range?: { start: number | null; end: number | null }
): RawSeries {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const it = data[i].objects[objId];
    // 見失った点と「飛んだ」印の付いた点は当てはめに入れない。
    // 1 点の跳ねで傾きが動くので、ここだけは黙って外す。
    if (!it || it.lost || it.suspect) continue;
    const tt = data[i].timestamp * scale;
    if (range) {
      if (range.start !== null && tt < range.start * scale - 1e-9) continue;
      if (range.end !== null && tt > range.end * scale + 1e-9) continue;
    }
    t.push(tt);
    x.push(it.xM);
    y.push(it.yM);
  }
  return { t, x, y, vx: centralDiff(x, t), vy: centralDiff(y, t) };
}

/** 中心差分。両端は片側差分で埋める */
function centralDiff(v: number[], t: number[]): number[] {
  const n = v.length;
  const out = new Array(n).fill(0);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const dt = t[1] - t[0];
      out[i] = dt !== 0 ? (v[1] - v[0]) / dt : 0;
    } else if (i === n - 1) {
      const dt = t[n - 1] - t[n - 2];
      out[i] = dt !== 0 ? (v[n - 1] - v[n - 2]) / dt : 0;
    } else {
      const dt = t[i + 1] - t[i - 1];
      out[i] = dt !== 0 ? (v[i + 1] - v[i - 1]) / dt : 0;
    }
  }
  return out;
}

/** その量の系列を取り出す */
export function pickQuantity(s: RawSeries, q: FitQuantity): number[] {
  switch (q) {
    case 'x': return s.x;
    case 'y': return s.y;
    case 'vx': return s.vx;
    case 'vy': return s.vy;
  }
}

/** 当てはめた係数から「加速度」を読む。読めないときは null */
export function accelerationOf(
  q: FitQuantity, fit: FitResult
): { value: number; err: number } | null {
  const isVel = q === 'vx' || q === 'vy';
  if (isVel && fit.model === 'linear') {
    // 速度の傾きがそのまま加速度
    return { value: fit.coef[1], err: fit.err[1] };
  }
  if (!isVel && fit.model === 'quadratic') {
    // 位置の 2 次の係数の 2 倍が加速度
    return { value: 2 * fit.coef[2], err: 2 * fit.err[2] };
  }
  return null;
}

/** 当てはめた係数から「速度」を読む。等速のときだけ意味がある */
export function velocityOf(
  q: FitQuantity, fit: FitResult
): { value: number; err: number } | null {
  const isVel = q === 'vx' || q === 'vy';
  if (!isVel && fit.model === 'linear') {
    return { value: fit.coef[1], err: fit.err[1] };
  }
  return null;
}
