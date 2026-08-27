// src/App.tsx — MotionTrace Pro Ver.2.1
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrackedObject, ScaleCalibration, FilterSettings,
  FrameData, Rect, FpsSettings, TrackingSettings,
  DEFAULT_TRACKING, ObjectStatus, Point,
} from './types';
import { waitForOpenCV } from './utils/opencvLoader';
import { ObjectTracker, MIN_ROI_SIZE, RECOMMENDED_ROI_SIZE } from './utils/tracker';
import { FrameSource } from './utils/frameSource';
import { toReal } from './utils/calibration';
import { medianDt } from './utils/butterworth';
import {
  placeManualPoint, undoManualPoint, isFrameComplete, ManualEdit,
  countManualPoints,
} from './utils/manualTrack';
import {
  TimeRange, FULL_RANGE, inRange, normalizeRange, trackedPointAt,
} from './utils/timeRange';

import { Header } from './components/Header';
import { VideoCanvas } from './components/VideoCanvas';
import { ControlPanel } from './components/ControlPanel';
import { DataPanel } from './components/DataPanel';
import { AxisKey } from './components/MotionGraph';
import { DEFAULT_SMOOTH_WINDOW } from './utils/graphSmooth';

// -------------------------------------------------
// 定数
// -------------------------------------------------

const OBJECT_DEFS: Pick<TrackedObject, 'id' | 'name' | 'color'>[] = [
  { id: 'Obj1', name: 'Object 1', color: '#ff3b30' }, // 赤
  { id: 'Obj2', name: 'Object 2', color: '#0a84ff' }, // 青
  { id: 'Obj3', name: 'Object 3', color: '#30d158' }, // 緑
  { id: 'Obj4', name: 'Object 4', color: '#ffd60a' }, // 黄
  { id: 'Obj5', name: 'Object 5', color: '#bf5af2' }, // 紫
];

const makeDefaultObjects = (): TrackedObject[] =>
  OBJECT_DEFS.map((def, i) => ({
    ...def,
    active: i === 0, // 最初の1個だけアクティブ
    status: 'idle' as ObjectStatus,
    roi: null,
    center: null,
    initialRoi: null,
    initialTime: null,
  }));

/** 記録データを React state に反映する最小間隔 (ms)。
 *  毎フレーム setState すると DataPanel の再計算が追いつかず
 *  フレーム落ち＝軌跡のガタつきに繋がるため間引く。 */
const HISTORY_FLUSH_MS = 200;

// -------------------------------------------------
// App コンポーネント
// -------------------------------------------------

