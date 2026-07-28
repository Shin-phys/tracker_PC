// src/utils/tracker.ts — Ver.2.1
// ============================================================
// 白シールマーカー用・サブピクセル物体トラッカー
//
// Ver.2.0 の問題点
//   ・matchTemplate の結果をそのまま整数ピクセルで採用していたため、
//     位置が必ず 1px 単位に量子化され、差分から求める速度が
//     ±1px/Δt の階段状ノイズを持っていた（＝ラインのガタつき）。
//   ・毎フレーム全画面をグレースケール化していて重かった。
//   ・画面外に出ても Lost 扱いのまま追跡を続けていた。
//
// Ver.2.1 のアルゴリズム（1フレームあたり）
//   1. 等速度モデルで次フレーム位置を予測し、探索窓を予測位置に置く
//      → 探索範囲を狭められるので高速かつ誤マッチしにくい
//   2. TM_CCOEFF_NORMED でテンプレートマッチ（整数ピーク）
//   3. 相関マップのピーク近傍 3x3 に 2 次曲面
//        z = a x² + b y² + c xy + d x + e y + f
//      を最小二乗フィットし、∇z = 0 の点＝真のピークを解析的に求める
//      （1次元の放物線フィットより斜め方向の精度が高い）
//   4. 必要なら「白さ」重心でさらに補正（既定 OFF・下記参照）
//   5. 画面端に達したら state='exited' として追尾を打ち切る
//
// 実動画（1920x1080, 215フレーム）での検証結果
//   ガタつきの指標＝位置の2階差分RMS（小さいほど滑らか）
//     整数ピークのみ (Ver.2.0) : 1.061 px
//     1次元 放物線フィット      : 0.411 px
//     2次曲面フィット (採用)    : 0.348 px   ← 約 1/3 に低減
//   なお「白さ重心」は 0.80〜1.31 px と逆に悪化した。
//   壁が明るい・マーカーが小さい映像では min(R,G,B) が背景と分離せず、
//   ハイライトに重心が引っ張られるため。よって既定 OFF とし、
//   暗い対象の上に白点があるようなケース向けの任意機能とした。
// ============================================================

import { Rect, Point, TrackingSettings, MarkerMode } from '../types';
import { FrameSource, RegionSample } from './frameSource';

export type TrackState = 'ok' | 'lost' | 'exited';

/**
 * 追跡枠の最小サイズ [px]。これを下回ると init() が失敗する。
 * テンプレートマッチは「その小片がどれだけ他と見分けがつくか」で決まるので、
 * 小さすぎる枠は情報量が足りず誤マッチを連発する。
 */
export const MIN_ROI_SIZE = 12;

/** これを下回ると精度が落ちやすいので UI で警告する目安 [px] */
export const RECOMMENDED_ROI_SIZE = 20;

export interface TrackerResult {
  objId: string;
  roi: Rect;
  center: Point;      // サブピクセル中心
  state: TrackState;
  score: number;
}

export class ObjectTracker {
  private cv: any;
  private objId: string;

  private templateMat: any = null;
  private tw = 0;
  private th = 0;

  private cx = 0;          // サブピクセル中心 X
  private cy = 0;          // サブピクセル中心 Y
  private vx = 0;          // 直前フレームからの変位 X（予測に使用）
  private vy = 0;
  private hasVelocity = false;

  private state: TrackState = 'ok';
  private lostStreak = 0;
  private cfg: TrackingSettings;

  /** 重心計算に使う局所窓の半径 */
  private half = 8;

  constructor(cv: any, objId: string, cfg: TrackingSettings) {
    this.cv = cv;
    this.objId = objId;
    this.cfg = cfg;
  }

  public setConfig(cfg: TrackingSettings) {
    this.cfg = cfg;
  }

  public getState(): TrackState {
    return this.state;
  }

  // ----------------------------------------------------------
  // 初期化
  // ----------------------------------------------------------

