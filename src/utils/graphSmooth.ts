// src/utils/graphSmooth.ts
// ============================================================
// グラフ概形モード専用の「表示だけの平滑化」
//
// 座標フィルタ（butterworth.ts）とは目的が違う。
//   座標フィルタ … CSV に出す値そのものを正しくするための処理
//   ここの平滑化 … 授業中に「形が放物線か」「vx-t が水平か」を判断するために、
//                  グラフの見た目からノイズを一段落とすだけの処理
// したがって CSV 出力やリアルタイム表示には一切影響させない。
//
// なぜ単純移動平均ではないか
//   移動平均は曲がっている区間を系統的に内側へ引き込む（放物線の頂点が鈍る）。
//   合成データ（等加速度＋ノイズ、30fps）で試すと、
//   区間の内側では速度の誤差が減る一方、両端で誤差がむしろ増えた。
//   窓が端で縮むぶんだけ引き込み量が変わり、それが微分で拡大されるため。
//   これは「最後に急に曲がった」ような偽の特徴を生むので採用できない。
//
// 採用した方式：2 次の Savitzky-Golay（局所 2 次多項式あてはめ）
//   窓の中のデータに 2 次式を最小二乗であてはめ、その値を採る。
//   2 次式は「等加速度運動」そのものなので、放物線は一切鈍らずに
//   ノイズだけが落ちる。同じ合成データで速度の誤差は
//   両端を含めて単調に改善した（w=11 で全体 0.038 → 0.025）。
//
//   端の扱いは「窓をずらし、評価点だけ動かす」方式。
//   端の値を複製して埋める実装だと、そこだけ平らに寝てしまう。
//   窓をずらす方式なら 2 次式の再現性が端でも保たれる。
// ============================================================

/** 強度スライダーの段（窓の点数）。
 *  3 点は 2 次式が 3 点を完全に通ってしまい素通しになるので入れない。 */
export const SMOOTH_WINDOWS = [5, 7, 9, 11, 15, 21] as const;

/** 既定の強度。控えめに 7 点 */
export const DEFAULT_SMOOTH_WINDOW = 7;

/** 多項式の次数。等加速度運動を保存したいので 2 次 */
const POLY_ORDER = 2;

/**
 * 帽子行列 H = J (JᵀJ)⁻¹ Jᵀ を作る。
 * H[q] は「窓内の局所位置 q における平滑化後の値」を、
 * 窓内の各点にかける重みとして表したもの。
 * 窓幅ごとに 1 回だけ計算すれば使い回せる（最大 21×21 なので軽い）。
 */
const hatCache = new Map<number, number[][] | null>();

function hatMatrix(w: number): number[][] | null {
  const cached = hatCache.get(w);
  if (cached !== undefined) return cached;

  const m = POLY_ORDER + 1;

  // J: 各行が (1, i, i²)
  const J: number[][] = [];
  for (let i = 0; i < w; i++) {
    const row: number[] = [];
    for (let j = 0; j < m; j++) row.push(Math.pow(i, j));
    J.push(row);
  }

  // JᵀJ
  const A: number[][] = [];
  for (let r = 0; r < m; r++) {
    const row: number[] = [];
    for (let c = 0; c < m; c++) {
      let s = 0;
      for (let i = 0; i < w; i++) s += J[i][r] * J[i][c];
      row.push(s);
    }
    A.push(row);
  }

  // ガウス・ジョルダン法で逆行列
  const G = A.map((row, i) => [
    ...row,
    ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let i = 0; i < m; i++) {
    let piv = i;
    for (let k = i + 1; k < m; k++) {
      if (Math.abs(G[k][i]) > Math.abs(G[piv][i])) piv = k;
    }
    const tmp = G[i]; G[i] = G[piv]; G[piv] = tmp;
    const p = G[i][i];
    if (Math.abs(p) < 1e-12) { hatCache.set(w, null); return null; }
    for (let j = i; j < 2 * m; j++) G[i][j] /= p;
    for (let k = 0; k < m; k++) {
      if (k === i) continue;
      const f = G[k][i];
      for (let j = i; j < 2 * m; j++) G[k][j] -= f * G[i][j];
    }
  }
  const inv = G.map(r => r.slice(m));

  // H[q][j] = J[q] · inv · J[j]
  const H: number[][] = [];
  for (let q = 0; q < w; q++) {
    const row: number[] = [];
    for (let j = 0; j < w; j++) {
      let s = 0;
      for (let a = 0; a < m; a++) {
        for (let b = 0; b < m; b++) s += J[q][a] * inv[a][b] * J[j][b];
      }
      row.push(s);
    }
    H.push(row);
  }

  hatCache.set(w, H);
  return H;
}

/**
 * 2 次 Savitzky-Golay 平滑化。
 * @param values 系列（等間隔サンプリングを仮定）
 * @param window 窓の点数（奇数）。データ長より長い場合は素通し
 */
export function smoothSeries(values: number[], window: number): number[] {
  const n = values.length;
  const w = window % 2 === 0 ? window + 1 : window;
  if (n < w || w <= POLY_ORDER) return [...values];

  const H = hatMatrix(w);
  if (!H) return [...values];

  const half = Math.floor(w / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // 窓の先頭。端では中に押し込むだけで、幅は変えない
    const s = Math.min(Math.max(i - half, 0), n - w);
    const q = i - s;
    let acc = 0;
    for (let j = 0; j < w; j++) acc += H[q][j] * values[s + j];
    out[i] = acc;
  }
  return out;
}