export const App: React.FC = () => {
  // ---- OpenCV ----
  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState<string | null>(null);
  const cvRef = useRef<any>(null);

  // ---- 追跡オブジェクト ----
  const [objects, setObjects] = useState<TrackedObject[]>(makeDefaultObjects);
  const [selectedObjId, setSelectedObjId] = useState<string>('Obj1');

  // ---- スケール校正 ----
  const [calibration, setCalibration] = useState<ScaleCalibration>({
    mode: 'plane',
    targetObjId: 'Obj1',
    realSizeValue: 10,
    unit: 'cm',
    linePoints: [],
    pxPerUnit: 0,
    planePoints: [],
    planeWidth: 29.7,   // A4 横置きの初期値
    planeHeight: 21,
    homography: null,
    yUp: true,
    origin: null,
  });

  // ---- 追跡設定 ----
  const [tracking, setTracking] = useState<TrackingSettings>(DEFAULT_TRACKING);

  // ---- フィルタ設定 ----
  const [filterSettings, setFilterSettings] = useState<FilterSettings>({
    enabled: true,
    kind: 'butterworth',
    autoCutoff: true,
    cutoffHz: 6,
    windowSize: 7,
    polynomialOrder: 2,
  });

  // ---- 再生・FPS ----
  const [isPlaying, setIsPlaying] = useState(false);
  // value（ファイルfps）は再生中に実フレーム間隔から自動計測して上書きされる。
  // captureFps はユーザー入力で、0 は「通常の動画」＝時間軸の換算なし。
  const [fpsSettings, setFpsSettings] = useState<FpsSettings>({
    value: 30,
    captureFps: 0,
  });

  // ---- 記録データ ----
  const [historyData, setHistoryData] = useState<FrameData[]>([]);

  /**
   * 解析区間（始点・終点、ファイル上の時刻 [s]）。
   *
   * 記録と解析の両方に効く。
   *   記録: 区間外のフレームは追跡も記録もしない。終点で自動停止する。
   *   解析: 記録済みデータのうち区間内だけをグラフ・フィルタ・CSV が使う。
   * どちらも同じ 1 つの値を見るので、「グラフに出ている範囲」と
   * 「CSV に出る範囲」が食い違うことがない。
   */
  const [timeRange, setTimeRange] = useState<TimeRange>(FULL_RANGE);

  // ---- ライン／平面校正モードフラグ（VideoCanvas ↔ ControlPanel で共有） ----
  const [isLineCalibrating, setIsLineCalibrating] = useState(false);

  // ---- 動画の解像度（校正の妥当性表示に使う） ----
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  /** 動画の長さ [s]。時間軸の換算が正しいかを秒数で確認するために使う */
  const [videoDuration, setVideoDuration] = useState(0);

  // ---- 操作に対するフィードバック（枠が小さすぎる等） ----
  const [notice, setNotice] = useState<string | null>(null);

  // ---- グラフ概形 ----
  // 軸の選択と非表示オブジェクトは App が持つ。DataPanel を畳んでも保たれる。
  const [graphX, setGraphX] = useState<AxisKey>('t');
  const [graphY, setGraphY] = useState<AxisKey>('x');
  const [hiddenGraphIds, setHiddenGraphIds] = useState<string[]>([]);
  // グラフ表示だけにかける平滑化。既定は OFF。
  // 既定を ON にすると、追跡が飛んだ箇所が均されて見えなくなり、
  // このモード本来の目的（計測が使い物になるかの判断）を損なうため。
  const [graphSmooth, setGraphSmooth] = useState(false);
  const [graphSmoothWindow, setGraphSmoothWindow] = useState(DEFAULT_SMOOTH_WINDOW);

  /** グラフのクリックから動画をシークさせるための指示。
   *  同じ時刻を続けてクリックしても効くよう、連番を添えて渡す。 */
  const [seekRequest, setSeekRequest] = useState<{ t: number; n: number } | null>(null);
  const seekSeqRef = useRef(0);

  // ----- Refs -----
  const trackersRef = useRef<{ [objId: string]: ObjectTracker }>({});
  const frameSourceRef = useRef<FrameSource | null>(null);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;
  const historyDataRef = useRef<FrameData[]>([]);
  const lastFlushRef = useRef(0);
  // handleProcessFrame は再生中に毎フレーム呼ばれる。区間を依存に入れて
  // 作り直すと rVFC の登録がやり直しになるので、ref 経由で読む。
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;

  const getFrameSource = useCallback((): FrameSource => {
    if (!frameSourceRef.current) frameSourceRef.current = new FrameSource();
    return frameSourceRef.current;
  }, []);

  // -------------------------------------------------
  // OpenCV 初期化
  // -------------------------------------------------

  useEffect(() => {
    waitForOpenCV().then(cv => {
      cvRef.current = cv;
      setCvReady(true);
    }).catch(err => {
      console.error('[App] OpenCV初期化失敗:', err);
      setCvError(String(err?.message || err));
    });
  }, []);

  // 追跡設定が変わったら全トラッカーへ反映
  useEffect(() => {
    Object.values(trackersRef.current).forEach(t => t.setConfig(tracking));
  }, [tracking]);

  // -------------------------------------------------
  // 記録データのフラッシュ
  // -------------------------------------------------

  const flushHistory = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastFlushRef.current < HISTORY_FLUSH_MS) return;
    lastFlushRef.current = now;
    setHistoryData(historyDataRef.current.slice());
  }, []);

  // 再生が止まったら必ず最新状態を反映する
  useEffect(() => {
    if (!isPlaying) flushHistory(true);
  }, [isPlaying, flushHistory]);

  // -------------------------------------------------
  // オブジェクト管理
  // -------------------------------------------------

  const handleAddObject = () => {
    const inactive = objects.find(o => !o.active);
    if (!inactive) return;
    setObjects(prev =>
      prev.map(o =>
        o.id === inactive.id
          ? {
              ...o, active: true, status: 'idle' as ObjectStatus,
              roi: null, center: null, initialRoi: null, initialTime: null,
            }
          : o
      )
    );
    setSelectedObjId(inactive.id);
  };

  const handleRemoveObject = (id: string) => {
    if (objects.filter(o => o.active).length <= 1) return;
    if (trackersRef.current[id]) {
      trackersRef.current[id].cleanup();
      delete trackersRef.current[id];
    }
    setObjects(prev =>
      prev.map(o =>
        o.id === id
          ? {
              ...o, active: false, status: 'idle' as ObjectStatus,
              roi: null, center: null, initialRoi: null, initialTime: null,
            }
          : o
      )
    );
    if (selectedObjId === id) {
      const remaining = objects.filter(o => o.active && o.id !== id);
      if (remaining.length > 0) setSelectedObjId(remaining[0].id);
    }
  };

  // -------------------------------------------------
  // ROI 更新（ドラッグ完了時）
  // -------------------------------------------------

  const handleUpdateRoi = useCallback(
    (objId: string, roi: Rect, videoEl?: HTMLVideoElement) => {
      let center: Point = { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 };

      // 小さすぎる枠は誤マッチの原因になるので、ここで止めて理由を伝える
      if (roi.width < MIN_ROI_SIZE || roi.height < MIN_ROI_SIZE) {
        setNotice(
          `追跡枠が小さすぎます（${Math.round(roi.width)}×${Math.round(roi.height)}px）。` +
          `${MIN_ROI_SIZE}px 以上、できれば ${RECOMMENDED_ROI_SIZE}px 前後で囲み直してください。` +
          `小さい枠は画面上のどこにでも一致してしまい、軌跡が暴走します。`
        );
        return;
      }

      if (cvRef.current && cvReady && videoEl) {
        const cv = cvRef.current;
        try {
          const src = getFrameSource();
          if (src.capture(videoEl)) {
            let tracker = trackersRef.current[objId];
            if (!tracker) {
              tracker = new ObjectTracker(cv, objId, trackingRef.current);
              trackersRef.current[objId] = tracker;
            } else {
              tracker.setConfig(trackingRef.current);
            }
            if (!tracker.init(src, roi)) {
              setNotice(`${objId} の追跡を開始できませんでした。枠を大きめに取り直してください。`);
              return;
            }
            // 重心補正後の中心を取り込む
            const probe = tracker.update(src);
            if (probe.state !== 'exited') center = probe.center;
            setNotice(null);
          }
        } catch (err) {
          console.error(`[App] ROI初期化失敗 (${objId}):`, err);
        }
      }

      setObjects(prev =>
        prev.map(o =>
          o.id === objId
            ? {
                ...o,
                roi,
                // 再指定したら exited / lost からは必ず復帰させる
                status: 'idle' as ObjectStatus,
                center,
                // 引いた瞬間の枠と時刻を初期位置として覚える。
                // 「やり直し」はここへ戻す（roi は追跡中に上書きされるため）。
                initialRoi: roi,
                initialTime: videoEl ? videoEl.currentTime : null,
              }
            : o
        )
      );

      // boxモードのスケール校正: 基準オブジェクトの枠幅から pxPerUnit を計算
      setCalibration(prevCalib => {
        if (
          prevCalib.mode === 'box' &&
          (prevCalib.targetObjId === objId || !prevCalib.targetObjId)
        ) {
          const pxPerUnit =
            roi.width > 0 && prevCalib.realSizeValue > 0
              ? roi.width / prevCalib.realSizeValue
              : prevCalib.pxPerUnit;
          return { ...prevCalib, targetObjId: objId, pxPerUnit };
        }
        return prevCalib;
      });
    },
    [cvReady, getFrameSource]
  );

  // -------------------------------------------------
  // 手動トラッキング
  // -------------------------------------------------
  //
  // 自動追跡が使えない対象（変形する物体、低コントラスト、遮蔽が多い）を
  // コマごとに人が指してデータにする。記録先は自動追跡と同じ historyData で、
  // 手で打った点には manual: true が付く。

  /** 取り消し用の履歴。手動で打った操作だけを積む */
  const manualUndoRef = useRef<ManualEdit[]>([]);

  /** 同じコマとみなす時刻の許容差 */
  const frameTolerance = useCallback(() => {
    const hist = historyDataRef.current;
    const dt = hist.length > 1 ? medianDt(hist.map(f => f.timestamp)) : 0;
    const base = dt > 0 ? dt : 1 / Math.max(1, fpsSettings.value);
    return base * 0.5;
  }, [fpsSettings.value]);

  /**
   * 手動で 1 点打つ。
   * @param fileTime 実際に表示されているフレームの時刻（要求時刻ではない）
   * @returns そのコマの対象を全部打ち終わったか（呼び出し側はここでコマを進める）
   *
   * 判定を呼び出し側ではなくここで行うのは、打った直後の状態を持っているのが
   * historyDataRef だけだから。props 経由の historyData は再描画まで古いままで、
   * 打つ順番を入れ替えられるようにすると「残り 1 つか」を事前に決められない。
   */
  const handleManualPlace = useCallback(
    (objId: string, center: Point, fileTime: number): boolean => {
      const real = toReal(
        calibrationRef.current, center, frameSourceRef.current?.height || 0
      );
      const edit = placeManualPoint(
        historyDataRef.current,
        objId,
        fileTime,
        center,
        real,
        frameTolerance(),
        Math.round(fileTime * Math.max(1, fpsSettings.value))
      );
      manualUndoRef.current.push(edit);
      flushHistory(true);

      // 画面上の印を追従させる（枠の大きさは既存のものを流用）
      setObjects(prev =>
        prev.map(o =>
          o.id === objId
            ? { ...o, center, status: 'tracking' as ObjectStatus }
            : o
        )
      );

      const order = objectsRef.current.filter(o => o.active).map(o => o.id);
      return isFrameComplete(
        historyDataRef.current, order, fileTime, frameTolerance()
      );
    },
    [flushHistory, frameTolerance, fpsSettings.value]
  );

  /** 直前に打った点を取り消す */
  const handleManualUndo = useCallback((): boolean => {
    const edit = manualUndoRef.current.pop();
    if (!edit) return false;
    const ok = undoManualPoint(historyDataRef.current, edit, frameTolerance());
    flushHistory(true);
    return ok;
  }, [flushHistory, frameTolerance]);

  // -------------------------------------------------
  // 手動修正（キーフレーム編集）
  // -------------------------------------------------

  /**
   * 一時停止中に、追跡点をドラッグして正しい位置へ直す。
   *   ・記録済みデータのうち、現在時刻に最も近いフレームの座標を書き換える
   *   ・その位置でトラッカーを作り直すので、続きから追跡し直せる
   * 自動追跡がまれに外れたときに、データを捨てずに救済するための機能。
   *
   * @returns 記録データを実際に書き換えられたか。
   *   false のときは枠だけが動いた状態なので、呼び出し側で知らせる必要がある。
   */
  const handleManualCorrect = useCallback(
    (objId: string, center: Point, timestamp: number, videoEl?: HTMLVideoElement): boolean => {
      const obj = objectsRef.current.find(o => o.id === objId);
      const size = obj?.roi
        ? { w: obj.roi.width, h: obj.roi.height }
        : { w: 30, h: 30 };
      const roi: Rect = {
        x: Math.round(center.x - size.w / 2),
        y: Math.round(center.y - size.h / 2),
        width: Math.round(size.w),
        height: Math.round(size.h),
      };

      // --- トラッカーを修正位置で作り直す ---
      if (cvRef.current && cvReady && videoEl) {
        try {
          const src = getFrameSource();
          if (src.capture(videoEl)) {
            const tracker = new ObjectTracker(cvRef.current, objId, trackingRef.current);
            if (tracker.init(src, roi)) {
              trackersRef.current[objId]?.cleanup();
              trackersRef.current[objId] = tracker;
            }
          }
        } catch (err) {
          console.error(`[App] 手動修正でのトラッカー再初期化に失敗 (${objId}):`, err);
        }
      }

      // --- 記録データの該当フレームを書き換える ---
      let applied = false;
      const hist = historyDataRef.current;
      if (hist.length > 0) {
        let bestIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < hist.length; i++) {
          const d = Math.abs(hist[i].timestamp - timestamp);
          if (d < bestDiff) {
            bestDiff = d;
            bestIdx = i;
          }
        }
        // 許容差は「実際に記録されている間隔」から出す。
        // 以前は 1/fpsSettings.value を使っていたが、これだと
        // スロー動画で撮影 fps（240 など）を手入力したときに
        // 許容差が実間隔よりずっと狭くなり、書き換えが黙って失敗していた。
        // （最近傍フレームまでの距離は最大で間隔の半分なので 0.75 倍で足りる）
        const recordedDt = medianDt(hist.map(f => f.timestamp));
        const tol =
          (recordedDt > 0 ? recordedDt : 1 / Math.max(1, fpsSettings.value)) * 0.75;
        if (bestDiff <= tol) {
          const fd = hist[bestIdx];
          const item = fd.objects[objId];
          const realPt = toReal(calibrationRef.current, center, frameSourceRef.current?.height || 0);
          if (item) {
            item.xPx = center.x;
            item.yPx = center.y;
            item.xM = realPt.x;
            item.yM = realPt.y;
            item.lost = false;
            item.manual = true;
          } else {
            fd.objects[objId] = {
              xPx: center.x, yPx: center.y,
              xM: realPt.x, yM: realPt.y,
              vx: 0, vy: 0, speedMs: 0, score: 1, lost: false, manual: true,
            };
          }
          flushHistory(true);
          applied = true;
        }
      }

      setObjects(prev =>
        prev.map(o =>
          o.id === objId
            ? { ...o, roi, center, status: 'tracking' as ObjectStatus }
            : o
        )
      );

      return applied;
    },
    [cvReady, getFrameSource, flushHistory, fpsSettings.value]
  );

  // -------------------------------------------------
  // Lost / Exited 物体の再指定
  // -------------------------------------------------

  const handleRecalibrateObject = (objId: string) => {
    setSelectedObjId(objId);
    setIsPlaying(false);
    if (trackersRef.current[objId]) {
      trackersRef.current[objId].cleanup();
      delete trackersRef.current[objId];
    }
    setObjects(prev =>
      prev.map(o => (o.id === objId ? { ...o, status: 'idle' as ObjectStatus } : o))
    );
  };

  // -------------------------------------------------
  // グラフ操作
  // -------------------------------------------------

  const handleSeek = useCallback((t: number) => {
    seekSeqRef.current += 1;
    setSeekRequest({ t, n: seekSeqRef.current });
  }, []);

  const toggleGraphId = useCallback((id: string) => {
    setHiddenGraphIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  // -------------------------------------------------
  // 解析区間
  // -------------------------------------------------

  const handleChangeTimeRange = useCallback((r: TimeRange) => {
    setTimeRange(normalizeRange(r));
  }, []);

  // -------------------------------------------------
  // データリセット
  // -------------------------------------------------

  const handleResetData = useCallback(() => {
    historyDataRef.current = [];
    lastFlushRef.current = 0;
    setHistoryData([]);
    Object.values(trackersRef.current).forEach(t => t.cleanup());
    trackersRef.current = {};
    setObjects(prev =>
      prev.map(o => ({
        ...o, status: 'idle' as ObjectStatus,
        roi: null, center: null, initialRoi: null, initialTime: null,
      }))
    );
  }, []);

  /**
   * やり直し — 軌跡を消して、枠を「戻る先のコマで物体がいた位置」へ戻す。
   *
   * roi は追跡中に毎フレーム上書きされるので、そのまま残すと
   * 物体が最後に到達した位置の枠が残る。巻き戻して再生すると
   * そこでテンプレートが作り直され、物体がいないので即座に破綻する。
   *
   * 戻す先の決め方
   *   1. restartAt（＝やり直しで戻る先の時刻）が渡されていて、消す前の軌跡に
   *      そのコマの点が残っていれば、枠の大きさは変えずにそこへ移す。
   *      区間の始点を後から動かした場合や、物体ごとに別のコマで枠を置いた
   *      場合、initialRoi へ戻すと枠だけが別の場所に取り残される。
   *      それが「やり直すたびに枠を置き直す」羽目になる原因だった。
   *   2. 軌跡がまだ無い（1 回目のやり直し）ときは initialRoi へ戻す。
   *      これで、同じ区間・同じ初期枠なら毎回同じ数値が出る性質は保たれる。
   *
   * 手動で打った点も消えるので、点があるときだけ確認する。
   * 手動記録は数十回のクリックの積み上げで、取り消しが高くつく。
   *
   * 実際に消したときだけ true を返す。呼び出し側（VideoCanvas）は
   * これを見てからシークするので、確認をキャンセルすると
   * 「データは残っているのに動画だけ始点へ飛んだ」状態にならない。
   */
  const handleClearTrail = useCallback((restartAt?: number | null): boolean => {
    const manualCount = countManualPoints(historyDataRef.current);
    if (manualCount > 0) {
      const ok = window.confirm(
        `手動で打った点が ${manualCount} 点あります。やり直すとこれも消えます。続けますか？`
      );
      if (!ok) return false;
    }
    // 枠を戻す位置は、消す前の軌跡から決める。
    // 戻る先のコマで物体がいた位置が分かるなら、枠は「最初に引いた場所」ではなく
    // そこへ戻す。そうしないと、区間の始点を後から動かしたときや、物体ごとに
    // 別のコマで枠を置いたときに、枠だけが別の場所に取り残される。
    const before = historyDataRef.current;
    const tol = frameTolerance() * 3;   // 1.5 コマ分
    const backTo = new Map<string, Point | null>();
    objectsRef.current.forEach(o => {
      backTo.set(
        o.id,
        restartAt != null ? trackedPointAt(before, o.id, restartAt, tol) : null
      );
    });

    historyDataRef.current = [];
    lastFlushRef.current = 0;
    setHistoryData([]);
    Object.values(trackersRef.current).forEach(t => t.cleanup());
    trackersRef.current = {};
    setObjects(prev => prev.map(o => {
      // 初期位置を覚えていない（手動記録だけで使った）場合は今の枠のまま
      const base = o.initialRoi ?? o.roi;
      if (!base) return o;
      const p = backTo.get(o.id) ?? null;
      // 戻る先のコマでの位置が分かるなら、枠の大きさは変えずにそこへ移す。
      // 初期位置も一緒に更新する。更新しないと、次のやり直しでまた
      // 「最初に引いた位置」へ跳ね返ってしまう。
      const roi: Rect = p
        ? {
            x: p.x - base.width / 2,
            y: p.y - base.height / 2,
            width: base.width,
            height: base.height,
          }
        : base;
      return {
        ...o,
        status: 'idle' as ObjectStatus,
        roi,
        center: null,
        ...(p && restartAt != null
          ? { initialRoi: roi, initialTime: restartAt }
          : {}),
      };
    }));
    return true;
  }, [frameTolerance]);

  // -------------------------------------------------
  // フレーム処理（VideoCanvas の requestVideoFrameCallback から呼ばれる）
  // -------------------------------------------------

  const handleProcessFrame = useCallback(
    (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => {
      if (!cvRef.current || !cvReady) return;
      // 区間外は追跡も記録もしない。トラッカーの生成もここで止まるので、
      // やり直したあとのテンプレートは「記録が始まる最初のコマの画」になる。
      if (!inRange(timeRangeRef.current, timestamp)) return;
      const cv = cvRef.current;
      const cfg = trackingRef.current;

      try {
        const src = getFrameSource();
        if (!src.capture(videoEl)) return;

        const currentHistory = historyDataRef.current;
        const prevFrame =
          currentHistory.length > 0 ? currentHistory[currentHistory.length - 1] : null;

        // シークで時刻が巻き戻った／同じフレームが再提示された場合は記録しない。
        // （dt <= 0 のまま速度を計算すると符号が反転してデータが壊れるため）
        if (prevFrame && timestamp <= prevFrame.timestamp) return;
        const currentCalibration = calibrationRef.current;
        const activeObjs = objectsRef.current.filter(o => o.active);

        const frameObjects: FrameData['objects'] = {};
        const updates: {
          id: string; status: ObjectStatus; roi?: Rect; center?: Point;
        }[] = [];

        activeObjs.forEach(obj => {
          if (!obj.roi) return;
          // ★ 画面外に出た物体はここで打ち切り。以後一切更新も記録もしない
          if (obj.status === 'exited') return;

          try {
            let tracker = trackersRef.current[obj.id];
            if (!tracker) {
              tracker = new ObjectTracker(cv, obj.id, cfg);
              if (!tracker.init(src, obj.roi)) return;
              trackersRef.current[obj.id] = tracker;
            }

            const res = tracker.update(src);

            if (res.state === 'exited') {
              updates.push({ id: obj.id, status: 'exited' });
              return; // このフレームの記録には含めない
            }

            // 画素座標 → 実寸座標。plane モードなら射影変換で遠近を補正する
            const real = toReal(currentCalibration, res.center, src.height);
            const xM = real.x;
            const yM = real.y;

            let vx = 0;
            let vy = 0;
            if (prevFrame) {
              const prevObj = prevFrame.objects[obj.id];
              if (prevObj && !prevObj.lost && res.state === 'ok') {
                const dt = timestamp - prevFrame.timestamp;
                if (dt > 1e-6) {
                  vx = (xM - prevObj.xM) / dt;
                  vy = (yM - prevObj.yM) / dt;
                } else {
                  vx = prevObj.vx;
                  vy = prevObj.vy;
                }
              }
            }

            frameObjects[obj.id] = {
              xPx: res.center.x,
              yPx: res.center.y,
              xM,
              yM,
              vx,
              vy,
              speedMs: Math.hypot(vx, vy),
              score: res.score,
              lost: res.state === 'lost',
            };

            updates.push({
              id: obj.id,
              status: res.state === 'lost' ? 'lost' : 'tracking',
              roi: res.roi,
              center: res.center,
            });
          } catch (objErr) {
            console.error(`[App] Tracker error on ${obj.id}:`, objErr);
          }
        });

        // 物体間の相対距離
        const distances: FrameData['distances'] = {};
        for (let i = 0; i < activeObjs.length; i++) {
          for (let j = i + 1; j < activeObjs.length; j++) {
            const idA = activeObjs[i].id;
            const idB = activeObjs[j].id;
            const a = frameObjects[idA];
            const b = frameObjects[idB];
            if (a && b && !a.lost && !b.lost) {
              distances[`${idA}-${idB}`] = Math.hypot(a.xM - b.xM, a.yM - b.yM);
            }
          }
        }

        // オブジェクト状態を一括更新
        if (updates.length > 0) {
          setObjects(prev => {
            let changed = false;
            const next = prev.map(o => {
              const u = updates.find(x => x.id === o.id);
              if (!u) return o;
              changed = true;
              return {
                ...o,
                status: u.status,
                ...(u.roi ? { roi: u.roi } : {}),
                ...(u.center ? { center: u.center } : {}),
              } as TrackedObject;
            });
            return changed ? next : prev;
          });
        }

        // 記録（追跡できた物体が1つでもある時だけ行を作る）
        if (Object.keys(frameObjects).length > 0) {
          historyDataRef.current.push({ frameIndex, timestamp, objects: frameObjects, distances });
          flushHistory();
        }
      } catch (err) {
        console.error('[App] フレーム処理エラー:', err);
      }
    },
    [cvReady, getFrameSource, flushHistory]
  );

  // -------------------------------------------------
  // レンダリング
  // -------------------------------------------------

  const activeCount = objects.filter(o => o.active).length;

  return (
    <div className="app-container">
      <Header
        isOpenCVReady={cvReady}
        cvError={cvError}
        activeCount={activeCount}
        totalDataCount={historyData.length}
        fpsSettings={fpsSettings}
      />
      {notice && (
        <div
          role="alert"
          style={{
            margin: '12px 20px 0 20px', padding: '11px 16px', borderRadius: '10px',
            background: 'rgba(239,68,68,0.12)', border: '1.5px solid rgba(239,68,68,0.45)',
            color: '#fca5a5', fontSize: '0.86rem', lineHeight: 1.6,
            display: 'flex', alignItems: 'flex-start', gap: '10px',
          }}
        >
          <span style={{ flex: 1 }}>{notice}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}
      <main className="main-layout">
        {/* 左ペイン：映像 + キャンバス */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <VideoCanvas
            objects={objects}
            selectedObjId={selectedObjId}
            onSelectObjId={setSelectedObjId}
            onUpdateRoi={handleUpdateRoi}
            onVideoDuration={setVideoDuration}
            onManualCorrect={handleManualCorrect}
            onManualPlace={handleManualPlace}
            onManualUndo={handleManualUndo}
            calibration={calibration}
            onUpdateCalibration={setCalibration}
            onProcessFrame={handleProcessFrame}
            historyData={historyData}
            onResetData={handleResetData}
            onClearTrail={handleClearTrail}
            onFlushHistory={() => flushHistory(true)}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            fpsSettings={fpsSettings}
            setFpsSettings={setFpsSettings}
            isLineCalibrating={isLineCalibrating}
            setIsLineCalibrating={setIsLineCalibrating}
            onVideoSize={setVideoSize}
            seekRequest={seekRequest}
            timeRange={timeRange}
            onChangeTimeRange={handleChangeTimeRange}
          />
        </section>

        {/* 右ペイン：コントロール + データ */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <ControlPanel
            objects={objects}
            selectedObjId={selectedObjId}
            onSelectObjId={setSelectedObjId}
            onAddObject={handleAddObject}
            onRemoveObject={handleRemoveObject}
            onRecalibrateObject={handleRecalibrateObject}
            calibration={calibration}
            onUpdateCalibration={setCalibration}
            tracking={tracking}
            onUpdateTracking={setTracking}
            fpsSettings={fpsSettings}
            onUpdateFpsSettings={setFpsSettings}
            isLineCalibrating={isLineCalibrating}
            setIsLineCalibrating={setIsLineCalibrating}
            videoWidth={videoSize.width}
            videoHeight={videoSize.height}
            videoDuration={videoDuration}
          />
          <DataPanel
            objects={objects}
            historyData={historyData}
            timeRange={timeRange}
            filterSettings={filterSettings}
            onUpdateFilterSettings={setFilterSettings}
            calibration={calibration}
            fpsSettings={fpsSettings}
            graphX={graphX}
            graphY={graphY}
            onChangeGraphX={setGraphX}
            onChangeGraphY={setGraphY}
            hiddenGraphIds={hiddenGraphIds}
            onToggleGraphId={toggleGraphId}
            onSeek={handleSeek}
            graphSmooth={graphSmooth}
            graphSmoothWindow={graphSmoothWindow}
            onChangeGraphSmooth={setGraphSmooth}
            onChangeGraphSmoothWindow={setGraphSmoothWindow}
          />
        </aside>
      </main>
    </div>
  );
};

export default App;
