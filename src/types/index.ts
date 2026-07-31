// ========================================
// 型定義 — MotionTrace Pro Ver.2.1
// ========================================

/** 追跡状態
 *  idle     : 枠未指定 / 待機
 *  tracking : 正常追跡中
 *  lost     : 見失い（再指定すれば復帰可能）
 *  exited   : 画面外へ退出（追尾を打ち切り。以後このObjectは更新されない）
 */
export type ObjectStatus = 'idle' | 'tracking' | 'lost' | 'exited';

/** 追跡オブジェクトの識別情報 */
export interface TrackedObject {
  id: string;           // 'Obj1' | 'Obj2' | 'Obj3' | 'Obj4' | 'Obj5'
  name: string;         // 表示名
  color: string;        // HEXカラー (#ff3b30 等)
  active: boolean;      // 追跡対象かどうか
  status: ObjectStatus;
  roi: Rect | null;     // 追跡領域（ピクセル座標）
  center: Point | null; // サブピクセル中心座標
}

/** 矩形領域 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 2次元座標点 */
export interface Point {
  x: number;
  y: number;
}

/** フレームごとの追跡ログ */
export interface FrameData {
  frameIndex: number;
  timestamp: number;    // 秒単位 t (s)
  objects: {
    [objId: string]: {
      xPx: number;
      yPx: number;
      xM: number;       // 実単位でのX座標
      yM: number;       // 実単位でのY座標
      vx: number;       // X方向速度 (単位/s)
      vy: number;       // Y方向速度 (単位/s)
      speedMs: number;  // 速さ (単位/s)
      score: number;    // マッチングスコア 0-1
      lost: boolean;
      manual?: boolean; // 手動で位置を修正したフレーム
    };
  };
  distances: {
    [pairKey: string]: number; // 例: "Obj1-Obj2": 相対距離(単位)
  };
}

/** スケール校正モード
 *  line  : 2点間の長さ。光軸が運動面に垂直なときだけ正しい
 *  plane : 四角形の四隅を指定して射影変換。斜めから撮っても正しい
 *  box   : 追跡枠の幅を基準にする簡易モード
 */
export type CalibrationMode = 'box' | 'line' | 'plane';

/** 長さの単位 */
export type LengthUnit = 'm' | 'cm' | 'mm';

/** スケール校正設定 */
export interface ScaleCalibration {
  mode: CalibrationMode;
  targetObjId?: string;     // boxモードの基準オブジェクト
  realSizeValue: number;    // line/box モードの入力実長 (例: 10)
  unit: LengthUnit;         // 'm' | 'cm' | 'mm'
  linePoints: Point[];      // 2点間指定モードの座標
  pxPerUnit: number;        // line/box モードの計算結果: 1単位あたりのピクセル数

  // ---- plane モード ----
  /** 基準四角形の四隅（画像座標）。クリック順に 左上→右上→右下→左下 */
  planePoints: Point[];
  /** 基準四角形の実寸・横 */
  planeWidth: number;
  /** 基準四角形の実寸・縦 */
  planeHeight: number;
  /** 画像座標 → 実寸座標 の 3x3 行列（行優先・長さ9）。未校正なら null */
  homography: number[] | null;

  /** Y軸を上向きにする（物理では上向きが自然。既定 true） */
  yUp: boolean;

  /**
   * 座標の原点（画像座標）。null なら従来どおり画像の左上、
   * yUp のときは左下を原点にする。
   *
   * 斜面の始点やレールの目盛り 0 を原点に取れると、
   * CSV の x がそのまま「実験装置上の位置」になり、
   * 表計算側でオフセットを引く手間がなくなる。
   */
  origin: Point | null;
}

/** マーカーの明暗（重心補正を使うときのみ意味を持つ） */
export type MarkerMode = 'white' | 'dark';

/** 追跡アルゴリズム設定 */
export interface TrackingSettings {
  /**
   * サブピクセル補間。相関マップのピーク近傍 3x3 に 2 次曲面を
   * 最小二乗フィットして真のピーク位置を求める。
   * 実測でガタつき（2階差分RMS）が 1.06px → 0.35px に低減。既定 ON。
   */
  subpixel: boolean;
  /**
   * 重心補正。マーカーが背景から明確に分離できる場合
   * （暗い対象の上の白点など）だけ有効。
   * 背景が明るい／マーカーが小さい場合はむしろ悪化するため既定 OFF。
   */
  centroidRefine: boolean;
  /** 重心補正時のマーカー明暗 */
  markerMode: MarkerMode;
  /** 重心計算の閾値レベル (0-1)。大きいほど明るい芯だけを使う */
  centroidLevel: number;
  /** ロスト判定のマッチングスコア閾値 (0-1) */
  lostThreshold: number;
  /** 探索窓の大きさ（ROIサイズの倍率） */
  searchScale: number;
  /** 画面端から何px以内に来たら「画面外」と判定するか */
  exitMargin: number;
  /** 画面外に出たら追尾を打ち切るか */
  stopOnExit: boolean;
}

/** 平滑化の方式 */
export type FilterKind = 'butterworth' | 'savgol' | 'none';

/** 座標フィルタ設定 */
export interface FilterSettings {
  enabled: boolean;
  kind: FilterKind;
  /** butterworth: 遮断周波数を自動選択するか */
  autoCutoff: boolean;
  /** butterworth: 手動指定時の遮断周波数 [Hz] */
  cutoffHz: number;
  /** savgol: ウィンドウ幅（奇数） */
  windowSize: number;
  /** savgol: 多項式次数 */
  polynomialOrder: number;
}

/** フィルタ適用の結果メタ情報（UI 表示用） */
export interface FilterReport {
  /** オブジェクトごとに実際に使われた遮断周波数 [Hz] */
  cutoffs: { [objId: string]: number };
  /** サンプリング周波数 [Hz] */
  sampleRate: number;
}

/** FPS設定 */
export interface FpsSettings {
  /**
   * ファイルのフレームレート。実フレーム間隔（mediaTime の差）から自動計測する。
   * 用途はコマ送りの刻み幅と表示のみ。手入力はできない
   * （正しい自動計測値を悪い値で潰すだけで、利点がなかった）。
   */
  value: number;

  /**
   * 撮影時のフレームレート [fps]。スロー動画の実時間換算に使う。
   *
   * スマホの 240fps スローは 30fps のファイルとして書き出されることが多く、
   * その場合ファイル上の 8 秒が実際には 1 秒になる。
   * mediaTime は「ファイル上の時刻」なので、そのまま使うと速度が 1/8 になる。
   *
   *   実時間 = ファイル上の時刻 × (value ÷ captureFps)
   *
   * 0 は「ファイルfps と同じ」＝等倍（通常の動画）を意味する。
   */
  captureFps: number;
}

/** 単位をメートルに換算する係数 */
export const UNIT_TO_M: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
};

/** 追跡設定の既定値 */
export const DEFAULT_TRACKING: TrackingSettings = {
  subpixel: true,
  centroidRefine: false,
  markerMode: 'white',
  centroidLevel: 0.5,
  lostThreshold: 0.45,
  searchScale: 1.8,
  exitMargin: 2,
  stopOnExit: true,
};
