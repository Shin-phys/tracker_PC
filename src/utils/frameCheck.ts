// src/utils/frameCheck.ts
// ============================================================
// コマの信頼性を、位置の 2 階差分から判定する。
//
// なぜ 2 階差分か
//   等加速度なら、コマ番号に対する位置の 2 階差分は一定になる。これは
//   「等加速度である」の定義そのものなので、物理の説明とデータ検査を
//   同じ道具でできる。速度に直してから見ると、微分がノイズを増幅する上に、
//   中心差分のせいで 1 コマの異常が前後 2 点へ逆向きに散る。原因が読めない。
//
// 何が引っかかるか
//   1. ファイル側のコマの時刻ずれ
//      スロー撮影を焼き直した動画では、ときどき半コマ分ずれた絵が混ざる。
//      実測した例では、240fps 刻みの素材を実効 120fps へ間引く過程で、
//      素材のコマが欠けている場所だけ隣（奇数番）の絵が使われていた。
//      追跡がどれだけ正確でも、これは動画に焼き込まれているので消せない。
//   2. 追跡の失敗
//      ブレて別のものに一致した、画面端で止まった、など。
//
//   どちらも「そのコマだけ 2 階差分が飛ぶ」形で出るので、まとめて拾える。
//
// もうひとつの限界（ブレ）
//   1 コマの移動量が対象の大きさを超えると、対象は自分の直径以上に流れて
//   写る。テンプレート照合の中心はもう対象の中心ではないので、そこから先の
//   データは使えない。これは検出ではなく計算で分かるので、区間の終点の
//   候補として先に出す。
// ============================================================

import { FrameData, Point } from '../types';

/** 疑わしいコマ 1 つ */
export interface FrameIssue {
  /** historyData 上の位置 */
  index: number;
  /** ファイル上の時刻 [s] */
  timestamp: number;
  /** 中央値からの外れ [px] */
  deviation: number;
  /** ひと続きで何コマ分が引っかかったか */
  span: number;
}

export interface TrackQuality {
  /** 2 階差分が飛んでいるコマ */
  issues: FrameIssue[];
  /** issues に入っている時刻の集合（描画側の判定用） */
  issueTimes: number[];
  /** 1 コマの移動量が対象の大きさを超え始める時刻。null なら最後まで大丈夫 */
  blurLimitTime: number | null;
  /** コマあたりの移動量の中央値 [px] */
  medianStep: number;
  /** 判定に使ったしきい値 [px]（説明表示用） */
  threshold: number;
}

export const EMPTY_QUALITY: TrackQuality = {
  issues: [], issueTimes: [], blurLimitTime: null, medianStep: 0, threshold: 0,
};

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 追跡データの点検。
 *
 * @param data     記録
 * @param objId    対象
 * @param roiWidth 枠の幅 [px]。ブレの限界を出すのに使う（0 なら判定しない）
 */
export function checkTrack(
  data: FrameData[],
  objId: string,
  roiWidth = 0
): TrackQuality {
  // 手で打った点は等間隔とは限らないので、自動追跡の連続したコマだけを見る
  const pts: { t: number; p: Point; i: number }[] = [];
  data.forEach((fd, i) => {
    const it = fd.objects[objId];
    if (it && !it.lost && !it.manual) pts.push({ t: fd.timestamp, p: { x: it.xPx, y: it.yPx }, i });
  });
  if (pts.length < 5) return EMPTY_QUALITY;

  const dts: number[] = [];
  for (let i = 1; i < pts.length; i++) dts.push(pts[i].t - pts[i - 1].t);
  const dt = median(dts);
  if (!(dt > 0)) return EMPTY_QUALITY;

  // 1 コマの移動量
  const steps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    steps.push(Math.hypot(pts[i].p.x - pts[i - 1].p.x, pts[i].p.y - pts[i - 1].p.y));
  }
  const medianStep = median(steps);

  // 2 階差分。コマが飛んでいる（シークなどで間が空いた）ところは飛ばす
  const d2: { index: number; timestamp: number; dx: number; dy: number }[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const uniform =
      Math.abs((pts[i].t - pts[i - 1].t) - dt) < dt * 0.4 &&
      Math.abs((pts[i + 1].t - pts[i].t) - dt) < dt * 0.4;
    if (!uniform) continue;
    d2.push({
      index: pts[i].i,
      timestamp: pts[i].t,
      dx: pts[i + 1].p.x - 2 * pts[i].p.x + pts[i - 1].p.x,
      dy: pts[i + 1].p.y - 2 * pts[i].p.y + pts[i - 1].p.y,
    });
  }
  if (d2.length < 3) return EMPTY_QUALITY;

  // 等加速度なら 2 階差分は一定。その一定値（中央値）からの距離を外れ具合とする。
  // x と y を別々に見ずベクトルで見るのは、斜方投射でも落下でも同じ式で済むから。
  const mx = median(d2.map(v => v.dx));
  const my = median(d2.map(v => v.dy));
  const dist = d2.map(v => Math.hypot(v.dx - mx, v.dy - my));

  // ばらつきの尺度は MAD（外れ値に引きずられない）。
  // 下限を置くのは、きれいなデータで微小なゆらぎまで拾わないため。
  const mad = median(dist.map(d => Math.abs(d - median(dist))));
  const threshold = Math.max(4 * mad, 0.2 * medianStep, 1.5);

  // 1 コマのずれは 2 階差分を 3 つ汚す（−δ, +2δ, −δ の形）。そのまま並べると
  // 1 か所の異常が 3 個に見えるので、連続した外れは「いちばん大きいコマ」＝
  // ずれた本人にまとめて 1 件として数える。
  const flagged: number[] = [];
  dist.forEach((d, i) => { if (d > threshold) flagged.push(i); });

  const issues: FrameIssue[] = [];
  for (let i = 0; i < flagged.length;) {
    let j = i;
    while (j + 1 < flagged.length && flagged[j + 1] === flagged[j] + 1) j++;
    let peak = flagged[i];
    for (let k = i; k <= j; k++) if (dist[flagged[k]] > dist[peak]) peak = flagged[k];
    issues.push({
      index: d2[peak].index,
      timestamp: d2[peak].timestamp,
      deviation: dist[peak],
      span: j - i + 1,
    });
    i = j + 1;
  }

  // ブレの限界。1 コマの移動量が枠の 0.7 倍を超えたら、対象は自分の大きさ
  // 以上に流れて写っている（枠は対象より一回り大きいので 0.7 を掛ける）
  let blurLimitTime: number | null = null;
  if (roiWidth > 0) {
    const limit = roiWidth * 0.7;
    for (let i = 1; i < pts.length; i++) {
      if (steps[i - 1] > limit) { blurLimitTime = pts[i - 1].t; break; }
    }
  }

  return {
    issues,
    issueTimes: flagged.map(i => d2[i].timestamp),
    blurLimitTime,
    medianStep,
    threshold,
  };
}
