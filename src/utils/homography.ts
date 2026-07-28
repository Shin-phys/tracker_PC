// src/utils/homography.ts
// ============================================================
// 射影変換（ホモグラフィ）
//
// 平面を斜めから撮ると、正方形は台形に写る。
// 単一の px/cm スケールは「光軸が運動面に垂直」なときだけ正しく、
// 傾いていると画面内の位置によって縮尺が変わる。
// 実測では傾き 20° で最大 6% 程度の系統誤差になる。
//
// 3x3 行列 H ひとつで画像座標 (u,v) から実寸座標 (X,Y) へ写す:
//     X = (h0 u + h1 v + h2) / (h6 u + h7 v + h8)
//     Y = (h3 u + h4 v + h5) / (h6 u + h7 v + h8)
// 分母が u,v に依存することが本質で、これが遠近を表す。
// h8 = 1 と正規化できるので自由度は 8、対応点 4 組で一意に決まる。
// ============================================================

import { Point } from '../types';

/** 行優先の 3x3 行列（長さ 9） */
export type Matrix3 = number[];

// ------------------------------------------------------------
// 連立一次方程式（部分ピボット選択つきガウス消去）
// ------------------------------------------------------------

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // 破壊的に扱うのでコピー
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // ピボット選択（絶対値最大の行）
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // 特異行列
    if (pivot !== col) {
      const t = M[pivot];
      M[pivot] = M[col];
      M[col] = t;
    }
    // 前進消去
    const p = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  // 後退代入
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x.every(v => isFinite(v)) ? x : null;
}

// ------------------------------------------------------------
// Hartley 正規化
//   座標をそのまま使うと 1920 のオーダーと 1 のオーダーが混ざり
//   数値的に不安定になる。重心を原点、平均距離を √2 に揃えてから解く。
// ------------------------------------------------------------

interface Normalization {
  T: Matrix3;      // 正規化行列
  Tinv: Matrix3;   // その逆
  pts: Point[];
}

function normalize(pts: Point[]): Normalization {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  let mean = 0;
  for (const p of pts) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= n;
  const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;

  return {
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    Tinv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
    pts: pts.map(p => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

export function multiply3(A: Matrix3, B: Matrix3): Matrix3 {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
      C[i * 3 + j] = s;
    }
  }
  return C;
}

// ------------------------------------------------------------
// ホモグラフィの計算（DLT）
// ------------------------------------------------------------

/**
 * 対応点 4 組から src → dst のホモグラフィを求める。
 * @returns 3x3 行列（行優先）。求まらなければ null
 */
export function computeHomography(src: Point[], dst: Point[]): Matrix3 | null {
  if (src.length < 4 || dst.length < 4) return null;

  const ns = normalize(src.slice(0, 4));
  const nd = normalize(dst.slice(0, 4));

  // 各対応点が 2 本の式を与える（h8 = 1 と固定して 8 元連立）
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = ns.pts[i];
    const { x: X, y: Y } = nd.pts[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }

  const h = solveLinearSystem(A, b);
  if (!h) return null;

  const Hn: Matrix3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // 正規化を打ち消す: H = Tdst⁻¹ · Hn · Tsrc
  const H = multiply3(nd.Tinv, multiply3(Hn, ns.T));

  // h8 で正規化（スケール不定性を除く）
  if (Math.abs(H[8]) < 1e-15) return null;
  const k = 1 / H[8];
  const out = H.map(v => v * k);
  return out.every(v => isFinite(v)) ? out : null;
}

/** 点に射影変換を適用する */
export function applyHomography(H: Matrix3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-15) return { x: NaN, y: NaN };
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** 3x3 行列の逆行列（余因子展開） */
export function invertHomography(H: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;

  const inv: Matrix3 = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  if (Math.abs(inv[8]) < 1e-15) return inv;
  const k = 1 / inv[8];
  return inv.map(v => v * k);
}

/**
 * 画像上のある点における「局所的な縮尺」(px / 実単位)。
 * 射影変換では場所によって縮尺が変わるので、
 * その点まわりでヤコビ行列を評価して面積スケールの平方根を返す。
 * 校正が妥当かを画面上で確認するための表示用。
 */
export function localPxPerUnit(Hinv: Matrix3, imgPt: Point, H: Matrix3): number {
  const d = 1; // 1px ずらして差分を取る
  const p0 = applyHomography(H, imgPt);
  const px = applyHomography(H, { x: imgPt.x + d, y: imgPt.y });
  const py = applyHomography(H, { x: imgPt.x, y: imgPt.y + d });
  if (!isFinite(p0.x) || !isFinite(px.x) || !isFinite(py.x)) return 0;
  // ヤコビ行列 [∂X/∂u ∂X/∂v; ∂Y/∂u ∂Y/∂v] の行列式 = 実単位面積 / px面積
  const j11 = (px.x - p0.x) / d;
  const j21 = (px.y - p0.y) / d;
  const j12 = (py.x - p0.x) / d;
  const j22 = (py.y - p0.y) / d;
  const detJ = Math.abs(j11 * j22 - j12 * j21);
  void Hinv;
  return detJ > 1e-15 ? 1 / Math.sqrt(detJ) : 0;
}

/**
 * 四角形が凸で、自己交差していないかを判定する。
 * 4 点の順序が入れ替わっていると変換が破綻するので、入力チェックに使う。
 */
export function isConvexQuad(pts: Point[]): boolean {
  if (pts.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}