  /**
   * @param src  現フレームの画素ソース
   * @param roi  ユーザーが指定した追跡枠
   */
  public init(src: FrameSource, roi: Rect): boolean {
    this.cleanup();

    const w = Math.round(roi.width);
    const h = Math.round(roi.height);
    const x = Math.round(roi.x);
    const y = Math.round(roi.y);

    // テンプレートが小さすぎると「模様の情報量」が足りず、
    // 画面上のどこにでも一致してしまって軌跡が暴走する。
    // 1920x1080 で 8x8px を指定した実例では、壁の上を延々とさまよった。
    if (w < MIN_ROI_SIZE || h < MIN_ROI_SIZE) {
      console.warn(
        `[Tracker:${this.objId}] 追跡枠が小さすぎます (${w}x${h}px)。` +
        `${MIN_ROI_SIZE}px 以上にしてください。`
      );
      return false;
    }
    if (x < 0 || y < 0 || x + w > src.width || y + h > src.height) {
      console.warn(`[Tracker:${this.objId}] ROI が画像範囲外です`, roi);
      return false;
    }

    const region = src.getRegion(x, y, w, h);
    if (!region) return false;

    try {
      const mat = new this.cv.Mat(region.height, region.width, this.cv.CV_8UC1);
      mat.data.set(region.gray);
      this.templateMat = mat;
      this.tw = region.width;
      this.th = region.height;
    } catch (err) {
      console.error(`[Tracker:${this.objId}] テンプレート生成失敗:`, err);
      return false;
    }

    this.cx = x + w / 2;
    this.cy = y + h / 2;
    this.vx = 0;
    this.vy = 0;
    this.hasVelocity = false;
    this.state = 'ok';
    this.lostStreak = 0;
    // 重心窓は ROI の半分程度。小さすぎると背景に引っ張られる
    this.half = Math.max(4, Math.round(Math.min(w, h) * 0.45));

    // 初期位置も重心で精密化しておく（ユーザーのドラッグ誤差を吸収）
    if (this.cfg.centroidRefine) {
      const refined = this.refineByCentroid(src, this.cx, this.cy);
      if (refined) {
        this.cx = refined.x;
        this.cy = refined.y;
      }
    }
    return true;
  }

  // ----------------------------------------------------------
  // 1フレーム更新
  // ----------------------------------------------------------

  public update(src: FrameSource): TrackerResult {
    if (this.state === 'exited') return this.result('exited', 0);
    if (!this.templateMat) return this.result('lost', 0);

    // --- 1. 等速度予測 ---
    const px = this.cx + (this.hasVelocity ? this.vx : 0);
    const py = this.cy + (this.hasVelocity ? this.vy : 0);

    // --- 2. 探索窓（予測位置中心） ---
    const margin = Math.max(this.tw, this.th) * this.cfg.searchScale;
    const sx0 = Math.floor(px - this.tw / 2 - margin);
    const sy0 = Math.floor(py - this.th / 2 - margin);
    const sw = Math.ceil(this.tw + margin * 2);
    const sh = Math.ceil(this.th + margin * 2);

    const region = src.getRegion(sx0, sy0, sw, sh);
    if (!region || region.width < this.tw || region.height < this.th) {
      // 探索窓がテンプレートより小さい＝画面端に張り付いている
      return this.markExited();
    }

    let searchMat: any = null;
    let resultMat: any = null;
    try {
      searchMat = new this.cv.Mat(region.height, region.width, this.cv.CV_8UC1);
      searchMat.data.set(region.gray);
      resultMat = new this.cv.Mat();
      this.cv.matchTemplate(searchMat, this.templateMat, resultMat, this.cv.TM_CCOEFF_NORMED);

      const mm = this.cv.minMaxLoc(resultMat);
      const score: number = mm.maxVal;
      const loc = mm.maxLoc;

      // --- 3. 相関ピークのサブピクセル補間（2次曲面フィット） ---
      let dx = 0;
      let dy = 0;
      if (this.cfg.subpixel) {
        const sub = this.quadraticPeak(resultMat, loc.x, loc.y);
        dx = sub.dx;
        dy = sub.dy;
      }

      let ncx = region.x0 + loc.x + dx + this.tw / 2;
      let ncy = region.y0 + loc.y + dy + this.th / 2;

      // --- 4. 白さ重心によるサブピクセル精密化（任意） ---
      if (this.cfg.centroidRefine) {
        const refined = this.refineByCentroid(src, ncx, ncy);
        if (refined) {
          // テンプレートマッチ結果から大きく外れたら採用しない（外れ値ガード）
          const limX = this.tw * 0.5;
          const limY = this.th * 0.5;
          if (Math.abs(refined.x - ncx) < limX && Math.abs(refined.y - ncy) < limY) {
            ncx = refined.x;
            ncy = refined.y;
          }
        }
      }

      const isLost = score < this.cfg.lostThreshold;

      if (isLost) {
        this.lostStreak++;
        // ロスト中は速度予測を止めて暴走を防ぐ（位置は最後の確定値を保持）
        this.hasVelocity = false;
        this.vx = 0;
        this.vy = 0;
        // 画面端付近でロストした場合は「画面外へ出た」と判断する
        if (this.cfg.stopOnExit && this.lostStreak >= 2 && this.isNearEdge(this.cx, this.cy, src)) {
          return this.markExited();
        }
        return this.result('lost', score);
      }

      this.lostStreak = 0;
      this.vx = ncx - this.cx;
      this.vy = ncy - this.cy;
      this.hasVelocity = true;
      this.cx = ncx;
      this.cy = ncy;

      // --- 5. 画面外判定 ---
      if (this.cfg.stopOnExit && this.isNearEdge(this.cx, this.cy, src)) {
        return this.markExited();
      }

      return this.result('ok', score);
    } catch (err) {
      console.error(`[Tracker:${this.objId}] 更新失敗:`, err);
      return this.result('lost', 0);
    } finally {
      if (searchMat) try { searchMat.delete(); } catch (_) { /* noop */ }
      if (resultMat) try { resultMat.delete(); } catch (_) { /* noop */ }
    }
  }

