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

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  TrackedObject, ScaleCalibration, Rect, Point, FrameData, FpsSettings
} from '../types';
import { recalcScale, pixelDistance } from '../utils/calibration';
import { applyHomography, invertHomography, Matrix3 } from '../utils/homography';
import { MIN_ROI_SIZE, RECOMMENDED_ROI_SIZE } from '../utils/tracker';
import {
  Play, Pause, RotateCcw, Upload, Crosshair, ZoomIn, ZoomOut,
  Eraser, ChevronLeft, ChevronRight, Gauge, Hand
} from 'lucide-react';

interface VideoCanvasProps {
  objects: TrackedObject[];
  selectedObjId: string;
  onSelectObjId: (id: string) => void;
  onUpdateRoi: (id: string, roi: Rect, videoEl?: HTMLVideoElement) => void;
  onManualCorrect: (id: string, center: Point, timestamp: number, videoEl?: HTMLVideoElement) => void;
  calibration: ScaleCalibration;
  onUpdateCalibration: (calib: ScaleCalibration) => void;
  onProcessFrame: (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => void;
  historyData: FrameData[];
  onResetData: () => void;
  onClearTrail: () => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  fpsSettings: FpsSettings;
  setFpsSettings: (fps: FpsSettings) => void;
  isLineCalibrating: boolean;
  setIsLineCalibrating: (v: boolean) => void;
  onVideoSize?: (s: { width: number; height: number }) => void;
  /** グラフのクリックから届くシーク指示。n は連番（同じ時刻の再指示を拾うため） */
  seekRequest?: { t: number; n: number } | null;
}

/** 軌跡として表示する最大ポイント数（描画負荷の上限） */
const MAX_TRAIL_POINTS = 2000;
/** 校正点を掴める距離（canvas ピクセル） */
const HANDLE_RADIUS = 14;

type DragMode =
  | null
  | 'roi'
  | 'calib-new' | 'calib-p1' | 'calib-p2'
  | 'plane-corner'
  | 'manual';

const PLAYBACK_RATES = [0.25, 0.5, 1];

export const VideoCanvas: React.FC<VideoCanvasProps> = ({
  objects, selectedObjId, onUpdateRoi, onManualCorrect,
  calibration, onUpdateCalibration, onProcessFrame,
  historyData, onResetData, onClearTrail, isPlaying, setIsPlaying,
  fpsSettings, setFpsSettings,
  isLineCalibrating, setIsLineCalibrating, onVideoSize, seekRequest,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
  const [manualObjId, setManualObjId] = useState<string | null>(null);
  /** 手動修正モード（ON のときだけ点をドラッグして直せる） */
  const [correctMode, setCorrectMode] = useState(false);

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
    });
    setIsLineCalibrating(false);
    setCorrectMode(false);
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

  const handleSeeked = () => {
    const v = videoRef.current;
    if (v) setCurrentTime(v.currentTime);
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

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!videoLoaded) return;
    const pt = getCanvasCoordinates(e);

