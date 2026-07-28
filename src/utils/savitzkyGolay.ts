/**
 * Savitzky-Golay フィルタ実装
 * 時系列データ (1次元配列) に多項式フィット平滑化を適用して
 * 手ブレや位置の微振動（ジッター）を除去する
 */

/**
 * SGフィルタの畳み込み係数を計算
 * @param windowSize ウィンドウ幅（奇数）
 * @param polyOrder  多項式次数
 */
function getSavitzkyGolayCoefficients(windowSize: number, polyOrder: number): number[] {
  // ウィンドウサイズは奇数である必要がある
  if (windowSize % 2 === 0) windowSize += 1;

  const m = Math.floor(windowSize / 2);
  const n = polyOrder;

  // J 行列 ( (2m+1) x (n+1) ) の作成
  const J: number[][] = [];
  for (let i = -m; i <= m; i++) {
    const row: number[] = [];
    for (let j = 0; j <= n; j++) {
      row.push(Math.pow(i, j));
    }
    J.push(row);
  }

  // J_t * J ( (n+1) x (n+1) ) の計算
  const JTJ: number[][] = Array(n + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      let sum = 0;
      for (let i = 0; i < 2 * m + 1; i++) sum += J[i][r] * J[i][c];
      JTJ[r][c] = sum;
    }
  }

  // JTJ の逆行列
  const invJTJ = invertMatrix(JTJ);
  if (!invJTJ) {
    // 逆行列が求まらない場合は単純移動平均にフォールバック
    return Array(windowSize).fill(1 / windowSize);
  }

  // C = (J^T * J)^-1 * J^T の 0行目（平滑化用係数）
  const coeffs: number[] = [];
  for (let i = 0; i < 2 * m + 1; i++) {
    let sum = 0;
    for (let j = 0; j <= n; j++) sum += invJTJ[0][j] * J[i][j];
    coeffs.push(sum);
  }

  return coeffs;
}

/**
 * ガウス・ジョルダン法による正方行列の逆行列計算
 */
function invertMatrix(M: number[][]): number[][] | null {
  const n = M.length;
  // 拡大行列 [M | I]
  const A: number[][] = M.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });

  for (let i = 0; i < n; i++) {
    // ピボット選択
    let maxEl = Math.abs(A[i][i]);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > maxEl) {
        maxEl = Math.abs(A[k][i]);
        maxRow = k;
      }
    }
    if (maxEl < 1e-12) return null; // 特異行列

    // 行交換
    const temp = A[i];
    A[i] = A[maxRow];
    A[maxRow] = temp;

    // 対角成分を1に正規化
    const p = A[i][i];
    for (let j = i; j < 2 * n; j++) A[i][j] /= p;

    // 他の行を消去
    for (let k = 0; k < n; k++) {
      if (k !== i) {
        const factor = A[k][i];
        for (let j = i; j < 2 * n; j++) A[k][j] -= factor * A[i][j];
      }
    }
  }

  // 右半分を取り出す
  return A.map(row => row.slice(n));
}

/**
 * 時系列配列に Savitzky-Golay 平滑化を適用
 * @param data        数値データの配列
 * @param windowSize  ウィンドウ幅（奇数、例: 5）
 * @param polyOrder   多項式次数（例: 2 または 3）
 * @returns           平滑化後のデータ配列
 */
export function applySavitzkyGolay(
  data: number[],
  windowSize: number = 5,
  polyOrder: number = 2
): number[] {
  if (!data || data.length === 0) return [];
  if (data.length < windowSize || windowSize <= polyOrder) {
    return [...data]; // データ長不足時はそのまま返す
  }

  // 奇数サイズを保証
  const ws = windowSize % 2 === 0 ? windowSize + 1 : windowSize;
  const half = Math.floor(ws / 2);
  const coeffs = getSavitzkyGolayCoefficients(ws, polyOrder);
  const result: number[] = new Array(data.length);

  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let weightSum = 0;
    for (let j = -half; j <= half; j++) {
      // 端はクランプ（境界の外はデータ端値を使用）
      const index = Math.min(Math.max(i + j, 0), data.length - 1);
      const coeff = coeffs[j + half];
      sum += data[index] * coeff;
      weightSum += coeff;
    }
    result[i] = weightSum !== 0 ? sum / weightSum : data[i];
  }

  return result;
}
