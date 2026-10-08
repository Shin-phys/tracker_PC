// src/components/VideoCanvas.tsx — Ver.2.1
// ============================================================
// 改修点
//  ① 静止画が出ない問題
//     loadedmetadata → loadeddata → seeked の各段階で確実に描画し、
//     さらに requestVideoFrameCallback で「デコード済みフレームが
//     実際に用意された瞬間」を捕まえて描画する。
//     （Ver.2.0 は状態変化時の useEffect 頼みだったため、
//       最初のフレームがデコードされる前に描画して黒画面になっていた）
//
//  ② フレーム処理の厳密化
//     requestAnimationFrame（画面の描画周期＝60Hz）で
//     video.currentTime を見る方式は、動画の実フレームと同期しないため
//     同じフレームを二重処理したり、逆に取りこぼしたりする。
//     requestVideoFrameCallback に切り替え、
//     「提示された実フレーム」ごとに 1 回だけ処理し、
//     時刻は動画本来の mediaTime を使う。
//     ついでに実フレーム間隔から FPS を自動計測する。
//
//  ③ スケール校正
//     ドラッグで一気に 2 点を引ける。引いた後も端点を掴んで微調整できる。
//     矢印キーで 1px 単位のナッジも可能。
//
//  ④ 画面外に出た物体は 'exited' として表示し、軌跡もそこで終端する。
// ============================================================

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  TrackedObject, ScaleCalibration, Rect, Point, FrameData, FpsSettings, HaltInfo,
  SeedResult,
} from '../types';
import { recalcScale, pixelDistance } from '../utils/calibration';
import { applyHomography, invertHomography, Matrix3 } from '../utils/homography';
import { MIN_ROI_SIZE, RECOMMENDED_ROI_SIZE } from '../utils/tracker';
import { stepFrames, measureFileFps, seekToFrameTime } from '../utils/videoFrame';
import { medianDt } from '../utils/butterworth';
import {
  nextManualTarget, countManualPoints, manualStepInterval,
  recommendManualStep, MANUAL_INTERVAL_WARN,
} from '../utils/manualTrack';
import { timeScale } from '../utils/timeScale';
import { drawCrosshair, drawCalibPoint } from '../utils/overlay';
import { checkTrack } from '../utils/frameCheck';
import { pointsBefore, TrailPoint } from '../utils/trailEdit';
import { SEED_FRAMES } from '../types';
import {
  TimeRange, FULL_RANGE, hasRange, rangeStart, rangeEnd, rangeSpan,
  countInRange, MIN_RANGE_POINTS,
  earliestRoiTime, restartTimeFor, roiTimeSpread, sameFrameTolerance,
} from '../utils/timeRange';
import {
  Play, Pause, RotateCcw, Upload, Crosshair, ZoomIn, ZoomOut,
  Eraser, ChevronLeft, ChevronRight, Gauge, Hand, MousePointerClick, Undo2,
  Scissors, CornerDownLeft, CornerDownRight, XCircle, ListVideo, Square as StopIcon,
  Zap, SkipBack, Scissors as CutIcon, Check, Maximize2,
} from 'lucide-react';

interface VideoCanvasProps {
  objects: TrackedObject[];
  selectedObjId: string;
  onSelectObjId: (id: string) => void;
  onUpdateRoi: (id: string, roi: Rect, videoEl?: HTMLVideoElement) => void;
  /** 追跡点を手で直す。記録データを書き換えられたかを返す */
  onManualCorrect: (id: string, center: Point, timestamp: number, videoEl?: HTMLVideoElement) => boolean;
  /** 手動トラッキングで 1 点打つ。そのコマを打ち切ったら true */
  onManualPlace: (id: string, center: Point, fileTime: number) => boolean;
  /** 手動トラッキングの直前の 1 点を取り消す */
  onManualUndo: () => boolean;
  /**
   * 2 点目を指す。数コマ先で同じ対象を指してもらう。
   * 戻り値は画面に出す一言（空なら何も言わない）。
   * videoEl を渡すのは、そのコマでテンプレートが滑らないかを実測するため。
   */
  onSeedPoint: (
    objId: string, point: Point, fileTime: number, videoEl?: HTMLVideoElement
  ) => SeedResult;
  /** 追跡が暴れたときの一時停止要求。増えるたびに止める */
  pauseAt: number;
  /** 追跡が飛んで止めた、という事実。null なら何も起きていない */
  halt: HaltInfo | null;
  /** keepUntil のコマまでを残し、それより後を捨てる。戻り値は捨てたコマ数 */
  onTruncateAfter: (keepUntil: number) => number;
  /** 1 点だけ消す。グラフを見て後から外れ値に気づいたとき用 */
  onDropPoint: (objId: string, t: number) => boolean;
  /**
   * 止めた案内を閉じる。
   * accept=true は「誤検出だった」＝印を外して当分検出を見送る。
   * false は「自分で直す」＝印は残したまま案内だけ閉じる。
   */
  onDismissHalt: (accept: boolean) => void;
  calibration: ScaleCalibration;
  onUpdateCalibration: (calib: ScaleCalibration) => void;
  onProcessFrame: (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => void;
  historyData: FrameData[];
  onResetData: () => void;
  /** やり直し。実際に消したら true（確認をキャンセルしたら false）。
   *  引数は「戻る先の時刻」。軌跡が残っていれば、そのコマで物体がいた
   *  位置へ枠を戻すのに使う。 */
  onClearTrail: (restartAt?: number | null) => boolean;
  /** 記録を即座に画面へ反映させる（全コマ処理の最後で使う） */
  onFlushHistory?: () => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  fpsSettings: FpsSettings;
  setFpsSettings: (fps: FpsSettings) => void;
  isLineCalibrating: boolean;
  setIsLineCalibrating: (v: boolean) => void;
  onVideoSize?: (s: { width: number; height: number }) => void;
  /** 動画の長さ [s]。時間軸の確認表示に使う */
  onVideoDuration?: (d: number) => void;
  /** グラフのクリックから届くシーク指示。n は連番（同じ時刻の再指示を拾うため） */
  seekRequest?: { t: number; n: number } | null;
  /** 解析区間（始点・終点、ファイル上の時刻 [s]） */
  timeRange: TimeRange;
  onChangeTimeRange: (r: TimeRange) => void;
}

/** 軌跡として表示する最大ポイント数（描画負荷の上限） */
const MAX_TRAIL_POINTS = 2000;
/** 校正点を掴める距離（canvas ピクセル） */
const HANDLE_RADIUS = 14;
/** 虫めがねの倍率と一辺（画面ピクセル） */
const LOUPE_MAG = 3;
const LOUPE_SIZE = 120;
/** 「ここまでは正しい」を選ばせる候補の数 */
const PICK_POINTS = 24;

type DragMode =
  | null
  | 'roi'
  | 'calib-new' | 'calib-p1' | 'calib-p2'
  | 'plane-corner'
  | 'manual'
  | 'seed';

/**
 * 再生速度。0.0625 (=1/16) は **Chrome が受け付ける下限**で、
 * これより遅い値を代入すると NotSupportedError が飛ぶ（実測で確認）。
 * もっと遅くしたい場面は「全コマ処理」で解決するのが筋なので、
 * ここは下限までにとどめる。
 */
const PLAYBACK_RATES: { v: number; label: string }[] = [
  { v: 0.0625, label: '1/16' },
  { v: 0.125,  label: '1/8'  },
  { v: 0.25,   label: '1/4'  },
  { v: 0.5,    label: '1/2'  },
  { v: 1,      label: '1×'   },
];

export const VideoCanvas: React.FC<VideoCanvasProps> = ({
  objects, selectedObjId, onUpdateRoi, onManualCorrect, onManualPlace, onManualUndo,
  calibration, onUpdateCalibration, onProcessFrame,
  onSeedPoint,
  historyData, onResetData, onClearTrail, onFlushHistory, isPlaying, setIsPlaying,
  fpsSettings, setFpsSettings,
  isLineCalibrating, setIsLineCalibrating, onVideoSize, onVideoDuration, seekRequest, pauseAt,
  halt, onTruncateAfter, onDismissHalt, onDropPoint,
  timeRange, onChangeTimeRange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);

  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState({ width: 640, height: 360 });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  const [zoom, setZoom] = useState(1.0);
  const [isSquareMode, setIsSquareMode] = useState(true);
  const [showTrail, setShowTrail] = useState(true);

  // ドラッグ状態
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  /** plane 校正でドラッグ中の頂点 index、手動修正中のオブジェクトID */
  const [dragIndex, setDragIndex] = useState(-1);
  /**
   * 矢印キーで動かす校正点。null なら誰も選んでいない。
   * 「どの点が動くのか」が見えないままキーで動かすと、直したつもりで
   * 反対の点を動かしていることがある。選択中の点は映像上で太く描く。
   */
  const [calibFocus, setCalibFocus] = useState<number | null>(null);
  const [manualObjId, setManualObjId] = useState<string | null>(null);
  /**
   * いま表示されているフレームの実時刻（mediaTime）。
   * 「要求した時刻」ではなくブラウザが実際に見せたフレームの時刻なので、
   * 手動で点を打つときはこの値を記録する。
   */
  const frameTimeRef = useRef(0);
  /** コマ送りの多重実行を防ぐ（連打でシークが交錯すると位置が飛ぶ） */
  const steppingRef = useRef(false);
  /** 全コマ処理の実行中フラグと進捗（0〜1）、中断の合図 */
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState(0);
  const sweepCancelRef = useRef(false);
  /**
   * 区間を rVFC のコールバックから読むための ref。
   * あのコールバックは isPlaying が変わったときにしか作り直さないので、
   * state を直接掴むと古い区間を見続けてしまう。
   */
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;
  /** 原点指定モード（ON のあいだ、クリックした点が座標の原点になる） */
  const [originMode, setOriginMode] = useState(false);
  /** 初速ヒントの指定モード（ON のあいだ、クリックした点が「数コマ先の対象」） */
  const [seedMode, setSeedMode] = useState(false);
  /** 2 点目の結果。普段は null（黙っている） */
  const [seedMsg, setSeedMsg] = useState<SeedResult | null>(null);

  // ---- 手動トラッキング ----
  /** ON のあいだ、クリックした位置が「その物体のその時刻の位置」になる */
  const [manualMode, setManualMode] = useState(false);
  /** 1 回打ったあとに進めるコマ数 */
  const [manualStep, setManualStep] = useState(1);
  /** ユーザーが自分でコマ数を決めたか（決めていれば自動で上書きしない） */
  const manualStepTouched = useRef(false);
  /** 操作の結果を伝える一言 */
  const [manualMsg, setManualMsg] = useState<string | null>(null);
  /**
   * 次に打つ物体をユーザーが指名した場合の id。
   * null なら自動の順番（そのコマでまだ打っていない先頭）に従う。
   * 打ち間違えたときや、見えている物体から先に打ちたいときのための逃げ道。
   */
  const [manualPick, setManualPick] = useState<string | null>(null);
  /** 修正モードの操作結果を伝える一言（成功／記録なし） */
  const [correctMsg, setCorrectMsg] = useState<string | null>(null);
  /** 手動修正モード（ON のときだけ点をドラッグして直せる） */
  const [correctMode, setCorrectMode] = useState(false);

  /**
   * 「ここまでは正しい」を選んでもらうモード。
   * ON のあいだ、飛んだ時刻の手前の記録点が候補として並ぶ。
   */
  const [pickMode, setPickMode] = useState(false);
  /**
   * 「ここまでは正しい」で選んでいる候補の番号。
   *
   * 選ぶだけでは切らない。選ぶとそのコマへ送るので、点がマーカーの上に
   * 乗っているかを目で確かめてから決定できる。確かめられないと、
   * どれが正解なのか人には分からない。
   */
  const [pickIdx, setPickIdx] = useState<number | null>(null);
  /** 切り落としたあとの一言 */
  const [cutMsg, setCutMsg] = useState<string | null>(null);

  /**
   * クリックで置いた枠の中心。大きさはこのあとスライダーで決める。
   *
   * ドラッグで一気に引く操作は残してある（マウスなら速い）。
   * ただ、2 点間校正で 1px が 3% に効くような画の細かさだと、
   * 目分量のドラッグでは端が決まらない。中心だけ先に決めれば、
   * 虫めがねで画素を見ながら置ける。
   */
  const [roiCenter, setRoiCenter] = useState<Point | null>(null);
  /** 中心を決めたあとの枠の一辺 */
  const [roiSize, setRoiSize] = useState(RECOMMENDED_ROI_SIZE);
  /** マウスの現在位置（虫めがねの中心に使う。ドラッグ中でなくても出す） */
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  /** 枠を置いたら続けて 2 点目へ進む、という待ち状態 */
  const [pendingSeed, setPendingSeed] = useState(false);

  const frameCounterRef = useRef(0);
  const frameIntervalsRef = useRef<number[]>([]);
  const lastMediaTimeRef = useRef<number | null>(null);
  const lastUiTimeRef = useRef(0);

  // 最新のコールバックを ref に保持（rVFC ループを再登録させないため）
  const renderRef = useRef<() => void>(() => {});
  const processRef = useRef(onProcessFrame);
  processRef.current = onProcessFrame;
  const fpsRef = useRef(fpsSettings);
  fpsRef.current = fpsSettings;
  const setFpsRef = useRef(setFpsSettings);
  setFpsRef.current = setFpsSettings;

  const rvfcSupported =
    typeof window !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // -------------------------------------------------
  // 動画ファイル読み込み
  // -------------------------------------------------

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !videoRef.current) return;