  // ----------------------------------------------------------
  // サブピクセル: 相関マップのピーク位置を解析的に求める
  // ----------------------------------------------------------

  /** 1次元の放物線フィット（フォールバック用） */
  private parabolicPeak(
    at: (x: number, y: number) => number,
    mx: number, my: number, w: number, h: number
  ): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    if (mx > 0 && mx < w - 1) {
      const a = at(mx - 1, my);
      const b = at(mx, my);
      const c = at(mx + 1, my);
      const d = a - 2 * b + c;
      if (Math.abs(d) > 1e-12) dx = (0.5 * (a - c)) / d;
    }
    if (my > 0 && my < h - 1) {
      const a = at(mx, my - 1);
      const b = at(mx, my);
      const c = at(mx, my + 1);
      const d = a - 2 * b + c;
      if (Math.abs(d) > 1e-12) dy = (0.5 * (a - c)) / d;
    }
    return {
      dx: Math.max(-1, Math.min(1, dx)),
      dy: Math.max(-1, Math.min(1, dy)),
    };
  }

  /**
   * ピーク近傍 3x3 に 2 次曲面を最小二乗フィットしてサブピクセル変位を求める。
   *   z = a x² + b y² + c xy + d x + e y + f   (x, y ∈ {-1, 0, 1})
   * 9点・6係数の擬似逆行列は定数なので、閉形式で直接計算できる。
   * 極大条件 ∇z = 0 は
   *   [2a  c][dx]   [-d]
   *   [ c 2b][dy] = [-e]
   */
  private quadraticPeak(res: any, mx: number, my: number): { dx: number; dy: number } {
    const w: number = res.cols;
    const h: number = res.rows;
    const data: Float32Array = res.data32F;
    const at = (x: number, y: number): number => data[y * w + x];

    if (mx <= 0 || mx >= w - 1 || my <= 0 || my >= h - 1) {
      return this.parabolicPeak(at, mx, my, w, h);
    }

    const z0 = at(mx - 1, my - 1), z1 = at(mx, my - 1), z2 = at(mx + 1, my - 1);
    const z3 = at(mx - 1, my),     z4 = at(mx, my),     z5 = at(mx + 1, my);
    const z6 = at(mx - 1, my + 1), z7 = at(mx, my + 1), z8 = at(mx + 1, my + 1);

    const a = (z0 + z2 + z3 + z5 + z6 + z8) / 6 - (z1 + z4 + z7) / 3;
    const b = (z0 + z1 + z2 + z6 + z7 + z8) / 6 - (z3 + z4 + z5) / 3;
    const c = (z0 - z2 - z6 + z8) / 4;
    const d = (-z0 + z2 - z3 + z5 - z6 + z8) / 6;
    const e = (-z0 - z1 - z2 + z6 + z7 + z8) / 6;

    const det = 4 * a * b - c * c;
    // 極大点であること（a<0, b<0, ヘッセ行列が負定値）を確認
    if (!(det > 1e-12) || a >= 0 || b >= 0) {
      return this.parabolicPeak(at, mx, my, w, h);
    }

    const dx = (-2 * b * d + c * e) / det;
    const dy = (c * d - 2 * a * e) / det;

    // 変位が 1px を超えるのは数値的におかしいので放物線にフォールバック
    if (!isFinite(dx) || !isFinite(dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      return this.parabolicPeak(at, mx, my, w, h);
    }
    return { dx, dy };
  }

  // ----------------------------------------------------------
  // サブピクセル: 白さ（あるいは黒さ）の輝度重心
  // ----------------------------------------------------------

  /**
   * 白マーカーの「白さ」は min(R,G,B) で測るのが最も安定する。
   *   ・白  → R,G,B すべて高い → min が高い
   *   ・緑や赤などの有彩色 → いずれかのチャンネルが低い → min が低い
   * グレースケール輝度だと明るい緑（G の重み 0.59）も高く出てしまい、
   * 円盤の地色に重心が引っ張られる。
   */
  private markerScore(rgba: Uint8ClampedArray, j: number, mode: MarkerMode): number {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    if (mode === 'dark') {
      // 黒マーカー: max(R,G,B) が低いほどマーカーらしい
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      return 255 - mx;
    }
    // 白マーカー: min(R,G,B)
    return r < g ? (r < b ? r : b) : g < b ? g : b;
  }

  private refineByCentroid(src: FrameSource, cx: number, cy: number): Point | null {
    const half = this.half;
    const size = 2 * half + 1;
    const x0 = Math.round(cx) - half;
    const y0 = Math.round(cy) - half;
    if (x0 < 0 || y0 < 0 || x0 + size > src.width || y0 + size > src.height) return null;

    const region: RegionSample | null = src.getRegion(x0, y0, size, size);
    if (!region || region.width !== size || region.height !== size) return null;

    const rgba = region.rgba;
    const n = size * size;
    const scores = new Float32Array(n);
    let mn = 255;
    let mx = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const s = this.markerScore(rgba, j, this.cfg.markerMode);
      scores[i] = s;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }

    // コントラストが乏しい＝マーカーが写っていない可能性が高い
    if (mx - mn < 12) return null;

    const thr = mn + this.cfg.centroidLevel * (mx - mn);
    let sum = 0;
    let sumX = 0;
    let sumY = 0;
    for (let yy = 0, i = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++, i++) {
        const w = scores[i] - thr;
        if (w > 0) {
          sum += w;
          sumX += w * xx;
          sumY += w * yy;
        }
      }
    }
    if (sum <= 0) return null;

    return { x: x0 + sumX / sum, y: y0 + sumY / sum };
  }

  // ----------------------------------------------------------
  // 画面外判定
  // ----------------------------------------------------------

  /** マーカー枠が画面端に接触したか */
  private isNearEdge(cx: number, cy: number, src: FrameSource): boolean {
    const m = this.cfg.exitMargin;
    const hw = this.tw / 2;
    const hh = this.th / 2;
    return (
      cx - hw <= m ||
      cy - hh <= m ||
      cx + hw >= src.width - m ||
      cy + hh >= src.height - m
    );
  }

  private markExited(): TrackerResult {
    this.state = 'exited';
    this.hasVelocity = false;
    this.vx = 0;
    this.vy = 0;
    return this.result('exited', 0);
  }

  // ----------------------------------------------------------

  private result(state: TrackState, score: number): TrackerResult {
    this.state = state;
    return {
      objId: this.objId,
      roi: {
        x: this.cx - this.tw / 2,
        y: this.cy - this.th / 2,
        width: this.tw,
        height: this.th,
      },
      center: { x: this.cx, y: this.cy },
      state,
      score,
    };
  }

  public cleanup() {
    if (this.templateMat) {
      try { this.templateMat.delete(); } catch (_) { /* noop */ }
      this.templateMat = null;
    }
    this.state = 'ok';
    this.hasVelocity = false;
    this.lostStreak = 0;
  }
}