    // ---------- 平面校正 ----------
    if (calibration.mode === 'plane') {
      const quad = calibration.planePoints;
      // 既存の頂点を掴む
      if (!isLineCalibrating && quad.length === 4) {
        for (let i = 0; i < 4; i++) {
          if (pixelDistance(pt, quad[i]) <= HANDLE_RADIUS) {
            setDragMode('plane-corner');
            setDragIndex(i);
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
        setDragCurrent(pt);
        return;
      }
      if (pixelDistance(pt, pts[1]) <= HANDLE_RADIUS) {
        setDragMode('calib-p2');
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
      let hitId: string | null = null;
      let bestD = HANDLE_RADIUS * 1.6;
      objects.forEach(o => {
        if (!o.active || !o.center || o.status === 'exited') return;
        const d = pixelDistance(pt, o.center);
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
    }

    // ---------- 通常ドラッグ（ROI指定） ----------
    setDragMode('roi');
    setDragStart(pt);
    setDragCurrent(pt);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
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

    if (dragMode === 'manual' && dragCurrent && manualObjId) {
      const v = videoRef.current;
      onManualCorrect(manualObjId, dragCurrent, v ? v.currentTime : 0, v || undefined);
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
      }
    }

    setDragMode(null);
    setDragStart(null);
    setDragCurrent(null);
    setDragIndex(-1);
  }, [
    dragMode, dragStart, dragCurrent, isSquareMode, selectedObjId,
    onUpdateRoi, applyLine, setIsLineCalibrating, manualObjId, onManualCorrect,
  ]);

  // 校正線の矢印キーによる微調整
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isLineCalibrating) {
        setIsLineCalibrating(false);
        setDragMode(null);
        return;
      }
      if (calibration.mode !== 'line' || calibration.linePoints.length !== 2) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();
      // Shift で 2点目、それ以外は1点目を動かす
      const idx = e.shiftKey ? 1 : 0;
      const pts = calibration.linePoints.map((p, i) =>
        i === idx ? { x: p.x + d[0], y: p.y + d[1] } : p
      );
      onUpdateCalibration(recalcScale({ ...calibration, linePoints: pts }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [calibration, onUpdateCalibration, isLineCalibrating, setIsLineCalibrating]);

  // -------------------------------------------------
  // Canvas 描画
  // -------------------------------------------------

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
          if (item && !item.lost) {
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

        // 現在位置マーカー
        const last = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = obj.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();

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
      if (isSelected) {
        ctx.shadowColor = boxColor;
        ctx.shadowBlur = 8 * k;
      }
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = (isSelected ? 2.5 : 1.5) * k;
      ctx.setLineDash(isLost ? [6 * k, 4 * k] : []);
      ctx.strokeRect(x, y, width, height);
      ctx.restore();

      // ラベル
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

      // サブピクセル中心の十字
      const c = obj.center || { x: x + width / 2, y: y + height / 2 };
      ctx.beginPath();
      ctx.moveTo(c.x - 7 * k, c.y); ctx.lineTo(c.x + 7 * k, c.y);
      ctx.moveTo(c.x, c.y - 7 * k); ctx.lineTo(c.x, c.y + 7 * k);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
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
      const dist = pixelDistance(p1, p2);
      ctx.save();
      // 影
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 5 * k;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.strokeStyle = live ? '#fbbf24' : '#f59e0b';
      ctx.lineWidth = 2.5 * k;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();

      // 端点ハンドル
      [p1, p2].forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7 * k, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#f59e0b' : '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * k;
        ctx.stroke();
      });

      // ラベル
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const label = `${dist.toFixed(1)} px = ${calibration.realSizeValue} ${calibration.unit}`;
      ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(midX - tw / 2 - 8 * k, midY - 28 * k, tw + 16 * k, 22 * k);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(label, midX - tw / 2, midY - 12 * k);
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
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8 * k, 0, Math.PI * 2);
        ctx.fillStyle = done ? '#10d97c' : '#f59e0b';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * k;
        ctx.stroke();
        ctx.fillStyle = '#06101f';
        ctx.font = `bold ${11 * k}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5 * k);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // 未確定のときは次にどこを押すかを示す
        if (quad.length < 4) {
          ctx.fillStyle = '#fbbf24';
          ctx.font = `${11 * k}px Inter, sans-serif`;
          ctx.fillText(cornerNames[i], p.x + 12 * k, p.y - 10 * k);
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

    // ----- 手動修正モードのハンドル -----
    if (correctMode && !isPlaying) {
      objects.forEach(o => {
        if (!o.active || !o.center || o.status === 'exited') return;
        const beingDragged = dragMode === 'manual' && manualObjId === o.id;
        const c = beingDragged && dragCurrent ? dragCurrent : o.center;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 13 * k, 0, Math.PI * 2);
        ctx.strokeStyle = beingDragged ? '#ffffff' : o.color;
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
  }, [
    historyData, objects, selectedObjId, showTrail,
    dragMode, dragStart, dragCurrent, isSquareMode, calibration,
    correctMode, isPlaying, manualObjId,
  ]);

  renderRef.current = renderFrame;

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
      // FPS 自動計測（実フレーム間隔の中央値）
      const prev = lastMediaTimeRef.current;
      if (prev !== null) {
        const dt = mediaTime - prev;
        if (dt > 0.0005 && dt < 1) {
          const arr = frameIntervalsRef.current;
          arr.push(dt);
          if (arr.length > 60) arr.shift();
          if (arr.length >= 10) {
            const sorted = [...arr].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const fps = Math.round((1 / median) * 1000) / 1000;
            // 手動指定されている場合は上書きしない
            if (
              fps > 1 && fps < 1000 &&
              fpsRef.current.source !== 'manual' &&
              Math.abs(fps - fpsRef.current.value) > 0.05
            ) {
              setFpsRef.current({ value: fps, source: 'auto' });
            }
          }
        }
      }
      lastMediaTimeRef.current = mediaTime;

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

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    if (isPlaying) {
      v.pause();
      setIsPlaying(false);
    } else {
      v.playbackRate = playbackRate;
      v.play().then(() => setIsPlaying(true)).catch(err => {
        console.error('[VideoCanvas] 再生できませんでした:', err);
      });
    }
  };

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const handleReset = () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
      setCurrentTime(0);
    }
    setIsPlaying(false);
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
    onClearTrail();
  };

  // グラフをクリックされたら、その時刻へ移動して止める。
  // 再生したままだとすぐ通り過ぎてしまい、修正できない。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seekRequest || !videoLoaded) return;
    v.pause();
    setIsPlaying(false);
    v.currentTime = Math.max(0, Math.min(v.duration || 0, seekRequest.t));
    setCurrentTime(seekRequest.t);
    // seekRequest 以外を依存に入れると、再生のたびに巻き戻ってしまう
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  /** 1フレーム分だけ進む／戻る（停止中の精密確認用） */
  const stepFrame = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    v.pause();
    setIsPlaying(false);
    const dt = 1 / (fpsSettings.value > 0 ? fpsSettings.value : 30);
    const t = Math.max(0, Math.min(v.duration || 0, v.currentTime + dir * dt));
    v.currentTime = t;
  };

  // -------------------------------------------------
  // カーソル
  // -------------------------------------------------

  const cursorStyle =
    isLineCalibrating || dragMode === 'calib-new' ? 'crosshair'
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
          onMouseLeave={finishDrag}
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

        {correctMode && !isPlaying && !isLineCalibrating && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(99,102,241,0.95)', color: '#fff', padding: '7px 16px',
            borderRadius: 20, fontSize: '0.82rem', fontWeight: 700, pointerEvents: 'none',
            whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}>
            ✋ 修正モード — ずれた点をドラッグして正しい位置へ
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
      </div>

      {/* ---- コントロールバー ---- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={togglePlay} disabled={!videoLoaded}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? '一時停止' : '再生 & 追跡'}
          </button>

          <button className="btn btn-secondary btn-sm" onClick={() => stepFrame(-1)} disabled={!videoLoaded} title="1フレーム戻る">
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => stepFrame(1)} disabled={!videoLoaded} title="1フレーム進む">
            <ChevronRight size={15} />
          </button>

          <button
            className={`btn btn-sm ${correctMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setCorrectMode(v => !v); setIsLineCalibrating(false); }}
            disabled={!videoLoaded}
            title="一時停止中に、ずれた追跡点をドラッグして手で直します">
            <Hand size={14} />
            修正
          </button>

          <button className="btn btn-secondary" onClick={handleReset} disabled={!videoLoaded} title="先頭に戻して軌跡を消去（枠は保持）">
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
            <button key={r}
              className={`btn btn-sm ${playbackRate === r ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '0.72rem', padding: '3px 8px' }}
              onClick={() => setPlaybackRate(r)}
              title="遅くすると取りこぼしが減り精度が上がります">
              {r}×
            </button>
          ))}
        </div>
      </div>

      {/* シークバー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
          style={{ flex: 1 }}
        />
        <span className="mono" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
          {currentTime.toFixed(3)} / {duration.toFixed(2)} s
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
          {' '}— 白シールを囲むようにドラッグして追跡枠を指定。
          <b>枠は {RECOMMENDED_ROI_SIZE}px 以上</b>（シールの周りの模様が少し入るくらい）にしてください。
          小さすぎる枠は画面のどこにでも一致してしまい、軌跡が暴走します。
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