    const url = URL.createObjectURL(file);
    setVideoLoaded(false);
    videoRef.current.src = url;
    videoRef.current.load();
    setIsPlaying(false);
    setCurrentTime(0);
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
    onResetData();
    onUpdateCalibration({
      ...calibration,
      linePoints: [], pxPerUnit: 0,
      planePoints: [], homography: null,
      // 原点は画像座標なので、動画が変われば無意味になる
      origin: null,
    });
    setIsLineCalibrating(false);
    setOriginMode(false);
    setCorrectMode(false);
    setManualMode(false);
    setRoiCenter(null);
    setPickMode(false);
    // 区間は「この動画の何秒から何秒まで」なので、別の動画では意味を持たない
    onChangeTimeRange(FULL_RANGE);
    e.target.value = '';
  };

  // -------------------------------------------------
  // ① 初期フレームを確実に描画する
  // -------------------------------------------------

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setVideoDimensions({ width: v.videoWidth, height: v.videoHeight });
    onVideoSize?.({ width: v.videoWidth, height: v.videoHeight });
    setDuration(v.duration || 0);
    onVideoDuration?.(v.duration || 0);
    setVideoLoaded(true);
    // 先頭にシークして seeked → 描画へつなぐ
    try { v.currentTime = 0; } catch (_) { /* noop */ }
  };

  /** デコード済みフレームが用意されたら描く。rVFC があればそれを最優先。 */
  const drawWhenReady = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (rvfcSupported) {
      (v as any).requestVideoFrameCallback(() => renderRef.current());
    }
    // rVFC は「次のフレーム提示時」なので、一時停止中は発火しないことがある。
    // 保険として rAF でも2回描いておく。
    requestAnimationFrame(() => {
      renderRef.current();
      requestAnimationFrame(() => renderRef.current());
    });
  }, [rvfcSupported]);

  const handleLoadedData = () => {
    setVideoLoaded(true);
    drawWhenReady();
  };

  // 読み込み直後に一度だけ、ファイルの fps を実測する。
  //
  // 通常の自動計測は再生中の rVFC 間隔から行うので、
  // 一度も再生せずにコマ送りだけする使い方（手動トラッキング）では
  // 既定値 30 のまま走ってしまう。刻みが実フレーム間隔と合わないと、
  // 1 回押して 2 コマ進んだり同じコマに留まったりする。
  useEffect(() => {
    if (!videoLoaded) return;
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    (async () => {
      const fps = await measureFileFps(v);
      if (cancelled) return;
      if (fps && Math.abs(fps - fpsRef.current.value) > 0.05) {
        setFpsRef.current({ ...fpsRef.current, value: fps });
      }
      frameTimeRef.current = v.currentTime;
      setCurrentTime(v.currentTime);
      renderRef.current();
    })();
    return () => { cancelled = true; };
  }, [videoLoaded]);

  const handleSeeked = () => {
    const v = videoRef.current;
    if (v) {
      setCurrentTime(v.currentTime);
      // シークバーを直接動かされた場合もここを通る。
      // 覚えている「表示中フレームの時刻」を古いままにしない
      frameTimeRef.current = v.currentTime;
    }
    drawWhenReady();
  };

  // -------------------------------------------------
  // マウス座標の取得（ズーム対応）
  // -------------------------------------------------

  const getCanvasCoordinates = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  // -------------------------------------------------
  // ③ 校正・ROI のマウス操作
  // -------------------------------------------------

  const applyLine = useCallback(
    (p1: Point, p2: Point) => {
      onUpdateCalibration(
        recalcScale({
          ...calibration,
          mode: 'line',
          linePoints: [
            { x: Math.round(p1.x), y: Math.round(p1.y) },
            { x: Math.round(p2.x), y: Math.round(p2.y) },
          ],
        })
      );
    },
    [calibration, onUpdateCalibration]
  );

  const applyPlane = useCallback(
    (pts: Point[]) => {
      onUpdateCalibration(
        recalcScale({
          ...calibration,
          mode: 'plane',
          planePoints: pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        })
      );
    },
    [calibration, onUpdateCalibration]
  );

  // -------------------------------------------------
  // 修正モードで「掴む点」の決め方
  // -------------------------------------------------
  //
  // o.center はトラッカーが最後に居た位置なので、シークで別の時刻へ移ると
  // 画面に描かれている点とズレる。ズレたまま当たり判定に使うと掴み損ね、
  // 「点を直したいのに新しい枠を引いてしまう」ことになる。
  // そこで現在時刻に最も近い記録フレームの点を優先して掴ませる。

  /** 現在の動画時刻に最も近い記録フレームの index。記録が無ければ -1 */
  const nearestFrameIndex = useCallback(
    (t: number): number => {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < historyData.length; i++) {
        const d = Math.abs(historyData[i].timestamp - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    },
    [historyData]
  );

  /** そのオブジェクトを掴める画面上の点 */
  const grabPoint = useCallback(
    (o: TrackedObject, frameIdx: number): Point | null => {
      const it = frameIdx >= 0 ? historyData[frameIdx].objects[o.id] : undefined;
      if (it && !it.lost) return { x: it.xPx, y: it.yPx };
      return o.center ?? null;
    },
    [historyData]
  );

  /** 操作結果の表示は少し経ったら消す */
  useEffect(() => {
    if (!correctMsg) return;
    const id = window.setTimeout(() => setCorrectMsg(null), 2600);
    return () => window.clearTimeout(id);
  }, [correctMsg]);

  useEffect(() => { if (!correctMode) setCorrectMsg(null); }, [correctMode]);

  /**
   * 2 点目の結果は少し経ったら消す。
   * ただし直し方（枠の大きさ）を出しているときは消さない。
   * 押す前に消えるボタンは出さない方がましなので。
   */
  useEffect(() => {
    if (!seedMsg || seedMsg.betterSize !== undefined) return;
    const id = window.setTimeout(() => setSeedMsg(null), 7000);
    return () => window.clearTimeout(id);
  }, [seedMsg]);

  /**
   * 初速ヒントの開始。枠を置いたコマから数コマ送って、同じ対象を指してもらう。
   * ここで送るのは、2 点が近すぎると 1 コマあたりの移動量の精度が出ないため。
   */
  const startSeed = useCallback(async () => {
    const v = videoRef.current;
    const o = objects.find(x => x.id === selectedObjId);
    if (!v || !o || o.initialTime === null) return;
    v.pause();
    setIsPlaying(false);
    setOriginMode(false);
    setCorrectMode(false);
    setManualMode(false);
    setIsLineCalibrating(false);
    const target = o.initialTime + SEED_FRAMES / Math.max(1, fpsSettings.value);
    try {
      const t = await seekToFrameTime(v, target);
      frameTimeRef.current = t;
      setCurrentTime(t);
    } catch (_) { /* シークに失敗してもモードには入る */ }
    setSeedMode(true);
  }, [objects, selectedObjId, fpsSettings.value, setIsPlaying, setIsLineCalibrating]);

  // -------------------------------------------------
  // 手動トラッキング
  // -------------------------------------------------

  /** 同じコマとみなす時刻の許容差。App 側と同じ基準にそろえる */
  const frameTolerance = useMemo(() => {
    const dt = historyData.length > 1
      ? medianDt(historyData.map(f => f.timestamp))
      : 0;
    return (dt > 0 ? dt : 1 / Math.max(1, fpsSettings.value)) * 0.5;
  }, [historyData, fpsSettings.value]);

  /** 「n コマおき」が実時間で何秒になるか。加速度の精度はここで決まる */
  const manualInterval = manualStepInterval(
    manualStep, fpsSettings.value, timeScale(fpsSettings)
  );

  // fps や撮影fps が決まったら、間隔が適切になるコマ数を提案する。
  // 240fps スローで 1 コマおきに打つと実時間 4ms しか空かず、
  // 加速度のばらつきが 40% にもなる（合成データでの実測）。
  useEffect(() => {
    if (manualStepTouched.current) return;
    setManualStep(recommendManualStep(fpsSettings.value, timeScale(fpsSettings)));
  }, [fpsSettings]);

  /** 打つ対象の並び。表示されている順に一巡させる */
  const manualOrder = objects.filter(o => o.active).map(o => o.id);

  /** いま打つべき物体と、それがそのコマの最後かどうか */
  const manualTarget = nextManualTarget(
    historyData, manualOrder, frameTimeRef.current, frameTolerance
  );

  /**
   * 1 点打つ。そのコマの対象を打ち切ったら、続けて manualStep コマ進む。
   * 記録する時刻は「要求した時刻」ではなく、実際に表示されているフレームの時刻。
   *
   * 「打ち切ったか」は onManualPlace の戻り値で判断する。
   * 打つ順番を入れ替えられるので、打つ前には決められない。
   */
  const placeManualAt = useCallback(async (pt: Point) => {
    const objId = manualPick ?? manualTarget.objId;
    if (!objId) {
      setManualMsg('追跡対象がありません');
      return;
    }
    const complete = onManualPlace(objId, pt, frameTimeRef.current);
    // 指名は 1 回きり。打ったら自動の順番に戻す
    setManualPick(null);

    if (complete) {
      setManualMsg(`${objId} を記録 → ${manualStep} コマ進みます`);
      await stepFrame(manualStep);
    } else {
      setManualMsg(`${objId} を記録`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualPick, manualTarget.objId, onManualPlace, manualStep]);

  /** 操作結果の表示は少し経ったら消す */
  useEffect(() => {
    if (!manualMsg) return;
    const id = window.setTimeout(() => setManualMsg(null), 2000);
    return () => window.clearTimeout(id);
  }, [manualMsg]);

  /**
   * 「ここまでは正しい」の候補。飛んだ時刻の手前の記録点を新しい順に並べる。
   *
   * 時刻の数字ではなく映像の上の点として選ばせる。どこでドリフトが
   * 始まったかは、軌跡の形を見れば分かるが、秒数の一覧からは分からない。
   */
  const pickPoints = useMemo<TrailPoint[]>(
    () => (halt ? pointsBefore(historyData, halt.objId, halt.time, PICK_POINTS) : []),
    [halt, historyData]
  );

  /** 候補のうち、その点までの移動量が中央値から外れているもの＝怪しい範囲 */
  const pickMedianStep = useMemo(() => {
    const steps = pickPoints.map(q => q.step).filter(v => v > 0).sort((a, b) => a - b);
    return steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 0;
  }, [pickPoints]);

  /** 乱れ始めた最初の候補。ここから後は信用しない */
  const pickWarnFrom = useMemo(() => {
    if (pickMedianStep <= 0) return pickPoints.length;
    for (let i = 0; i < pickPoints.length; i++) {
      if (pickPoints[i].step > Math.max(pickMedianStep * 2, pickMedianStep + 4)) return i;
    }
    return pickPoints.length;
  }, [pickPoints, pickMedianStep]);

  /**
   * アプリ側の答え。乱れ始めた 1 つ手前。
   *
   * 既定を入れておくのが肝。「正しい最後の点を選べ」と言われても、
   * 何を基準に選ぶのかが分からなければ手が止まる。まず答えを置いて、
   * 違うと思ったときだけ動かしてもらう形にする。
   */
  const pickSuggest = useMemo(() => {
    if (pickPoints.length === 0) return null;
    return Math.max(0, Math.min(pickPoints.length - 1, pickWarnFrom - 1));
  }, [pickPoints, pickWarnFrom]);

  /** いちばん近い候補の番号（しきい値内）。見つからなければ -1 */
  const nearestPickIndex = useCallback(
    (pt: Point): number => {
      let best = -1;
      let bestD = HANDLE_RADIUS * 2;
      pickPoints.forEach((q, i) => {
        const d = pixelDistance(pt, q.point);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    },
    [pickPoints]
  );

  /**
   * 切ったあと、枠を置いたら続けて 2 点目を指してもらうための印。
   *
   * なぜ続けるのか。枠を置き直しただけでは、同じ場所でまた壊れる。
   * 壊れた理由は「そのコマのテンプレートと、そのコマの動きの大きさ」で
   * 決まっていて、枠を引き直してもどちらも変わらないことが多い。
   * 2 点目を指してもらえば、(1) 最初のコマから予測が効き、
   * (2) その枠が本当にその対象を見つけられるかを実測できる。
   * 止まった直後は、この 2 つがどちらも要る場面そのもの。
   */
  const chainSeedRef = useRef(false);

  /**
   * 枠が確定したときに呼ぶ。切った直後なら 2 点目へ続ける。
   *
   * ここで直接 startSeed を呼べないのは、枠の確定が App 側の state を
   * 経由するため。このレンダーの objects にはまだ新しい initialTime が
   * 入っていないので、送る先のコマを間違える。印だけ立てて、
   * 反映されてから進む。
   */
  const afterRoiPlaced = useCallback(() => {
    if (!chainSeedRef.current) return;
    chainSeedRef.current = false;
    setPendingSeed(true);
  }, []);

  /** 選んだ点より後の記録を捨てる */
  const cutAt = useCallback((q: TrailPoint) => {
    const dropped = onTruncateAfter(q.time);
    setPickMode(false);
    setPickIdx(null);
    setRoiCenter(null);
    chainSeedRef.current = true;
    setCutMsg(
      dropped > 0
        ? `${q.time.toFixed(3)} s より後の ${dropped} コマを捨てました。`
          + `枠を置き直すと、続けて 2 点目を聞きます`
        : `${q.time.toFixed(3)} s まで残しました（捨てるコマはありませんでした）`
    );
  }, [onTruncateAfter]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!videoLoaded) return;
    const pt = getCanvasCoordinates(e);

    // ---------- 「ここまでは正しい」を選ぶ ----------
    // ほかのどのモードよりも先に見る。選び終わるまで他の操作はさせない。
    // クリックでは切らない。選ぶだけにして、そのコマへ送って見せる。
    if (pickMode) {
      const i = nearestPickIndex(pt);
      if (i >= 0) setPickIdx(i);
      return;
    }

    // ---------- 初速ヒント ----------
    // 始点は枠の中心で決まっているので、押した瞬間に矢印が生えて、
    // 動かすと先端が追従する。離した位置が「数コマ先の対象の位置」。
    if (seedMode) {
      setDragMode('seed');
      setDragStart(pt);
      setDragCurrent(pt);
      return;
    }

    // ---------- 手動トラッキング ----------
    // 原点指定の次に見る。1 クリックで 1 点打ち、そのコマの物体を打ち切ったら
    // 自動で次のコマへ進む。ドラッグ判定は挟まない（打つのは点であって領域ではない）
    if (manualMode && !isPlaying && !originMode) {
      void placeManualAt(pt);
      return;
    }

    // ---------- 原点指定 ----------
    // 他のどのモードよりも先に見る。1 クリックで確定して自分で抜ける。
    if (originMode) {
      onUpdateCalibration({
        ...calibration,
        origin: { x: Math.round(pt.x), y: Math.round(pt.y) },
      });
      setOriginMode(false);
      return;
    }

    // ---------- 平面校正 ----------
    if (calibration.mode === 'plane') {
      const quad = calibration.planePoints;
      // 既存の頂点を掴む
      if (!isLineCalibrating && quad.length === 4) {
        for (let i = 0; i < 4; i++) {
          if (pixelDistance(pt, quad[i]) <= HANDLE_RADIUS) {
            setDragMode('plane-corner');
            setDragIndex(i);
            setCalibFocus(i);
            setDragCurrent(pt);
            return;
          }
        }
      }
      // 四隅を順に置いていく
      if (isLineCalibrating) {
        const next = quad.length >= 4 ? [pt] : [...quad, pt];
        if (next.length === 4) {
          applyPlane(next);
          setIsLineCalibrating(false);
        } else {
          onUpdateCalibration({ ...calibration, planePoints: next, homography: null });
        }
        return;
      }
    }

    // ---------- 2点間校正 ----------
    const pts = calibration.linePoints;
    if (calibration.mode === 'line' && pts.length === 2 && !isLineCalibrating) {
      if (pixelDistance(pt, pts[0]) <= HANDLE_RADIUS) {
        setDragMode('calib-p1');
        setCalibFocus(0);
        setDragCurrent(pt);
        return;
      }
      if (pixelDistance(pt, pts[1]) <= HANDLE_RADIUS) {
        setDragMode('calib-p2');
        setCalibFocus(1);
        setDragCurrent(pt);
        return;
      }
    }
    if (calibration.mode === 'line' && isLineCalibrating) {
      setDragMode('calib-new');
      setDragStart(pt);
      setDragCurrent(pt);
      return;
    }

    // ---------- 手動修正（一時停止中のみ） ----------
    if (correctMode && !isPlaying) {
      const v = videoRef.current;
      const fi = nearestFrameIndex(v ? v.currentTime : 0);
      let hitId: string | null = null;
      let bestD = HANDLE_RADIUS * 1.6;
      objects.forEach(o => {
        if (!o.active || o.status === 'exited') return;
        const gp = grabPoint(o, fi);
        if (!gp) return;
        const d = pixelDistance(pt, gp);
        if (d < bestD) {
          bestD = d;
          hitId = o.id;
        }
      });
      if (hitId) {
        setDragMode('manual');
        setManualObjId(hitId);
        setDragCurrent(pt);
        return;
      }
      // 掴み損ねても ROI ドラッグには落とさない。
      // 落とすと、点を直そうとしただけで枠が引き直されてしまう。
      setCorrectMsg('直したい点の近くからドラッグしてください');
      return;
    }

    // ---------- 通常ドラッグ（ROI指定） ----------
    // 別の層を触り始めたので、校正の選択は外して表示を元へ戻す
    setCalibFocus(null);
    setDragMode('roi');
    setDragStart(pt);
    setDragCurrent(pt);
  };

  /**
   * 中心を決めたあと、スライダーの値で枠を確定する。
   *
   * 枠は正方形。対象は回転するし向きも変わるので、縦横を別に決めても
   * 追跡の精度には効かない。決めることが 1 つ減るほうが速い。
   */
  const confirmRoi = useCallback(() => {
    if (!roiCenter) return;
    const half = Math.round(roiSize / 2);
    onUpdateRoi(
      selectedObjId,
      {
        x: Math.round(roiCenter.x) - half,
        y: Math.round(roiCenter.y) - half,
        width: Math.round(roiSize),
        height: Math.round(roiSize),
      },
      videoRef.current || undefined
    );
    setRoiCenter(null);
    afterRoiPlaced();
  }, [roiCenter, roiSize, selectedObjId, onUpdateRoi, afterRoiPlaced]);

  // 枠が App 側へ反映されたら 2 点目へ進む
  useEffect(() => {
    if (!pendingSeed) return;
    const o = objects.find(x => x.id === selectedObjId);
    if (!o || !o.initialRoi || o.initialTime === null) return;
    setPendingSeed(false);
    void startSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeed, objects, selectedObjId]);

  /**
   * 虫めがねを出す場面か。
   *
   * ここで絞っているのは負荷のため。マウスを動かすたびに座標を state へ
   * 上げると毎回再描画が走る。拡大が要るのは「点を置く・選ぶ」ときだけ。
   */
  const wantLoupe =
    pickMode || !!roiCenter || seedMode || originMode
    || isLineCalibrating || (correctMode && !isPlaying);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wantLoupe || dragMode) {
      setHoverPt(getCanvasCoordinates(e));
    }
    if (pickMode) return;
    if (!dragMode) return;
    const pt = getCanvasCoordinates(e);
    setDragCurrent(pt);

    if (dragMode === 'calib-p1' && calibration.linePoints.length === 2) {
      applyLine(pt, calibration.linePoints[1]);
    } else if (dragMode === 'calib-p2' && calibration.linePoints.length === 2) {
      applyLine(calibration.linePoints[0], pt);
    } else if (dragMode === 'plane-corner' && dragIndex >= 0) {
      const next = calibration.planePoints.map((p, i) => (i === dragIndex ? pt : p));
      applyPlane(next);
    }
  };

  const finishDrag = useCallback(() => {
    if (!dragMode) return;

    if (dragMode === 'seed') {
      const tip = dragCurrent ?? dragStart;
      if (tip) {
        const r = onSeedPoint(
          selectedObjId, tip, frameTimeRef.current, videoRef.current || undefined
        );
        setSeedMsg(r.msg ? r : null);
      }
      setSeedMode(false);
      void goToStart();
      setDragMode(null);
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    if (dragMode === 'manual' && dragCurrent && manualObjId) {
      const v = videoRef.current;
      const applied = onManualCorrect(
        manualObjId, dragCurrent, v ? v.currentTime : 0, v || undefined
      );
      // 書き換えられなかったことを黙って済ませない。
      // 枠だけ動いた状態は「直ったつもりで直っていない」ので一番まずい。
      setCorrectMsg(
        applied
          ? '点を修正しました'
          : 'この時刻には記録がありません（枠のみ更新）。記録済みの区間で修正してください'
      );
      setManualObjId(null);
    } else if (dragMode === 'calib-new' && dragStart && dragCurrent) {
      if (pixelDistance(dragStart, dragCurrent) >= 5) {
        applyLine(dragStart, dragCurrent);
        setIsLineCalibrating(false);
      }
    } else if (dragMode === 'roi' && dragStart && dragCurrent) {
      let x = Math.min(dragStart.x, dragCurrent.x);
      let y = Math.min(dragStart.y, dragCurrent.y);
      let width = Math.abs(dragCurrent.x - dragStart.x);
      let height = Math.abs(dragCurrent.y - dragStart.y);

      if (isSquareMode) {
        const side = Math.max(width, height);
        width = side;
        height = side;
        if (dragCurrent.x < dragStart.x) x = dragStart.x - side;
        if (dragCurrent.y < dragStart.y) y = dragStart.y - side;
      }

      if (width > 5 && height > 5) {
        onUpdateRoi(
          selectedObjId,
          {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          },
          videoRef.current || undefined
        );
        setRoiCenter(null);
        afterRoiPlaced();
      } else {
        // 引かずに押しただけ＝「中心はここ」。大きさはこのあと決める。
        // マウスでも、対象が小さく写っているときは端まで正確に引けない。
        // 中心だけ先に置ければ、虫めがねで画素を見ながら合わせられる。
        setRoiCenter(dragStart);
      }
    }

    setDragMode(null);
    setDragStart(null);
    setDragCurrent(null);
    setDragIndex(-1);
  }, [
    dragMode, dragStart, dragCurrent, isSquareMode, selectedObjId,
    onUpdateRoi, applyLine, setIsLineCalibrating, manualObjId, onManualCorrect,
    afterRoiPlaced,
  ]);


  // 候補を選ぶモードに入ったら、まずアプリ側の答えを置く
  useEffect(() => {
    if (!pickMode) { setPickIdx(null); return; }
    setPickIdx(prev => (prev === null ? pickSuggest : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickMode, pickSuggest]);

  /**
   * 選んだ候補のコマへ送る。
   *
   * これが要る理由。候補を選ぶ判断は「点がマーカーの上に乗っているか」で、
   * それは**そのコマの映像を見ないと決められない**。止まったコマのまま
   * 点だけを並べても、どれが正解なのかは分からない。
   */
  useEffect(() => {
    if (!pickMode || pickIdx === null) return;
    const q = pickPoints[pickIdx];
    if (!q) return;
    void seekTo(q.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickMode, pickIdx]);

  /** 候補を選ぶあいだの矢印キーと Enter */
  useEffect(() => {
    if (!pickMode) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        setPickIdx(i => {
          if (i === null) return pickSuggest;
          return Math.max(0, Math.min(pickPoints.length - 1, i + d));
        });
        return;
      }
      if (e.key === 'Enter' && pickIdx !== null && pickPoints[pickIdx]) {
        e.preventDefault();
        cutAt(pickPoints[pickIdx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickMode, pickIdx, pickPoints, pickSuggest, cutAt]);

  /** 切り落としの一言は少し長めに出す（次にすることが書いてある） */
  useEffect(() => {
    if (!cutMsg) return;
    const id = window.setTimeout(() => setCutMsg(null), 6000);
    return () => window.clearTimeout(id);
  }, [cutMsg]);

  /**
   * 別のモードへ移ったら、途中の中心指定は捨てる。
   * 残したままだと、校正点を置いたつもりで枠が確定することがある。
   */
  useEffect(() => {
    if (correctMode || manualMode || originMode || seedMode || isLineCalibrating) {
      setRoiCenter(null);
    }
  }, [correctMode, manualMode, originMode, seedMode, isLineCalibrating]);

  /** 対象を変えたら、前の対象に向けて置いた中心は意味を持たない */
  useEffect(() => { setRoiCenter(null); }, [selectedObjId]);

  /** 止めた案内が出たら、他のモードは畳む。選択肢を増やしても迷うだけ */
  useEffect(() => {
    if (!halt) return;
    setIsLineCalibrating(false);
    setOriginMode(false);
    setSeedMode(false);
    setManualMode(false);
    setRoiCenter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halt]);

  // 校正線の矢印キーによる微調整
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pickMode) {
        setPickMode(false);
        return;
      }
      if (e.key === 'Escape' && seedMode) {
        setSeedMode(false);
        return;
      }
      // 修正モード中の Delete は「この点を消す」。
      // 直せない点もある（対象が別のものに完全に乗り移った、物体が隠れた）。
      // そういう点は正しい位置が無いので、消すのが唯一正しい処理になる。
      // 当てはめも 2 階差分も、1 点の跳ねで台無しになる。
      if (
        (e.key === 'Delete' || e.key === 'Backspace')
        && correctMode && !isPlaying
      ) {
        const tag0 = (e.target as HTMLElement)?.tagName;
        if (tag0 === 'INPUT' || tag0 === 'SELECT' || tag0 === 'TEXTAREA') return;
        e.preventDefault();
        const v = videoRef.current;
        const ok = onDropPoint(selectedObjId, v ? v.currentTime : 0);
        setCorrectMsg(
          ok
            ? `${selectedObjId} のこのコマの点を消しました`
            : 'このコマに消せる点がありません'
        );
        return;
      }
      if (e.key === 'Escape' && originMode) {
        setOriginMode(false);
        return;
      }
      if (e.key === 'Escape' && isLineCalibrating) {
        setIsLineCalibrating(false);
        setDragMode(null);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // 候補を選んでいる間は矢印キーを譲る。
      // 譲らないと、← で選択が動くのと同時に校正点まで 1px ずれる。
      if (pickMode) return;

      const lineReady = calibration.mode === 'line' && calibration.linePoints.length === 2;
      const planeReady = calibration.mode === 'plane' && calibration.planePoints.length === 4;
      if (!lineReady && !planeReady) return;
      const count = lineReady ? 2 : 4;

      // Tab で動かす点を切り替える（選んでいる点は映像上で太く描かれる）
      if (e.key === 'Tab' && calibFocus !== null) {
        e.preventDefault();
        setCalibFocus((calibFocus + 1) % count);
        return;
      }
      if (e.key === 'Escape') { setCalibFocus(null); return; }

      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();

      // 矢印で 1px、Shift を足して 10px。
      // 以前は Shift が「2点目を動かす」だったが、それだと動く点が
      // 画面に出ていないので取り違える。動かす点はクリックか Tab で選ぶ。
      const step = e.shiftKey ? 10 : 1;
      const idx = calibFocus ?? 0;
      setCalibFocus(idx);
      const move = (p: Point, i: number) =>
        (i === idx ? { x: p.x + d[0] * step, y: p.y + d[1] * step } : p);

      if (lineReady) {
        onUpdateCalibration(recalcScale({
          ...calibration, linePoints: calibration.linePoints.map(move),
        }));
      } else {
        applyPlane(calibration.planePoints.map(move));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [calibration, onUpdateCalibration, isLineCalibrating, setIsLineCalibrating,
      originMode, seedMode, calibFocus, applyPlane,
      pickMode, correctMode, isPlaying, onDropPoint, selectedObjId]);

  // -------------------------------------------------
  // Canvas 描画
  // -------------------------------------------------

  // =========================================================
  // コマの点検
  // =========================================================
  //
  // 位置の 2 階差分が一定かどうかを見る。等加速度ならこれは一定になるので、
  // 飛んでいるコマは「動画側のコマの時刻ずれ」か「追跡の失敗」のどちらか。
  // 速度に直してから探すと、微分がノイズを増幅し、中心差分のせいで
  // 1 コマの異常が前後 2 点へ散るため、原因のコマが特定できない。

  /** 点検に使う枠の幅。ブレの限界の判定に効く */
  const checkRoiWidth = useMemo(() => {
    const o = objects.find(x => x.id === selectedObjId);
    return o?.initialRoi?.width ?? o?.roi?.width ?? 0;
  }, [objects, selectedObjId]);

  const trackQuality = useMemo(
    () => checkTrack(historyData, selectedObjId, checkRoiWidth),
    [historyData, selectedObjId, checkRoiWidth]
  );
  /** 疑わしいコマの時刻。描画で印を付けるのに使う */
  const issueTimes = useMemo(() => new Set(trackQuality.issueTimes), [trackQuality]);


  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    // 動画フレーム
    if (video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 高解像度動画でも線の太さが見た目一定になるようスケール
    const k = Math.max(1, vw / 960);

    // いま校正を触っているか。層の出し分けに使う。
    // 枠・名前・校正点・校正の数値が同じ場所に重なると、どれを操作して
    // いるのか分からなくなる。操作中の層だけを濃くするのが確実に効く。
    const calibActive = isLineCalibrating || originMode || calibFocus !== null
      || dragMode === 'calib-new' || dragMode === 'calib-p1'
      || dragMode === 'calib-p2' || dragMode === 'plane-corner';

    // ----- 軌跡 -----
    if (showTrail && historyData.length > 1) {
      objects.forEach(obj => {
        if (!obj.active) return;
        // 見失ったフレームで線を切る。
        // ひとつながりに描くと、追跡が飛んだ区間まで滑らかな軌跡に見えてしまい、
        // データが正しいと誤解する原因になる。
        const segments: Point[][] = [];
        let cur: Point[] = [];
        for (let i = 0; i < historyData.length; i++) {
          const item = historyData[i].objects[obj.id];
          // 飛んだと判定した点でも線を切る。点そのものは別に描く。
          // つないでしまうと、壊れた区間まで滑らかな運動に見える。
          if (item && !item.lost && !item.suspect) {
            cur.push({ x: item.xPx, y: item.yPx });
          } else if (cur.length > 0) {
            segments.push(cur);
            cur = [];
          }
        }
        if (cur.length > 0) segments.push(cur);

        const allPoints = segments.flat();
        const points = allPoints.slice(-MAX_TRAIL_POINTS);
        if (points.length < 1) return;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.save();
        const strokeSegments = (color: string, width: number) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          segments.forEach(seg => {
            if (seg.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(seg[0].x, seg[0].y);
            for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
            ctx.stroke();
          });
        };
        // 影を付けて背景に埋もれないようにする
        strokeSegments('rgba(0,0,0,0.45)', 4.5 * k);
        strokeSegments(obj.color, 2.5 * k);
        ctx.restore();


        // タイミングの乱れたコマに印を付ける。
        // 点そのものは消さない。消すと「無かったこと」になり、なぜ速度が
        // 暴れているのかを説明できなくなる。見せたうえで判断してもらう。
        if (obj.id === selectedObjId && issueTimes.size > 0) {
          for (let i = 0; i < historyData.length; i++) {
            const it = historyData[i].objects[obj.id];
            if (!it || it.lost) continue;
            if (!issueTimes.has(historyData[i].timestamp)) continue;
            ctx.save();
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 8 * k, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 3.2 * k;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 8 * k, 0, Math.PI * 2);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.6 * k;
            ctx.setLineDash([3.5 * k, 2.5 * k]);
            ctx.stroke();
            ctx.restore();
          }
        }

        // 飛んだと判定した点は ✕ で描く。
        // 丸ではなく ✕ にしてあるのは、「これは軌跡の一部ではない」
        // ことを形で示したいから。印の付いた乱れ（点線の輪）とは別物。
        for (let i = 0; i < historyData.length; i++) {
          const it = historyData[i].objects[obj.id];
          if (!it || !it.suspect) continue;
          const r = 7 * k;
          ctx.save();
          ctx.lineCap = 'round';
          const cross = (color: string, w: number) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.moveTo(it.xPx - r, it.yPx - r); ctx.lineTo(it.xPx + r, it.yPx + r);
            ctx.moveTo(it.xPx + r, it.yPx - r); ctx.lineTo(it.xPx - r, it.yPx + r);
            ctx.stroke();
          };
          cross('rgba(0,0,0,0.55)', 4.4 * k);
          cross('#ef4444', 2.2 * k);
          ctx.restore();
        }

        // 手動修正した点を目印として出す
        for (let i = 0; i < historyData.length; i++) {
          const it = historyData[i].objects[obj.id];
          if (it && it.manual && !it.lost) {
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 4 * k, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = obj.color;
            ctx.lineWidth = 1.5 * k;
            ctx.stroke();
          }
        }

        // 現在位置マーカー。
        // 十字にしてあるのは、追跡点が本当に対象の上に乗っているかを
        // 目で確かめられるようにするため。丸で塗ると対象が隠れて分からない。
        const last = points[points.length - 1];
        drawCrosshair(ctx, last.x, last.y, obj.color, k, 9, 3, 1.6);

        // 画面外で終端した場合は終端マークを置く
        if (obj.status === 'exited') {
          ctx.beginPath();
          ctx.arc(last.x, last.y, 9 * k, 0, Math.PI * 2);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2 * k;
          ctx.setLineDash([4 * k, 3 * k]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    }

    // ----- ROI 枠 -----
    objects.forEach(obj => {
      if (!obj.active || !obj.roi) return;
      if (obj.status === 'exited') return; // 追尾終了した枠は出さない

      const { x, y, width, height } = obj.roi;
      const isLost = obj.status === 'lost';
      const isSelected = obj.id === selectedObjId;
      const boxColor = isLost ? '#ef4444' : obj.color;

      ctx.save();
      // 校正中は追跡の層を薄くする
      if (calibActive) ctx.globalAlpha = 0.28;
      if (isSelected && !calibActive) {
        ctx.shadowColor = boxColor;
        ctx.shadowBlur = 8 * k;
      }
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = (isSelected ? 2.5 : 1.5) * k;
      ctx.setLineDash(isLost ? [6 * k, 4 * k] : []);
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // 名前を出すのは選択中と LOST のときだけ。
      // 帯は枠と同じ幅を占めるので、全部に出すと枠の上が名前で埋まる。
      if (isSelected || isLost) {
        const labelText = isLost ? `${obj.id} LOST` : obj.id;
        ctx.font = `bold ${11 * k}px Inter, sans-serif`;
        const tw = ctx.measureText(labelText).width;
        const labelW = tw + 14 * k;
        const labelH = 20 * k;
        const labelY = Math.max(0, y - labelH - 3 * k);
        ctx.fillStyle = boxColor;
        ctx.fillRect(x, labelY, labelW, labelH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labelText, x + 7 * k, labelY + 14 * k);
      } else {
        // 非選択は角の小さな印だけ。色で見分けられれば足りる
        const s = 7 * k;
        ctx.fillStyle = boxColor;
        ctx.fillRect(x, Math.max(0, y - s - 2 * k), s, s);
      }

      // サブピクセル中心の十字
      const c = obj.center || { x: x + width / 2, y: y + height / 2 };
      ctx.beginPath();
      ctx.moveTo(c.x - 7 * k, c.y); ctx.lineTo(c.x + 7 * k, c.y);
      ctx.moveTo(c.x, c.y - 7 * k); ctx.lineTo(c.x, c.y + 7 * k);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
      ctx.restore();
    });

    // ----- 初速ヒントを引いている最中の矢印 -----
    if (dragMode === 'seed' && dragCurrent) {
      const o = objects.find(x => x.id === selectedObjId);
      const from = o?.initialRoi
        ? {
            x: o.initialRoi.x + o.initialRoi.width / 2,
            y: o.initialRoi.y + o.initialRoi.height / 2,
          }
        : null;
      if (from) {
        const color = o?.color || '#f59e0b';
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 5 * k;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y); ctx.lineTo(dragCurrent.x, dragCurrent.y);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5 * k;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y); ctx.lineTo(dragCurrent.x, dragCurrent.y);
        ctx.stroke();
        const ang = Math.atan2(dragCurrent.y - from.y, dragCurrent.x - from.x);
        const a = 13 * k;
        ctx.beginPath();
        ctx.moveTo(dragCurrent.x, dragCurrent.y);
        ctx.lineTo(dragCurrent.x - a * Math.cos(ang - 0.42), dragCurrent.y - a * Math.sin(ang - 0.42));
        ctx.moveTo(dragCurrent.x, dragCurrent.y);
        ctx.lineTo(dragCurrent.x - a * Math.cos(ang + 0.42), dragCurrent.y - a * Math.sin(ang + 0.42));
        ctx.stroke();
        ctx.restore();
        drawCrosshair(ctx, dragCurrent.x, dragCurrent.y, color, k, 10, 2.4, 1.4);
      }
    }

    // ----- 初速ヒント -----
    // 指した点と枠を置いた位置を結んでおく。これが「1 コマあたりどれだけ
    // 動くか」の根拠なので、見えていないと置き直しの判断ができない。
    objects.forEach(obj => {
      if (!obj.active || !obj.seed || obj.id !== selectedObjId) return;
      ctx.save();
      ctx.globalAlpha = 0.75;
      if (obj.initialRoi) {
        const from = {
          x: obj.initialRoi.x + obj.initialRoi.width / 2,
          y: obj.initialRoi.y + obj.initialRoi.height / 2,
        };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(obj.seed.point.x, obj.seed.point.y);
        ctx.strokeStyle = obj.color;
        ctx.lineWidth = 1.2 * k;
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawCrosshair(ctx, obj.seed.point.x, obj.seed.point.y, obj.color, k, 9, 2.4, 1.3);
      ctx.restore();
    });

    // ----- ドラッグ中の ROI プレビュー -----
    if (dragMode === 'roi' && dragStart && dragCurrent) {
      let rx = Math.min(dragStart.x, dragCurrent.x);
      let ry = Math.min(dragStart.y, dragCurrent.y);
      let rw = Math.abs(dragCurrent.x - dragStart.x);
      let rh = Math.abs(dragCurrent.y - dragStart.y);
      if (isSquareMode) {
        const side = Math.max(rw, rh);
        rw = side; rh = side;
        if (dragCurrent.x < dragStart.x) rx = dragStart.x - side;
        if (dragCurrent.y < dragStart.y) ry = dragStart.y - side;
      }
      const targetObj = objects.find(o => o.id === selectedObjId);
      // 小さすぎる枠はその場で赤く警告する（描き終わってから怒られないように）
      const tooSmall = Math.min(rw, rh) < MIN_ROI_SIZE;
      const marginal = !tooSmall && Math.min(rw, rh) < RECOMMENDED_ROI_SIZE;
      const guideColor = tooSmall ? '#ef4444' : marginal ? '#f59e0b' : (targetObj?.color || '#ffffff');

      ctx.strokeStyle = guideColor;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([5 * k, 4 * k]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = tooSmall ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(rx, ry, rw, rh);

      const sizeText = `${Math.round(rw)} × ${Math.round(rh)} px`
        + (tooSmall ? `  小さすぎます（${MIN_ROI_SIZE}px 以上）` : marginal ? '  やや小さめ' : '');
      ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
      const tw2 = ctx.measureText(sizeText).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(rx - 2 * k, ry + rh + 3 * k, tw2 + 10 * k, 18 * k);
      ctx.fillStyle = guideColor;
      ctx.fillText(sizeText, rx + 3 * k, ry + rh + 16 * k);
    }

    // ----- 校正線 -----
    const drawLine = (p1: Point, p2: Point, live: boolean) => {
      // 校正が済んだあとは控えめにする。値は一度決まれば変わらないので、
      // 映像の上に居座る必要がない（数値は校正パネルに常時出ている）。
      const focus = live || calibActive;
      const dist = pixelDistance(p1, p2);
      ctx.save();
      // 端の近くでは線を切る。そこは狙っている画素そのものなので、
      // 線で塗ってしまうと、印を細く半透明にした意味がなくなる。
      const ux = (p2.x - p1.x) / Math.max(1, dist);
      const uy = (p2.y - p1.y) / Math.max(1, dist);
      const cut = Math.min(8 * k, dist * 0.3);
      const a = { x: p1.x + ux * cut, y: p1.y + uy * cut };
      const b = { x: p2.x - ux * cut, y: p2.y - uy * cut };
      // 影
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = (focus ? 4 : 2.6) * k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = live ? 'rgba(251,191,36,0.85)'
        : focus ? 'rgba(245,158,11,0.8)' : 'rgba(245,158,11,0.5)';
      ctx.lineWidth = (focus ? 2 : 1.2) * k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

      // 端点。中を塗らない。塗ると狙っている目盛りが自分の描画で隠れ、
      // 終点を目分量で置くことになる（それが縮尺の誤差として残る）
      [p1, p2].forEach((p, i) => {
        const focused = dragMode === (i === 0 ? 'calib-p1' : 'calib-p2')
          || (!live && calibFocus === i);
        drawCalibPoint(ctx, p.x, p.y, i === 0 ? '#f59e0b' : '#10b981', k, focused);
      });

      // 数値は、製図の寸法線と同じように線から垂直へ逃がす。
      // 基準が短いとき、線の真上に置くと狙っている対象を数値で隠してしまう。
      if (focus) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const len = Math.max(1, dist);
        let nx = -(p2.y - p1.y) / len;
        let ny = (p2.x - p1.x) / len;
        if (ny > 0) { nx = -nx; ny = -ny; }   // なるべく上へ逃がす
        const lx = midX + nx * 34 * k;
        const ly = midY + ny * 34 * k;
        ctx.beginPath();
        ctx.moveTo(midX, midY); ctx.lineTo(lx, ly);
        ctx.strokeStyle = 'rgba(251,191,36,0.65)';
        ctx.lineWidth = 1 * k;
        ctx.stroke();

        const label = `${dist.toFixed(1)} px = ${calibration.realSizeValue} ${calibration.unit}`;
        ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(lx - tw / 2 - 8 * k, ly - 11 * k, tw + 16 * k, 22 * k);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(label, lx - tw / 2, ly + 4 * k);
      }
      ctx.restore();
    };

    if (calibration.mode === 'line') {
      if (dragMode === 'calib-new' && dragStart && dragCurrent) {
        drawLine(dragStart, dragCurrent, true);
      } else if (calibration.linePoints.length === 2) {
        drawLine(calibration.linePoints[0], calibration.linePoints[1], false);
      }
    }

    // ----- 平面校正の四角形と遠近グリッド -----
    if (calibration.mode === 'plane') {
      const quad = calibration.planePoints;

      if (quad.length === 4 && calibration.homography) {
        const Hinv = invertHomography(calibration.homography as Matrix3);
        if (Hinv) {
          // 実寸座標で等間隔のグリッドを引き、画像へ逆変換する。
          // まっすぐな格子が台形に見えれば、遠近が正しくモデル化できている。
          const W = calibration.planeWidth;
          const Hh = calibration.planeHeight;
          const N = 4;
          ctx.save();
          ctx.strokeStyle = 'rgba(16, 217, 124, 0.55)';
          ctx.lineWidth = 1.2 * k;
          for (let i = 0; i <= N; i++) {
            const u = (W * i) / N;
            const v = (Hh * i) / N;
            // 縦線
            ctx.beginPath();
            for (let j = 0; j <= 12; j++) {
              const p = applyHomography(Hinv, { x: u, y: (Hh * j) / 12 });
              if (!isFinite(p.x)) break;
              j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
            // 横線
            ctx.beginPath();
            for (let j = 0; j <= 12; j++) {
              const p = applyHomography(Hinv, { x: (W * j) / 12, y: v });
              if (!isFinite(p.x)) break;
              j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
          ctx.restore();
        }
      } else if (quad.length >= 2) {
        // 4点そろう前のガイド線
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([6 * k, 4 * k]);
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.stroke();
        ctx.restore();
      }

      // 頂点ハンドル
      const cornerNames = ['左上', '右上', '右下', '左下'];
      quad.forEach((p, i) => {
        const done = quad.length === 4 && calibration.homography;
        const focused = (dragMode === 'plane-corner' && dragIndex === i) || calibFocus === i;
        // 番号はリングの外側。角そのものを数字で潰さない
        drawCalibPoint(ctx, p.x, p.y, done ? '#10d97c' : '#f59e0b', k, focused, String(i + 1));
        // 未確定のときは次にどこを押すかを示す
        if (quad.length < 4) {
          ctx.fillStyle = '#fbbf24';
          ctx.font = `${11 * k}px Inter, sans-serif`;
          ctx.fillText(cornerNames[i], p.x + 14 * k, p.y + 16 * k);
        }
      });

      // 実寸ラベル
      if (quad.length === 4 && calibration.homography) {
        const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const label = (p: Point, text: string) => {
          ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = 'rgba(0,0,0,0.78)';
          ctx.fillRect(p.x - tw / 2 - 7 * k, p.y - 11 * k, tw + 14 * k, 21 * k);
          ctx.fillStyle = '#10d97c';
          ctx.fillText(text, p.x - tw / 2, p.y + 4 * k);
        };
        label(mid(quad[0], quad[1]), `${calibration.planeWidth} ${calibration.unit}`);
        label(mid(quad[1], quad[2]), `${calibration.planeHeight} ${calibration.unit}`);
      }
    }

    // ----- 手動記録: 次に打つ物体を示す -----
    // どの物体を打つ番か分からなくなるのが一番の混乱なので、
    // 現在のコマに既に打ってある点を色付きで示し、次の対象を強調する。
    if (manualMode && !isPlaying) {
      const cur = historyData.find(
        f => Math.abs(f.timestamp - frameTimeRef.current) <= frameTolerance
      );
      objects.filter(o => o.active).forEach(o => {
        const it = cur?.objects[o.id];
        if (!it || it.lost) return;
        // 打った点は十字で示す。ここは人間の狙いの精度がそのまま数値になる場所で、
        // 塗りつぶした丸だと狙った画素が自分の描画で隠れてしまう。
        drawCrosshair(ctx, it.xPx, it.yPx, o.color, k, 12, 3.5, 1.8);
        ctx.font = `bold ${11 * k}px Inter, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 3 * k;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeText(o.id, it.xPx + 10 * k, it.yPx);
        ctx.fillText(o.id, it.xPx + 10 * k, it.yPx);
      });
    }

    // ----- 原点 -----
    // 指定されているときだけ描く。未指定なら従来どおり画像の隅が原点で、
    // そこに印を出しても情報量がないため。
    if (calibration.origin) {
      const o = calibration.origin;
      const r = 11 * k;
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 4 * k;
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        ctx.moveTo(o.x - r, o.y); ctx.lineTo(o.x + r, o.y);
        ctx.moveTo(o.x, o.y - r); ctx.lineTo(o.x, o.y + r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(o.x, o.y, r * 0.55, 0, Math.PI * 2);
        ctx.stroke();
        // 1 周目は影、2 周目に本体を重ねて背景に埋もれないようにする
        ctx.strokeStyle = '#fcd34d';
        ctx.lineWidth = 1.8 * k;
      }
      // 軸の向きを矢印で示す（yUp かどうかが一目で分かる）
      const up = calibration.yUp ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(o.x + r, o.y);
      ctx.lineTo(o.x + r - 4 * k, o.y - 3 * k);
      ctx.moveTo(o.x + r, o.y);
      ctx.lineTo(o.x + r - 4 * k, o.y + 3 * k);
      ctx.moveTo(o.x, o.y + up * r);
      ctx.lineTo(o.x - 3 * k, o.y + up * (r - 4 * k));
      ctx.moveTo(o.x, o.y + up * r);
      ctx.lineTo(o.x + 3 * k, o.y + up * (r - 4 * k));
      ctx.stroke();

      ctx.font = `bold ${11 * k}px Inter, sans-serif`;
      ctx.fillStyle = '#fcd34d';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('原点', o.x + r + 3 * k, o.y + 3 * k);
      ctx.restore();
    }

    // ----- 手動修正モードのハンドル -----
    // 当たり判定と同じ点に出す。ここがズレていると「掴めるように見えるのに
    // 掴めない」状態になり、原因が分からない。
    if (correctMode && !isPlaying) {
      const vEl = videoRef.current;
      const fi = nearestFrameIndex(vEl ? vEl.currentTime : 0);
      objects.forEach(o => {
        if (!o.active || o.status === 'exited') return;
        const gp = grabPoint(o, fi);
        if (!gp) return;
        const beingDragged = dragMode === 'manual' && manualObjId === o.id;
        const c = beingDragged && dragCurrent ? dragCurrent : gp;
        // 掴める範囲を示す破線の輪
        ctx.beginPath();
        ctx.arc(c.x, c.y, 13 * k, 0, Math.PI * 2);
        ctx.strokeStyle = beingDragged ? '#ffffff' : o.color;
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
        // 輪の中に十字。ドラッグ中もどの画素へ置こうとしているかが見える
        drawCrosshair(ctx, c.x, c.y, beingDragged ? '#ffffff' : o.color, k, 9, 3, 1.6);
      });
    }
    // ----- 「ここまでは正しい」の候補 -----
    //
    // 怪しい範囲（移動量が中央値から外れ始めたところ）を濃い橙で、
    // それより前を薄く描く。どこから色が変わるかが、そのまま
    // 「ドリフトが始まったあたり」の目印になる。
    if (pickMode && pickPoints.length > 0) {
      ctx.save();
      pickPoints.forEach((q, i) => {
        const warn = i >= pickWarnFrom;
        ctx.beginPath();
        ctx.arc(q.point.x, q.point.y, 5.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = warn ? 'rgba(239,68,68,0.9)' : 'rgba(245,158,11,0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.6 * k;
        ctx.stroke();
      });
      // 選択中は二重の輪で囲む。どれを選んでいるかが分からないまま
      // 「ここで切る」を押させてはいけない。
      if (pickIdx !== null && pickPoints[pickIdx]) {
        const c = pickPoints[pickIdx].point;
        [['rgba(0,0,0,0.6)', 4], ['#ffffff', 2.2]].forEach(([col, w]) => {
          ctx.beginPath();
          ctx.arc(c.x, c.y, 13 * k, 0, Math.PI * 2);
          ctx.strokeStyle = col as string;
          ctx.lineWidth = (w as number) * k;
          ctx.stroke();
        });
      }
      ctx.restore();
    }

    // ----- クリックで置いた枠の中心（大きさを決める前） -----
    if (roiCenter && !pickMode) {
      const half = roiSize / 2;
      const obj = objects.find(o => o.id === selectedObjId);
      const color = obj?.color ?? '#6366f1';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([6 * k, 4 * k]);
      ctx.strokeRect(roiCenter.x - half, roiCenter.y - half, roiSize, roiSize);
      ctx.setLineDash([]);
      ctx.restore();
      drawCrosshair(ctx, roiCenter.x, roiCenter.y, color, k, 9, 3, 1.7);
    }
  }, [
    historyData, objects, selectedObjId, showTrail,
    dragMode, dragStart, dragCurrent, isSquareMode, calibration,
    correctMode, isPlaying, manualObjId, nearestFrameIndex, grabPoint,
    originMode, manualMode, frameTolerance, issueTimes, isLineCalibrating, calibFocus,
    pickMode, pickPoints, pickWarnFrom, pickIdx, roiCenter, roiSize,
  ]);

  renderRef.current = renderFrame;

  /** 虫めがねを出す位置（映像の表示領域の中での画面座標） */
  const loupeAt = (() => {
    // 候補を選んでいる間は、選択中の点を拡大する。
    // 「点がマーカーに乗っているか」の判断は拡大なしでは決められない。
    const picked = pickMode && pickIdx !== null ? pickPoints[pickIdx]?.point : null;
    const base = picked ?? dragCurrent ?? hoverPt;
    const show =
      !!base && (
        !!dragMode || pickMode || !!roiCenter || seedMode || originMode
        || isLineCalibrating || (correctMode && !isPlaying)
      );
    if (!show || !base) return null;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const cr = canvas.getBoundingClientRect();
    const sr = container.getBoundingClientRect();
    const screenX = cr.left + (base.x / canvas.width) * cr.width - sr.left;
    // カーソルと重ならないよう、触っている側と反対の上隅に出す
    const left = screenX > sr.width / 2 ? 10 : sr.width - LOUPE_SIZE - 10;
    return { left, top: 10, src: base };
  })();

  /**
   * 虫めがねを描く。
   *
   * 拡大元は canvas そのもの（映像＋枠＋軌跡）。映像だけを拡大すると
   * 「いま置こうとしている点がどこか」が見えないので意味がない。
   * imageSmoothing を切ってあるのは、画素の境目を見せたいから。
   * どの画素を指しているかが分からないと、1px の精度では置けない。
   */
  const drawLoupe = useCallback(() => {
    const lc = loupeRef.current;
    const canvas = canvasRef.current;
    if (!lc || !canvas || !loupeAt) return;
    const ctx = lc.getContext('2d');
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    const dispScale = r.width > 0 ? r.width / canvas.width : 1; // 画面px / 動画px
    const srcSize = LOUPE_SIZE / Math.max(0.001, dispScale * LOUPE_MAG);
    const sx = loupeAt.src.x - srcSize / 2;
    const sy = loupeAt.src.y - srcSize / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(canvas, sx, sy, srcSize, srcSize, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    } catch (_) { /* 範囲外は無視 */ }
    const c = LOUPE_SIZE / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c - 12, c); ctx.lineTo(c - 4, c);
    ctx.moveTo(c + 4, c); ctx.lineTo(c + 12, c);
    ctx.moveTo(c, c - 12); ctx.lineTo(c, c - 4);
    ctx.moveTo(c, c + 4); ctx.lineTo(c, c + 12);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(99,102,241,0.95)';
    ctx.beginPath();
    ctx.arc(c, c, 2.5, 0, Math.PI * 2);
    ctx.stroke();
  }, [loupeAt]);

  // canvas を描き終えたあとに拡大するので、1 フレーム遅らせる
  useEffect(() => {
    if (!loupeAt) return;
    const id = requestAnimationFrame(drawLoupe);
    return () => cancelAnimationFrame(id);
  }, [drawLoupe, loupeAt, renderFrame]);


  // 停止中は状態変化のたびに1回描画
  useEffect(() => {
    if (!isPlaying) renderFrame();
  }, [renderFrame, isPlaying]);

  // -------------------------------------------------
  // ② requestVideoFrameCallback による処理ループ
  // -------------------------------------------------

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isPlaying) return;

    let cancelled = false;
    let handle: number | null = null;
    let rafId: number | null = null;

    const step = (mediaTime: number) => {
      // 終点を越えたら自動で止める。
      // 「終わりを目で見張って一時停止を押す」操作をなくすためのもので、
      // 押し遅れて余分なフレームが混ざる事故もこれで消える。
      const r = timeRangeRef.current;
      if (r.end !== null && mediaTime > r.end) {
        v.pause();
        setIsPlaying(false);
        frameTimeRef.current = mediaTime;
        setCurrentTime(mediaTime);
        return;
      }

      // ここでは fps を計測しない。
      //
      // 以前は再生中の rVFC 間隔から測っていたが、実測で真値のちょうど半分が出た
      // （QuickTime のエンコード FPS 30.03 に対して 15）。
      // 再生中の rVFC は「画面に提示されたフレーム」しか拾えず、
      // 登録タイミング次第で 1 枚おきになるうえ、画面のリフレッシュレートも超えられない。
      // 時間軸の換算はこの値を分子に持つので、半分になると速度も半分になる。
      // ファイルfps は読み込み時の measureFileFps（シークで測る）だけに任せる。
      lastMediaTimeRef.current = mediaTime;
      // 再生中も「いま見えているフレームの時刻」を更新しておく。
      // 一時停止した直後に手で点を打つとき、この値が使われる
      frameTimeRef.current = mediaTime;

      processRef.current(v, mediaTime, frameCounterRef.current++);
      renderRef.current();

      // UI のシークバーは間引いて更新
      const now = performance.now();
      if (now - lastUiTimeRef.current > 120) {
        lastUiTimeRef.current = now;
        setCurrentTime(mediaTime);
      }
    };

    if (rvfcSupported) {
      const cb = (_now: number, meta: any) => {
        if (cancelled) return;
        step(typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime);
        handle = (v as any).requestVideoFrameCallback(cb);
      };
      handle = (v as any).requestVideoFrameCallback(cb);
    } else {
      // 非対応ブラウザ用フォールバック：currentTime が進んだ時だけ処理
      let lastT = -1;
      const loop = () => {
        if (cancelled) return;
        const t = v.currentTime;
        if (t !== lastT && !v.paused && !v.ended) {
          lastT = t;
          step(t);
        }
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }

    return () => {
      cancelled = true;
      if (handle !== null && rvfcSupported) {
        try { (v as any).cancelVideoFrameCallback(handle); } catch (_) { /* noop */ }
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // fpsSettings.value は step 内で参照するだけなのであえて依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, rvfcSupported]);

  // -------------------------------------------------
  // 再生制御
  // -------------------------------------------------

  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    if (isPlaying) {
      v.pause();
      setIsPlaying(false);
      return;
    }

    // 記録できない位置（区間の手前、枠を引いたコマより前、終点より後ろ）から
    // 再生を始めようとしたら、まず記録が始まる位置へ送る。
    // そのまま再生すると「再生しているのに点が増えない」という
    // 分かりにくい状態になる。
    const st = restartTime;
    const en = rangeEnd(timeRange, duration);
    if (v.currentTime < st - 1e-3 || v.currentTime > en - 1e-3) {
      try {
        const t = await seekToFrameTime(v, st);
        frameTimeRef.current = t;
        setCurrentTime(t);
      } catch (_) { /* シークに失敗してもそのまま再生を試みる */ }
    }

    try { v.playbackRate = playbackRate; } catch (_) { /* 非対応の速度 */ }
    v.play().then(() => setIsPlaying(true)).catch(err => {
      console.error('[VideoCanvas] 再生できませんでした:', err);
    });
  };

  // 対応していない速度を代入すると例外が飛ぶブラウザがあるので、
  // 必ず読み戻して UI と実際の速度をそろえる。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.playbackRate = playbackRate;
    } catch (_) { /* 下限に丸められる。下で読み戻す */ }
    if (Math.abs(v.playbackRate - playbackRate) > 1e-6) setPlaybackRate(v.playbackRate);
  }, [playbackRate]);

  /**
   * やり直し — 軌跡を消し、枠を最初に引いた位置へ戻し、記録が始まる時刻へ送る。
   *
   * 戻る先は「区間の始点」、無ければ「枠を引いたコマ」、それも無ければ先頭。
   * 枠を引いたコマより前へ戻しても、そのコマに物体がいないので
   * テンプレートが作れず、追跡が始まらないため。
   *
   * 枠を戻すのは onClearTrail（App 側）が行う。戻る先の時刻を渡すのは、
   * 直前の軌跡が残っていれば「そのコマで物体がいた位置」へ枠を戻せるため。
   * 区間の始点を後から動かしたときに、枠だけが最初に引いた場所へ取り残されて
   * 「やり直すたびに枠を置き直す」ことになるのを防ぐ。
   */
  const handleReset = async () => {
    const v = videoRef.current;
    if (v) v.pause();
    setIsPlaying(false);

    // 先に消す。手動点の確認でキャンセルされたら、動画は動かさない
    // （データが残ったまま始点へ飛ぶと、何が起きたのか分からなくなる）。
    if (!onClearTrail(restartTime)) return;

    if (v) {
      const st = restartTime;
      try {
        const t = await seekToFrameTime(v, st);
        frameTimeRef.current = t;
        setCurrentTime(t);
      } catch (_) {
        v.currentTime = st;
        setCurrentTime(st);
      }
    }
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
  };

  // -------------------------------------------------
  // 解析区間
  // -------------------------------------------------

  /**
   * 枠を引いたコマの時刻。
   *
   * テンプレートは「枠を引いた瞬間のコマの画」から作られるので、
   * それより前へ戻して再生しても、そのコマに物体がいなければ追跡は始まらない。
   * だから「やり直し」で戻る先は 0 秒ではなく、区間の始点か、それが無ければ
   * 枠を引いたコマになる。
   */
  const roiTimes = useMemo(
    () => objects
      .filter(o => o.active && o.initialTime !== null)
      .map(o => o.initialTime as number),
    [objects]
  );
  const roiStartTime = earliestRoiTime(roiTimes);
  /** 1.5 コマ分。ずれの判定はこれを基準にする */
  const frameTol = sameFrameTolerance(fpsSettings.value);
  /** 複数の物体の枠を別々のコマで引いていないか（引いていると片方が破綻する） */
  const roiSpread = roiTimeSpread(roiTimes);
  const roiFramesDiffer = roiSpread > frameTol;
  /** 区間の始点と、枠を引いたコマがずれていないか */
  const startMismatch =
    timeRange.start !== null && roiStartTime !== null
      ? Math.abs(timeRange.start - roiStartTime) > frameTol
      : false;

  /** 「やり直し」と、記録できない位置から再生を始めたときに戻る先 */
  const restartTime = restartTimeFor(timeRange, roiTimes);

  /**
   * 記録が始まるコマへ送るだけ。軌跡は消さない。
   * 「やり直し」と混同されやすいので、別のボタンに分けてある。
   */
  const goToStart = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setIsPlaying(false);
    try {
      const t = await seekToFrameTime(v, restartTime);
      frameTimeRef.current = t;
      setCurrentTime(t);
    } catch (_) {
      v.currentTime = restartTime;
      setCurrentTime(restartTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartTime, setIsPlaying]);


  /**
   * 全コマ処理 — 再生せずに 1 コマずつシークして、すべてのフレームを処理する。
   *
   * なぜ必要か
   *   再生しながらの処理は requestVideoFrameCallback に乗っているので、
   *   1 フレーム分の処理が実時間のフレーム間隔に間に合わないと、
   *   その間に提示されたコマは**呼ばれないまま通り過ぎる**。
   *   これが「速度を落とすと追尾がうまくいく」の正体で、
   *   遅くするのは取りこぼす確率を下げているだけで、ゼロにはならない。
   *
   *   ここでは映像を止めたまま「次のコマへシーク → 処理」を繰り返すので、
   *   端末の速さに関係なく取りこぼしが原理的に起きない。
   *   そのぶん実時間はかかる（1 コマあたり数十 ms のシート待ち）。
   *
   * 進む刻みは 1/fps に 1/4 コマ足した値を狙う。境界ぴったりを指定すると、
   * 丸めの向きしだいで同じコマに留まることがある（stepFrames と同じ考え方）。
   */
  const runSweep = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !videoLoaded || sweeping) return;
    v.pause();
    setIsPlaying(false);
    sweepCancelRef.current = false;
    setSweeping(true);
    setSweepProgress(0);

    try {
      const fps = fpsSettings.value > 0 ? fpsSettings.value : 30;
      const dt = 1 / fps;
      const from = restartTime;
      const to = rangeEnd(timeRange, duration);
      const span = Math.max(1e-6, Math.min(to, duration || to) - from);

      let t = await seekToFrameTime(v, from);
      frameTimeRef.current = t;
      setCurrentTime(t);
      processRef.current(v, t, frameCounterRef.current++);
      renderRef.current();

      // 狙う時刻（cursor）は、観測した時刻（t）とは別に持って必ず前へ進める。
      //
      // seekToFrameTime は、シークしても新しいコマが提示されなかった場合に
      // 実フレーム時刻ではなく「要求した時刻」を返すことがある
      // （requestVideoFrameCallback が発火しないときのフォールバック）。
      // その値をそのまま次の起点にすると、狙いがコマ境界からずれて、
      // やがて前のコマへ戻ってしまい途中で止まる（実測で 30 コマ目で停止した）。
      let cursor = t;
      let stall = 0;
      let guard = 0;
      while (!sweepCancelRef.current && guard < 20000) {
        guard++;
        cursor = Math.max(cursor, t) + dt;
        if (cursor > to + dt) break;             // 区間の終点を越えた
        // 境界ぴったりを狙うと丸めで同じコマに留まるので 1/4 コマ足す
        // 猶予を長めに取る。ここは対話ではないので待てるし、
        // 待ち切れないと記録される時刻が 1 コマ未満ずれる
        let got = await seekToFrameTime(v, cursor + dt * 0.25, 600, 220);
        if (!(got > t + dt * 0.2)) {
          // 新しいコマが提示されなかった。もう半コマ押して一度だけ試す。
          // ここで諦めるとそのコマを 1 枚落とすことになる
          got = await seekToFrameTime(v, cursor + dt * 0.6, 600, 220);
        }
        if (got > t + dt * 0.2) {
          t = got;
          stall = 0;
          if (t > to + 1e-9) break;
          frameTimeRef.current = t;
          setCurrentTime(t);
          processRef.current(v, t, frameCounterRef.current++);
          renderRef.current();
          setSweepProgress(Math.min(1, (t - from) / span));
        } else if (++stall >= 3) {
          break;   // 3 回続けて新しいコマが出てこない＝本当に末尾
        }
      }
    } catch (err) {
      console.error('[VideoCanvas] 全コマ処理でエラー:', err);
    } finally {
      setSweeping(false);
      setSweepProgress(0);
      // 最後の数コマは間引きの都合で未反映のことがあるので、明示的に確定させる
      onFlushHistory?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoLoaded, sweeping, fpsSettings.value, duration, restartTime, timeRange]);


  /** 「いま画面に出ているフレーム」の時刻。要求時刻ではなく実際の mediaTime */
  const shownTime = () => frameTimeRef.current || currentTime;

  const setRangeStartHere = () => onChangeTimeRange({ ...timeRange, start: shownTime() });
  const setRangeEndHere = () => onChangeTimeRange({ ...timeRange, end: shownTime() });
  const clearRange = () => onChangeTimeRange(FULL_RANGE);

  /** 区間の端へ飛ぶ（指定した位置を目で確かめるため） */
  const seekTo = useCallback(async (t: number) => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    v.pause();
    setIsPlaying(false);
    try {
      const got = await seekToFrameTime(v, t);
      frameTimeRef.current = got;
      setCurrentTime(got);
    } catch (_) { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoLoaded]);

  /** 区間内に入っている記録点の数（少なすぎると自動遮断周波数が不安定になる） */
  const pointsInRange = useMemo(
    () => countInRange(historyData, timeRange),
    [historyData, timeRange]
  );
  const rangeActive = hasRange(timeRange);
  const rangeSpanSec = rangeSpan(timeRange, duration);
  /** スロー動画では実時間も併記する。ファイル上の秒数だけ見て判断させない */
  const rangeSpanReal = rangeSpanSec * timeScale(fpsSettings);
  const tooFewPoints = rangeActive && pointsInRange > 0 && pointsInRange < MIN_RANGE_POINTS;
  /** シークバー上での位置（0–1）。トラックの左右にはつまみの半分だけ余白がある */
  const frac = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0);
  const bandLeft = frac(rangeStart(timeRange));
  const bandRight = duration > 0 ? frac(rangeEnd(timeRange, duration)) : 1;

  /** 追跡が暴れたときの一時停止要求（App から届く） */
  useEffect(() => {
    if (!pauseAt) return;
    const v = videoRef.current;
    if (v) v.pause();
    setIsPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pauseAt]);

  // グラフをクリックされたら、その時刻へ移動して止める。
  // 再生したままだとすぐ通り過ぎてしまい、修正できない。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seekRequest || !videoLoaded) return;
    v.pause();
    setIsPlaying(false);
    // 実際に表示されたフレームの時刻を覚えておく（要求時刻とは限らない）
    seekToFrameTime(v, seekRequest.t).then(t => {
      frameTimeRef.current = t;
      setCurrentTime(t);
    });
    // seekRequest 以外を依存に入れると、再生のたびに巻き戻ってしまう
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  /**
   * n コマ分だけ進む／戻る（停止中の精密確認用）。
   *
   * 進んだあとに「実際に表示されたフレームの時刻」を読み直して覚えておく。
   * fps の推定がずれていても、この値を起点に次のコマを狙うので
   * 誤差が積み上がらない。手動トラッキングはこの時刻を記録に使う。
   */
  const stepFrame = useCallback(async (n: number) => {
    const v = videoRef.current;
    if (!v || !videoLoaded || steppingRef.current) return;
    steppingRef.current = true;
    v.pause();
    setIsPlaying(false);
    try {
      const t = await stepFrames(v, fpsRef.current.value, n);
      frameTimeRef.current = t;
      setCurrentTime(t);
    } finally {
      steppingRef.current = false;
    }
  }, [videoLoaded, setIsPlaying]);

  // -------------------------------------------------
  // カーソル
  // -------------------------------------------------

  const cursorStyle =
    pickMode ? 'pointer'
    : originMode || seedMode || (manualMode && !isPlaying) ? 'crosshair'
      : isLineCalibrating || dragMode === 'calib-new' ? 'crosshair'
      : dragMode === 'calib-p1' || dragMode === 'calib-p2' || dragMode === 'plane-corner' ? 'grabbing'
        : dragMode === 'manual' ? 'grabbing'
          : correctMode && !isPlaying ? 'grab'
            : dragMode === 'roi' ? 'crosshair'
              : 'default';

  const lostObjects = objects.filter(o => o.active && o.status === 'lost');
  const exitedObjects = objects.filter(o => o.active && o.status === 'exited');

  // -------------------------------------------------

  return (
    <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* ---- 表示オプション ---- */}
      {videoLoaded && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px',
          border: '1px solid var(--border-color)', flexWrap: 'wrap', gap: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>表示:</span>
            <button className="btn btn-secondary btn-sm" title="縮小"
              onClick={() => setZoom(p => Math.max(0.25, parseFloat((p - 0.25).toFixed(2))))}>
              <ZoomOut size={13} />
            </button>
            <span className="mono" style={{ fontSize: '0.82rem', minWidth: '44px', textAlign: 'center', fontWeight: 600 }}>
              {(zoom * 100).toFixed(0)}%
            </span>
            <button className="btn btn-secondary btn-sm" title="拡大"
              onClick={() => setZoom(p => Math.min(4, parseFloat((p + 0.25).toFixed(2))))}>
              <ZoomIn size={13} />
            </button>
            <button className="btn btn-secondary btn-sm" style={{ fontSize: '0.72rem' }}
              onClick={() => setZoom(1)}>100%</button>
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '0.8rem', cursor: 'pointer', userSelect: 'none', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={isSquareMode}
              onChange={e => setIsSquareMode(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
            正方形 (1:1)
          </label>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '0.8rem', cursor: 'pointer', userSelect: 'none', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showTrail}
              onChange={e => setShowTrail(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
            軌跡を表示
          </label>

          <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {videoDimensions.width} × {videoDimensions.height}px
          </span>
        </div>
      )}

      {/* ---- Canvas ---- */}
      <div ref={containerRef} style={{
        position: 'relative', width: '100%', minHeight: '360px', background: '#000',
        borderRadius: '10px', overflow: zoom === 1 ? 'hidden' : 'auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'inset 0 0 30px rgba(0,0,0,0.8)',
      }}>
        <video
          ref={videoRef}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={handleLoadedData}
          onSeeked={handleSeeked}
          onEnded={() => setIsPlaying(false)}
          onPause={() => setIsPlaying(false)}
          playsInline
          muted
          preload="auto"
          style={{ position: 'absolute', opacity: 0.001, width: 1, height: 1, pointerEvents: 'none', zIndex: -100 }}
        />

        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={finishDrag}
          onMouseLeave={() => { finishDrag(); setHoverPt(null); }}
          style={{
            width: zoom === 1 ? 'auto' : `${videoDimensions.width * zoom}px`,
            height: zoom === 1 ? 'auto' : `${videoDimensions.height * zoom}px`,
            maxWidth: zoom === 1 ? '100%' : 'none',
            maxHeight: zoom === 1 ? '680px' : 'none',
            aspectRatio: `${videoDimensions.width} / ${videoDimensions.height}`,
            cursor: cursorStyle,
            display: 'block',
          }}
        />

        {!videoLoaded && (
          <label htmlFor="video-upload-main" style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '16px', cursor: 'pointer',
            background: 'rgba(8,13,26,0.9)', color: 'var(--text-secondary)',
          }}>
            <div style={{ padding: '20px', borderRadius: '50%', background: 'rgba(99,102,241,0.1)', border: '2px dashed rgba(99,102,241,0.45)' }}>
              <Upload size={40} color="var(--accent-primary)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '1.05rem', marginBottom: '6px' }}>
                分析対象の動画を選択
              </p>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>MP4, WebM, MOV, AVI</p>
            </div>
            <input id="video-upload-main" type="file" accept="video/*" onChange={handleFileChange} style={{ display: 'none' }} />
          </label>
        )}

        {isLineCalibrating && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(245,158,11,0.95)', color: '#000', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            {calibration.mode === 'plane'
              ? `📐 ${['左上', '右上', '右下', '左下'][calibration.planePoints.length % 4]}の角をクリック（${calibration.planePoints.length}/4・ESCで中止）`
              : '📏 既知の長さの端から端までドラッグ（ESCで中止）'}
          </div>
        )}

        {manualMode && !originMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(10,132,255,0.95)', color: '#fff', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            {manualMsg ?? (
              (manualPick ?? manualTarget.objId)
                ? `👆 ${manualPick ?? manualTarget.objId} の位置をクリック${
                    manualPick ? '（指名中）' : ''
                  }`
                : '追跡対象がありません'
            )}
          </div>
        )}

        {seedMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(245,158,11,0.95)', color: '#000', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            ⚡ {selectedObjId} の枠から、移動した先までドラッグ（ESCで中止）
          </div>
        )}

        {seedMsg && !seedMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            width: 'min(560px, 92%)', background: 'rgba(15,23,42,0.96)',
            border: '1.5px solid rgba(239,68,68,0.6)', borderRadius: 12,
            padding: '11px 14px', boxShadow: '0 6px 24px rgba(0,0,0,0.6)', zIndex: 5,
          }}>
            <div style={{
              fontSize: '0.8rem', color: '#fca5a5', lineHeight: 1.6, fontWeight: 600,
            }}>
              ⚠ {seedMsg.msg}
            </div>
            {seedMsg.betterSize !== undefined && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 9 }}
                onClick={() => {
                  const n = seedMsg.betterSize as number;
                  setRoiSize(n);
                  setSeedMsg(null);
                  // 中心は今の枠の中心。大きさだけ測った値へ置き換える
                  const o = objects.find(x => x.id === selectedObjId);
                  const base = o?.initialRoi ?? o?.roi;
                  if (base) {
                    setRoiCenter({
                      x: base.x + base.width / 2,
                      y: base.y + base.height / 2,
                    });
                  }
                  void goToStart();
                }}>
                <Maximize2 size={14} />
                枠を {seedMsg.betterSize}px にして置き直す
              </button>
            )}
          </div>
        )}

        {originMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(245,158,11,0.95)', color: '#000', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            🎯 原点にしたい位置をクリック（ESCで中止）
          </div>
        )}

        {correctMode && !isPlaying && !isLineCalibrating && !originMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(99,102,241,0.95)', color: '#fff', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            {correctMsg ?? '✋ 修正モード — 点をドラッグして直す／Delete で消す'}
          </div>
        )}

        {exitedObjects.length > 0 && (
          <div style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(245,158,11,0.9)', color: '#000', padding: '5px 14px',
            borderRadius: 16, fontSize: '0.78rem', fontWeight: 700, pointerEvents: 'none', whiteSpace: 'nowrap',
          }}>
            画面外へ退出 → 追尾終了: {exitedObjects.map(o => o.id).join(', ')}
          </div>
        )}

        {/* ---- 虫めがね ---- */}
        {loupeAt && (
          <div style={{
            position: 'absolute', left: loupeAt.left, top: loupeAt.top,
            width: LOUPE_SIZE, height: LOUPE_SIZE, borderRadius: 10, overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.75)', background: '#000',
            boxShadow: '0 4px 16px rgba(0,0,0,0.6)', pointerEvents: 'none', zIndex: 6,
          }}>
            <canvas ref={loupeRef} width={LOUPE_SIZE} height={LOUPE_SIZE}
              style={{ display: 'block', width: '100%', height: '100%' }} />
          </div>
        )}

        {/* ---- 追跡が飛んで止まったときの案内 ---- */}
        {halt && !pickMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            width: 'min(560px, 92%)', background: 'rgba(15,23,42,0.96)',
            border: '1.5px solid rgba(239,68,68,0.6)', borderRadius: 12,
            padding: '12px 14px', boxShadow: '0 6px 24px rgba(0,0,0,0.6)', zIndex: 5,
          }}>
            <div style={{ fontWeight: 700, fontSize: '0.86rem', color: '#fca5a5', marginBottom: 6 }}>
              {halt.objId}: {halt.time.toFixed(3)} s で追跡が飛びました
            </div>
            <div style={{
              fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: 10,
            }}>
              1 コマ {Math.round(halt.step)}px・直前までは {Math.round(halt.base)}px
              {halt.atEdge && '・相関のピークが探索窓の縁'}。
              <br />
              このコマには ✕ を付けて軌跡を切りました。ずれは数コマ前から
              始まっていることが多いので、戻す位置を選んでください。
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={() => setPickMode(true)}>
                <CutIcon size={14} />
                ここから取り直す
              </button>
              <button className="btn btn-secondary btn-sm"
                onClick={() => {
                  onDismissHalt(false);
                  setCorrectMode(true);
                  void seekTo(halt.time);
                }}>
                <Hand size={14} />
                この点を手で直す
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => onDismissHalt(true)}>
                <Check size={14} />
                誤検出・続ける
              </button>
            </div>
          </div>
        )}

        {/* ---- どこまで戻すかを選ぶ ---- */}
        {/*
            下の細い帯にしてある。選ぶ対象は映像の上の点なので、覆ってはいけない。
            選択を動かすたびにそのコマへ送るので、点がマーカーに乗っているかを
            見ながら決められる。
        */}
        {pickMode && (
          <div style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            width: 'min(620px, 94%)', background: 'rgba(15,23,42,0.94)',
            border: '1px solid rgba(245,158,11,0.5)', borderRadius: 12,
            padding: '9px 12px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)', zIndex: 5,
          }}>
            <div style={{
              fontSize: '0.74rem', color: 'var(--text-secondary)',
              lineHeight: 1.5, marginBottom: 7,
            }}>
              点がマーカーに乗っている
              <b style={{ color: '#fbbf24' }}>最後のコマ</b>へ。
              ← → か点のクリックで選ぶと、そのコマが映ります（赤い点は移動量が普段から外れたコマ）。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-secondary btn-sm"
                disabled={pickIdx === null || pickIdx <= 0}
                onClick={() => setPickIdx(i => (i === null ? null : Math.max(0, i - 1)))}>
                <ChevronLeft size={15} />
              </button>
              <button className="btn btn-secondary btn-sm"
                disabled={pickIdx === null || pickIdx >= pickPoints.length - 1}
                onClick={() => setPickIdx(i =>
                  (i === null ? null : Math.min(pickPoints.length - 1, i + 1)))}>
                <ChevronRight size={15} />
              </button>
              <span className="mono" style={{
                fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)',
              }}>
                {pickIdx !== null && pickPoints[pickIdx]
                  ? `${pickPoints[pickIdx].time.toFixed(3)} s`
                  : '—'}
              </span>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', flex: 1 }}>
                {pickIdx !== null && pickPoints.length - 1 - pickIdx > 0
                  ? `後ろ ${pickPoints.length - 1 - pickIdx} 点を捨てる`
                  : 'この点まで残す'}
              </span>
              <button className="btn btn-primary btn-sm"
                disabled={pickIdx === null || !pickPoints[pickIdx]}
                onClick={() => {
                  if (pickIdx !== null && pickPoints[pickIdx]) cutAt(pickPoints[pickIdx]);
                }}>
                <CutIcon size={14} />
                ここで切る
              </button>
              <button className="btn btn-secondary btn-sm"
                onClick={() => { setPickMode(false); onDismissHalt(false); }}>
                <XCircle size={14} />
              </button>
            </div>
          </div>
        )}

        {cutMsg && !halt && !pickMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(16,185,129,0.95)', color: '#04221a', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.8rem', fontWeight: 700, pointerEvents: 'none',
            maxWidth: '86%', lineHeight: 1.5, boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            ✂ {cutMsg}
          </div>
        )}

        {/* ---- 中心を置いたあと、枠の大きさを決める ---- */}
        {roiCenter && !pickMode && !halt && (
          <div style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            width: 'min(520px, 94%)', background: 'rgba(15,23,42,0.96)',
            border: '1px solid var(--border-color)', borderRadius: 12,
            padding: '10px 14px', boxShadow: '0 6px 24px rgba(0,0,0,0.6)', zIndex: 5,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 8,
            }}>
              <span>{selectedObjId} の枠の大きさ</span>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                {Math.round(roiSize)}px
              </span>
            </div>
            <input
              type="range" min={MIN_ROI_SIZE} max={240} step={1} value={roiSize}
              onChange={e => setRoiSize(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
            />
            <div style={{
              fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6,
              margin: '6px 0 9px',
            }}>
              マーカー全体が入る大きさに。内側だけだと、光の反射や回転で滑ります。
              映像をもう一度クリックすれば中心を置き直せます。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={confirmRoi}>
                <Check size={14} />
                決定
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setRoiCenter(null)}>
                <XCircle size={14} />
                やめる
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---- コントロールバー ---- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={togglePlay} disabled={!videoLoaded || sweeping}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? '一時停止' : '再生 & 追跡'}
          </button>

          <button
            className={`btn btn-sm ${sweeping ? 'btn-warning' : 'btn-secondary'}`}
            onClick={() => { if (sweeping) sweepCancelRef.current = true; else runSweep(); }}
            disabled={!videoLoaded || isPlaying}
            title="再生せずに 1 コマずつ処理します。端末の速さに関係なく取りこぼしが起きません（そのぶん実時間はかかります）">
            {sweeping ? <StopIcon size={14} /> : <ListVideo size={15} />}
            {sweeping ? `中止（${Math.round(sweepProgress * 100)}%）` : '全コマ処理'}
          </button>

          <button className="btn btn-secondary btn-sm" onClick={() => stepFrame(-1)} disabled={!videoLoaded} title="1フレーム戻る">
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => stepFrame(1)} disabled={!videoLoaded} title="1フレーム進む">
            <ChevronRight size={15} />
          </button>

          <button
            className={`btn btn-sm ${correctMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setCorrectMode(v => !v);
              setIsLineCalibrating(false);
              setOriginMode(false);
            }}
            disabled={!videoLoaded}
            title="一時停止中に、ずれた追跡点をドラッグして手で直します">
            <Hand size={14} />
            修正
          </button>

          <button
            className={`btn btn-sm ${manualMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setManualMode(v => !v);
              setCorrectMode(false);
              setOriginMode(false);
              setIsLineCalibrating(false);
              const v = videoRef.current;
              if (v) { v.pause(); setIsPlaying(false); }
            }}
            disabled={!videoLoaded}
            title="コマごとに対象をクリックして手で記録します（自動追跡が効かない対象向け）">
            <MousePointerClick size={14} />
            手動記録
          </button>

          <button
            className={`btn btn-sm ${seedMode ? 'btn-warning' : 'btn-secondary'}`}
            onClick={() => { if (seedMode) setSeedMode(false); else void startSeed(); }}
            disabled={!videoLoaded || !objects.find(o => o.id === selectedObjId)?.initialRoi}
            title="速い対象向け。枠を置いたコマから数コマ送って同じ対象を指すと、追跡の最初から予測が効きます">
            <Zap size={14} />
            2点目を指す
          </button>

          <button
            className={`btn btn-sm ${originMode ? 'btn-warning' : 'btn-secondary'}`}
            onClick={() => {
              setOriginMode(v => !v);
              setIsLineCalibrating(false);
              setCorrectMode(false);
            }}
            disabled={!videoLoaded}
            title="座標の原点にしたい位置をクリックします（斜面の始点など）">
            <Crosshair size={14} />
            原点
          </button>

          {calibration.origin && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onUpdateCalibration({ ...calibration, origin: null })}
              title="原点を解除して画像の隅に戻します">
              <Eraser size={14} />
              原点解除
            </button>
          )}

          {manualMode && manualOrder.length > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              fontSize: '0.75rem', color: 'var(--text-secondary)',
            }}>
              <span>次に打つ</span>
              {objects.filter(o => o.active).map(o => {
                const isNext = (manualPick ?? manualTarget.objId) === o.id;
                // そのコマで既に打ってあるかを出す（打ち直しか新規かが分かる）
                const cur = historyData.find(
                  f => Math.abs(f.timestamp - frameTimeRef.current) <= frameTolerance
                );
                const done = !!cur?.objects[o.id]?.manual;
                return (
                  <button
                    key={o.id}
                    onClick={() => setManualPick(o.id)}
                    title={done ? `${o.id} はこのコマで記録済み（押すと打ち直し）` : `${o.id} を次に打つ`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 9px', borderRadius: 7, cursor: 'pointer',
                      fontSize: '0.73rem', fontWeight: 700,
                      background: isNext ? o.color : 'rgba(255,255,255,0.06)',
                      color: isNext ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${isNext ? o.color : 'var(--border-color)'}`,
                      opacity: done && !isNext ? 0.55 : 1,
                    }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: isNext ? '#fff' : o.color,
                    }} />
                    {o.id}
                    {done && <span style={{ fontSize: '0.68rem' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}

          {manualMode && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '0.75rem', color: 'var(--text-secondary)',
                background: 'rgba(10,132,255,0.1)', border: '1px solid rgba(10,132,255,0.3)',
                padding: '3px 9px', borderRadius: '7px',
              }}>
                <span>コマ送り</span>
                <input
                  type="range" min={1} max={30} step={1} value={manualStep}
                  onChange={e => {
                    manualStepTouched.current = true;
                    setManualStep(parseInt(e.target.value));
                  }}
                  style={{ width: 90 }}
                  title="1 回打つごとに進めるコマ数。詰めすぎると加速度のばらつきが増える"
                />
                {/* 実時間の間隔を出す。加速度の精度はここでほぼ決まるので、
                    コマ数だけ見せても判断できない */}
                <span
                  className="mono"
                  style={{
                    fontWeight: 700, minWidth: 76,
                    color: manualInterval < MANUAL_INTERVAL_WARN
                      ? '#fcd34d' : 'var(--text-primary)',
                  }}
                  title={
                    manualInterval < MANUAL_INTERVAL_WARN
                      ? '間隔が短すぎます。加速度は位置を2回微分するため、'
                        + 'クリックのぶれが 1/Δt² で拡大されます'
                      : ''
                  }
                >
                  {manualStep} コマ / {(manualInterval * 1000).toFixed(0)} ms
                </span>
              </div>

              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setManualMsg(onManualUndo() ? '直前の 1 点を取り消しました' : '取り消せる点がありません');
                }}
                title="直前に打った点を取り消します">
                <Undo2 size={14} />
                取り消し
              </button>

              <span className="mono" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                手動 {countManualPoints(historyData)} 点
              </span>
            </>
          )}

          {/* 記録が始まるコマへ送るだけ。軌跡は消さない */}
          <button
            className="btn btn-secondary" onClick={() => void goToStart()}
            disabled={!videoLoaded}
            title={`記録が始まる ${restartTime.toFixed(3)} s へ送ります（軌跡は消しません）`}
          >
            <SkipBack size={15} />
            始点へ
          </button>

          <button className="btn btn-secondary" onClick={handleReset} disabled={!videoLoaded}
            title={`軌跡を消し、枠を戻して ${restartTime.toFixed(3)} s へ送ります`}>
            <RotateCcw size={15} />
            やり直し
          </button>

          <button className="btn btn-secondary" onClick={onResetData} disabled={!videoLoaded} title="枠もデータも全消去">
            <Eraser size={15} />
            全消去
          </button>

          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            <Upload size={15} />
            動画変更
            <input type="file" accept="video/*" onChange={handleFileChange} style={{ display: 'none' }} />
          </label>
        </div>

        {/* 再生速度 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Gauge size={14} color="var(--text-secondary)" />
          {PLAYBACK_RATES.map(r => (
            <button key={r.v}
              className={`btn btn-sm ${Math.abs(playbackRate - r.v) < 1e-6 ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '0.72rem', padding: '3px 8px' }}
              onClick={() => setPlaybackRate(r.v)}
              disabled={sweeping}
              title="遅くすると取りこぼしが減ります。確実に全コマ処理したいときは「全コマ処理」を使ってください">
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- 全コマ処理の進捗 ---- */}
      {sweeping && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '8px 12px', borderRadius: '8px',
          background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.4)',
        }}>
          <span style={{ fontSize: '0.78rem', color: '#fcd34d', fontWeight: 700, flexShrink: 0 }}>
            全コマ処理中
          </span>
          <div style={{
            flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
            background: 'rgba(255,255,255,0.10)',
          }}>
            <div style={{
              width: `${Math.round(sweepProgress * 100)}%`, height: '100%',
              background: '#f59e0b', transition: 'width 120ms linear',
            }} />
          </div>
          <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
            {Math.round(sweepProgress * 100)}%
          </span>
        </div>
      )}

      {/* シークバー（区間の帯を重ねて描く） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            type="range" min={0} max={duration || 100} step={0.001}
            value={currentTime}
            onChange={e => {
              const t = parseFloat(e.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = t;
                setCurrentTime(t);
              }
            }}
            disabled={!videoLoaded}
            style={{ flex: 1, width: '100%' }}
          />
          {/* 区間の帯。つまみの半分（8px）だけ内側にトラックがあるので合わせる */}
          {rangeActive && duration > 0 && (
            <div style={{
              position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none',
            }}>
              <div style={{
                position: 'absolute',
                left: `calc(8px + (100% - 16px) * ${bandLeft})`,
                width: `calc((100% - 16px) * ${Math.max(0, bandRight - bandLeft)})`,
                top: '50%', height: 8, transform: 'translateY(-50%)',
                background: 'rgba(99,102,241,0.35)',
                borderLeft: timeRange.start !== null ? '2px solid var(--accent-primary)' : 'none',
                borderRight: timeRange.end !== null ? '2px solid var(--accent-primary)' : 'none',
                borderRadius: 2,
              }} />
            </div>
          )}
        </div>
        <span className="mono" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
          {currentTime.toFixed(3)} / {duration.toFixed(2)} s
        </span>
      </div>

      {/* ---- 解析区間 ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '8px 12px', borderRadius: '8px',
        background: rangeActive ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${rangeActive ? 'rgba(99,102,241,0.28)' : 'rgba(255,255,255,0.07)'}`,
      }}>
        <Scissors size={14} color={rangeActive ? 'var(--accent-primary)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
          解析区間
        </span>

        <button
          className="btn btn-secondary btn-sm"
          onClick={setRangeStartHere}
          disabled={!videoLoaded}
          title="いま表示しているフレームを区間の始点にします">
          <CornerDownRight size={13} />
          始点にする
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={setRangeEndHere}
          disabled={!videoLoaded}
          title="いま表示しているフレームを区間の終点にします。ここで再生が自動停止します">
          <CornerDownLeft size={13} />
          終点にする
        </button>
        {rangeActive && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={clearRange}
            disabled={!videoLoaded}
            title="区間を解除して動画全体に戻します">
            <XCircle size={13} />
            解除
          </button>
        )}

        <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
          {timeRange.start !== null ? (
            <button
              className="btn btn-secondary btn-sm"
              style={{ padding: '2px 6px', fontSize: '0.72rem' }}
              onClick={() => seekTo(timeRange.start as number)}
              title="始点へ移動して確認します">
              {timeRange.start.toFixed(3)} s
            </button>
          ) : '先頭'}
          {' 〜 '}
          {timeRange.end !== null ? (
            <button
              className="btn btn-secondary btn-sm"
              style={{ padding: '2px 6px', fontSize: '0.72rem' }}
              onClick={() => seekTo(timeRange.end as number)}
              title="終点へ移動して確認します">
              {timeRange.end.toFixed(3)} s
            </button>
          ) : '末尾'}
          {rangeActive && rangeSpanSec > 0 && (
            <>
              {'  '}（{rangeSpanSec.toFixed(3)} s
              {Math.abs(rangeSpanReal - rangeSpanSec) > 1e-6 && ` / 実時間 ${rangeSpanReal.toFixed(3)} s`}
              {historyData.length > 0 && `・${pointsInRange} 点`}）
            </>
          )}
        </span>

        {/* 枠を引いたコマと区間の始点がずれていると、始点のコマに物体がいない。
            気づかないと「再生しても点が増えない」で詰まるので、直す手段ごと出す。 */}
        {(startMismatch || roiFramesDiffer) && (
          <div style={{
            flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 10,
            flexWrap: 'wrap', fontSize: '0.74rem', color: '#fcd34d', lineHeight: 1.55,
          }}>
            <span style={{ flex: 1, minWidth: 240 }}>
              {startMismatch && roiStartTime !== null && timeRange.start !== null && (
                <>
                  ⚠ 枠を引いたのは {roiStartTime.toFixed(3)} s のコマですが、区間の始点は
                  {' '}{timeRange.start.toFixed(3)} s です。テンプレートは枠を引いた瞬間のコマの画から
                  作られるので、始点のコマに物体がいないと追跡が始まりません。{' '}
                </>
              )}
              {roiFramesDiffer && (
                <>
                  ⚠ 物体ごとに別のコマで枠を引いています（差 {roiSpread.toFixed(3)} s）。
                  同じコマまで戻して引き直してください。片方は必ず外れます。
                </>
              )}
            </span>
            {startMismatch && roiStartTime !== null && (
              <button
                className="btn btn-warning btn-sm"
                onClick={() => onChangeTimeRange({ ...timeRange, start: roiStartTime })}
                title="枠を引いたコマを区間の始点にそろえます">
                枠のコマを始点にする
              </button>
            )}
          </div>
        )}

        {/* コマの点検結果。数値が合わないとき、原因がここにあることが多い */}
        {(trackQuality.issues.length > 0 || trackQuality.blurLimitTime !== null) && (
          <div style={{
            flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8,
            flexWrap: 'wrap', fontSize: '0.72rem', color: '#fcd34d', lineHeight: 1.5,
          }}>
            <span style={{ flex: 1, minWidth: 200 }}>
              {trackQuality.issues.length > 0 && (
                <>
                  ⚠ 位置の飛んでいるコマが {trackQuality.issues.length} 個あります
                  （{trackQuality.issues.slice(0, 4).map(v => v.timestamp.toFixed(3)).join(' / ')}
                  {trackQuality.issues.length > 4 ? ' …' : ''} s・映像では橙の破線で囲んでいます）。
                  動画側のコマの時刻ずれか、追跡の失敗です。速度と加速度はこの前後で必ず暴れます。{' '}
                </>
              )}
              {trackQuality.blurLimitTime !== null && (
                <>
                  ⚠ {trackQuality.blurLimitTime.toFixed(3)} s から、1 コマの移動量が枠の大きさに
                  近づきます。対象が自分の大きさ以上に流れて写るので、ここから先の点は
                  中心からずれます。
                </>
              )}
            </span>
            {trackQuality.blurLimitTime !== null && (
              <button
                className="btn btn-warning btn-sm"
                onClick={() => onChangeTimeRange({ ...timeRange, end: trackQuality.blurLimitTime })}
                title="ブレが大きくなる手前を区間の終点にします"
              >
                ここを終点にする
              </button>
            )}
          </div>
        )}

        <span style={{
          fontSize: '0.72rem', color: tooFewPoints ? '#fcd34d' : 'var(--text-muted)',
          lineHeight: 1.5, flexBasis: '100%',
        }}>
          {tooFewPoints ? (
            <>
              ⚠ 区間内が {pointsInRange} 点しかありません。{MIN_RANGE_POINTS} 点を切ると
              Butterworth の遮断周波数の自動選択が不安定になります。区間を広げてください。
            </>
          ) : rangeActive ? (
            <>
              区間外は追跡も記録もしません。終点で自動停止します。
              グラフ・フィルタ・CSV もこの区間だけを使います。
              {historyData.length > 0 &&
                ' 取り直すときは「やり直し」を押してください（軌跡を消し、枠を始点のコマの位置へ戻して始点へ送ります）。'}
            </>
          ) : (
            <>
              頭の準備時間や着地後の跳ね返りを外すと、フィルタの自動遮断周波数が
              運動区間だけを見るようになり、数値が安定します（任意）。
              {roiStartTime !== null &&
                ` いまは枠を引いた ${roiStartTime.toFixed(3)} s のコマが、やり直しで戻る先です。`}
            </>
          )}
        </span>
      </div>

      {/* ---- 操作ガイド ---- */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.78rem',
        color: 'var(--text-secondary)', background: 'rgba(99,102,241,0.06)', padding: '8px 12px',
        borderRadius: '8px', border: '1px solid rgba(99,102,241,0.15)', lineHeight: 1.5,
      }}>
        <Crosshair size={14} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: '2px' }} />
        <span>
          選択中: <b style={{ color: objects.find(o => o.id === selectedObjId)?.color || 'var(--text-primary)' }}>{selectedObjId}</b>
          {' '}— マーカーを囲むようにドラッグして追跡枠を指定。
          <b>枠は {RECOMMENDED_ROI_SIZE}px 以上</b>にしてください。小さすぎる枠は画面のどこにでも
          一致してしまい、軌跡が暴走します。
          {' '}取りこぼしが気になるときは、速度を落とすより<b>「全コマ処理」</b>を
          使ってください（原理的に 1 コマも落ちません）。
          {' '}<b>枠の中は、マーカーと一緒に動くものだけで埋めてください。</b>
          物体の面が広ければ枠を大きく取って構いませんが、動かない背景が入るぶんだけ
          精度が落ちます（合成データで実測。背景が入ると誤差が 13 倍）。
          背景を避けられない対象では、枠をマーカーぎりぎりまで詰めるのが正解です。
          {lostObjects.length > 0 && (
            <span style={{ color: '#ef4444', fontWeight: 600 }}> ⚠ LOST: {lostObjects.map(o => o.id).join(', ')} — 再指定してください</span>
          )}
          {!rvfcSupported && (
            <span style={{ color: '#f59e0b' }}> ※ このブラウザはフレーム同期APIに非対応です。Chrome / Edge を推奨します。</span>
          )}
        </span>
      </div>
    </div>
  );
};
