// src/components/AnalysisPanel.tsx
// ============================================================
// 解析 — 当てはめて数値を出すパネル。
//
// 作り直しの理由
//   最初の版は、残差と R² と RMSE から出していた。これは「当てはめが
//   済んだあとに疑うための道具」であって、**何をしたのかを示すものでは
//   ない**。まず見せるべきなのは「データの上に線が引けている」という絵と、
//   「加速度はいくつか」という答えの 2 つ。診断はそのあとに畳んで置く。
//
// 変わらない芯は 3 つ。
//   ・当てはめるのは**生データ**（平滑化すると不確かさが過小評価される）
//   ・傾きには**標準誤差を必ず添える**
//   ・残差を見られるようにする（構造が残っていたらモデルが違う）
// ============================================================

import React, { useMemo, useRef, useState } from 'react';
import {
  TrackedObject, FrameData, FpsSettings, ScaleCalibration,
} from '../types';
import {
  fitSeries, rawSeries, pickQuantity, accelerationOf, velocityOf,
  secondDiffStats, secondDiffSeries, meanSd, insideBox, recommendK, medianStep,
  FitModel, FitQuantity, FitResult, FitBox, G_STANDARD,
} from '../utils/fit';
import { ticksFor, fmtTick } from '../utils/plotScale';
import { timeScale } from '../utils/timeScale';
import { checkTrack } from '../utils/frameCheck';
import { outputUnit } from '../utils/calibration';
import { TimeRange } from '../utils/timeRange';
import { Sigma, Activity } from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  historyData: FrameData[];
  timeRange: TimeRange;
  fpsSettings: FpsSettings;
  calibration: ScaleCalibration;
  /** 残差の外れ点から動画へ飛ぶ */
  onSeek?: (t: number) => void;
}

const QUANTITIES: { key: FitQuantity; label: string; note: string }[] = [
  { key: 'x', label: 'x-t', note: '横の位置' },
  { key: 'y', label: 'y-t', note: '縦の位置' },
  { key: 'vx', label: 'vx-t', note: '横の速度' },
  { key: 'vy', label: 'vy-t', note: '縦の速度' },
];

/** 点の色。対象の色は赤のこともあるので、外れ点の色とぶつけない */
const DOT = '#60a5fa';
const OUTLIER = '#f59e0b';
const LINE = '#ffffff';

const fmt = (v: number, d = 4): string => {
  if (!isFinite(v)) return '---';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(d);
};

// ------------------------------------------------------------
// データと当てはめた線
// ------------------------------------------------------------
//
// これが無かったのが、前の版でいちばん伝わらなかった原因。
// 残差だけ見せても「何に何を当てはめたのか」が分からない。

const FitPlot: React.FC<{
  /** 全部の点。軸の範囲はこちらで決める（選択を変えても軸が動かないように） */
  all: { t: number; y: number }[];
  /** 当てはめに使っている点 */
  used: { t: number; y: number }[];
  fit: FitResult;
  yLabel: string;
  box: FitBox | null;
  onBox: (b: FitBox | null) => void;
}> = ({ all, used, fit, yLabel, box, onBox }) => {
  const W = 560;
  const H = 240;
  const pad = { l: 60, r: 12, t: 12, b: 28 };
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ a: FitBox; b: FitBox } | null>(null);

  const tMin = Math.min(...all.map(p => p.t));
  const tMax = Math.max(...all.map(p => p.t));
  const ysAll = [...all.map(p => p.y), fit.evalAt(tMin), fit.evalAt(tMax)];
  let yMin = Math.min(...ysAll);
  let yMax = Math.max(...ysAll);
  const span = yMax - yMin || 1;
  yMin -= span * 0.08;
  yMax += span * 0.08;

  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (y: number) =>
    H - pad.b - ((y - yMin) / Math.max(1e-12, yMax - yMin)) * (H - pad.t - pad.b);
  const tAt = (vx: number) =>
    tMin + ((vx - pad.l) / Math.max(1, W - pad.l - pad.r)) * (tMax - tMin);
  const yAt = (vy: number) =>
    yMin + ((H - pad.b - vy) / Math.max(1, H - pad.t - pad.b)) * (yMax - yMin);

  /** 画面の座標 → データの座標 */
  const toData = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vx = ((clientX - r.left) / Math.max(1, r.width)) * W;
    const vy = ((clientY - r.top) / Math.max(1, r.height)) * H;
    return { t: tAt(vx), y: yAt(vy) };
  };

  const usedSet = useMemo(() => new Set(used.map(p => p.t)), [used]);

  const xTicks = ticksFor(tMin, tMax, 6);
  const yTicks = ticksFor(yMin, yMax, 5);
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1;
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;

  // 当てはめた線は、使った点の範囲だけに引く。
  // 外まで伸ばすと、選んでいない区間まで当てはめたように見える。
  const uT0 = used.length > 0 ? Math.min(...used.map(p => p.t)) : tMin;
  const uT1 = used.length > 0 ? Math.max(...used.map(p => p.t)) : tMax;
  const curve: string = Array.from({ length: 81 }, (_, i) => {
    const t = uT0 + ((uT1 - uT0) * i) / 80;
    return `${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(fit.evalAt(t)).toFixed(1)}`;
  }).join(' ');

  const live = drag
    ? {
        t0: Math.min(drag.a.t0, drag.b.t0), t1: Math.max(drag.a.t0, drag.b.t0),
        y0: Math.min(drag.a.y0, drag.b.y0), y1: Math.max(drag.a.y0, drag.b.y0),
      }
    : box;

  return (
    <svg
      ref={svgRef}
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={e => {
        const d = toData(e.clientX, e.clientY);
        if (!d) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const one: FitBox = { t0: d.t, t1: d.t, y0: d.y, y1: d.y };
        setDrag({ a: one, b: one });
      }}
      onPointerMove={e => {
        if (!drag) return;
        const d = toData(e.clientX, e.clientY);
        if (!d) return;
        setDrag(p0 => (p0 ? { a: p0.a, b: { t0: d.t, t1: d.t, y0: d.y, y1: d.y } } : null));
      }}
      onPointerUp={() => {
        if (!drag) return;
        const b: FitBox = {
          t0: Math.min(drag.a.t0, drag.b.t0), t1: Math.max(drag.a.t0, drag.b.t0),
          y0: Math.min(drag.a.y0, drag.b.y0), y1: Math.max(drag.a.y0, drag.b.y0),
        };
        setDrag(null);
        // ただのクリックのような極小の矩形は、選択ではなく解除とみなす
        const tiny = (b.t1 - b.t0) < (tMax - tMin) * 0.02;
        onBox(tiny ? null : b);
      }}
    >
      {yTicks.map(v => (
        <g key={`y${v}`}>
          <line x1={pad.l} y1={py(v)} x2={W - pad.r} y2={py(v)}
            stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
          <text x={pad.l - 6} y={py(v) + 3.5} fill="var(--text-muted)" fontSize={10}
            textAnchor="end">{fmtTick(v, yStep)}</text>
        </g>
      ))}
      {xTicks.map(v => (
        <g key={`x${v}`}>
          <line x1={px(v)} y1={pad.t} x2={px(v)} y2={H - pad.b}
            stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
          <text x={px(v)} y={H - pad.b + 15} fill="var(--text-muted)" fontSize={10}
            textAnchor="middle">{fmtTick(v, xStep)}</text>
        </g>
      ))}

      {live && (
        <rect
          x={Math.min(px(live.t0), px(live.t1))}
          y={Math.min(py(live.y0), py(live.y1))}
          width={Math.abs(px(live.t1) - px(live.t0))}
          height={Math.abs(py(live.y1) - py(live.y0))}
          fill="rgba(99,102,241,0.14)"
          stroke="rgba(129,140,248,0.9)" strokeWidth={1.2}
        />
      )}

      {all.map((p, i) => {
        const on = usedSet.has(p.t);
        return (
          <circle key={i} cx={px(p.t)} cy={py(p.y)} r={on ? 2.8 : 2.2}
            fill={on ? DOT : 'rgba(148,163,184,0.45)'} />
        );
      })}
      <path d={curve} fill="none" stroke={LINE} strokeWidth={1.8} opacity={0.95} />
      <text x={pad.l} y={H - 3} fill="var(--text-muted)" fontSize={10}>t (s)</text>
      <text x={3} y={pad.t + 2} fill="var(--text-muted)" fontSize={10}>{yLabel}</text>
    </svg>
  );
};

/**
 * a-t 図。2 階差分で出した加速度の時間変化。
 *
 * Δt を選ばずに出した a-t 図は意味がない。合成データでは、240fps の
 * 隣り合うコマ（k=1）で出すと標準偏差が 80 m/s² になり、真値 9.8 が
 * ノイズに埋もれる。同じデータでも k=8 なら 1.1 に収まる。
 * だから Δt の選択と、ばらつきの帯を必ず一緒に出す。
 */
const AtPlot: React.FC<{
  data: { t: number; a: number }[];
  mean: number;
  sd: number;
  unit: string;
}> = ({ data, mean, sd, unit }) => {
  const W = 560;
  const H = 180;
  const pad = { l: 60, r: 12, t: 10, b: 24 };
  if (data.length < 2) return null;
  const tMin = Math.min(...data.map(p => p.t));
  const tMax = Math.max(...data.map(p => p.t));
  const half = Math.max(sd * 3, Math.abs(mean) * 0.15, 1e-9);
  const yMin = mean - half;
  const yMax = mean + half;
  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (a: number) =>
    H - pad.b - ((a - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const yTicks = ticksFor(yMin, yMax, 4);
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
  const clamp = (v: number) => Math.min(H - pad.b, Math.max(pad.t, py(v)));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <rect x={pad.l} y={clamp(mean + sd)} width={W - pad.l - pad.r}
        height={Math.max(1, clamp(mean - sd) - clamp(mean + sd))}
        fill="rgba(96,165,250,0.16)" />
      {yTicks.map(v => (
        <g key={v}>
          <line x1={pad.l} y1={py(v)} x2={W - pad.r} y2={py(v)}
            stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
          <text x={pad.l - 6} y={py(v) + 3.5} fill="var(--text-muted)" fontSize={10}
            textAnchor="end">{fmtTick(v, yStep)}</text>
        </g>
      ))}
      <line x1={pad.l} y1={py(mean)} x2={W - pad.r} y2={py(mean)}
        stroke={LINE} strokeWidth={1.6} opacity={0.9} />
      {data.map((p, i) => (
        <circle key={i} cx={px(p.t)} cy={clamp(p.a)} r={2.6} fill={DOT}
          opacity={p.a > yMax || p.a < yMin ? 0.35 : 0.9} />
      ))}
      <text x={3} y={pad.t + 2} fill="var(--text-muted)" fontSize={10}>a ({unit})</text>
      <text x={pad.l} y={H - 3} fill="var(--text-muted)" fontSize={10}>t (s)</text>
      <text x={W - pad.r} y={H - 3} fill="var(--text-muted)" fontSize={10}
        textAnchor="end">白線 = 平均 / 帯 = ±SD</text>
    </svg>
  );
};

/** 残差。構造（曲がり・うねり）が見えたらモデルが違う */
const ResidualPlot: React.FC<{
  residuals: { t: number; r: number }[];
  rmse: number;
  scale: number;
  unit: string;
  onSeek?: (t: number) => void;
}> = ({ residuals, rmse, scale, unit, onSeek }) => {
  const W = 560;
  const H = 140;
  const pad = { l: 60, r: 12, t: 10, b: 22 };
  const ts = residuals.map(p => p.t);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const rAbs = Math.max(...residuals.map(p => Math.abs(p.r)), 1e-12);
  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (r: number) =>
    pad.t + (0.5 - (r / (rAbs * 1.15)) * 0.5) * (H - pad.t - pad.b);
  const yTicks = ticksFor(-rAbs, rAbs, 3);
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <rect x={pad.l} y={py(rmse)} width={W - pad.l - pad.r}
        height={Math.max(1, py(-rmse) - py(rmse))} fill="rgba(96,165,250,0.16)" />
      {yTicks.map(v => (
        <text key={v} x={pad.l - 6} y={py(v) + 3.5} fill="var(--text-muted)"
          fontSize={10} textAnchor="end">{fmtTick(v, yStep)}</text>
      ))}
      <line x1={pad.l} y1={py(0)} x2={W - pad.r} y2={py(0)}
        stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
      {residuals.map((p, i) => {
        const out = Math.abs(p.r) > 2.5 * rmse;
        return (
          <circle key={i} cx={px(p.t)} cy={py(p.r)} r={out ? 4.2 : 2.8}
            fill={out ? OUTLIER : DOT}
            style={{ cursor: onSeek ? 'pointer' : 'default' }}
            onClick={() => onSeek?.(scale > 0 ? p.t / scale : p.t)} />
        );
      })}
      <text x={3} y={pad.t + 2} fill="var(--text-muted)" fontSize={10}>{unit}</text>
      <text x={W - pad.r} y={H - 4} fill="var(--text-muted)" fontSize={10}
        textAnchor="end">帯 = ±RMSE</text>
    </svg>
  );
};

export const AnalysisPanel: React.FC<Props> = ({
  objects, historyData, timeRange, fpsSettings, calibration, onSeek,
}) => {
  const active = useMemo(() => objects.filter(o => o.active), [objects]);
  const [objId, setObjId] = useState<string>(active[0]?.id ?? 'Obj1');
  const [quantity, setQuantity] = useState<FitQuantity>('vy');
  const [model, setModel] = useState<FitModel>('linear');
  const [showResid, setShowResid] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  /**
   * コマの点検で「飛んでいる」と出たコマを外すか。既定は外す。
   *
   * 残差が RMSE の 3 倍まで伸びる原因はたいていこれで、入れたままだと
   * 傾きも標準誤差も壊れる。ただし黙っては外さない。外した数を出して、
   * 戻せるようにしてある。
   */
  const [dropIssues, setDropIssues] = useState(true);
  /** 矩形で選んだ範囲。null なら全部 */
  const [box, setBox] = useState<FitBox | null>(null);
  /** a-t の Δt（何コマ分か）。null なら自動 */
  const [atK, setAtK] = useState<number | null>(null);
  const [showAt, setShowAt] = useState(false);

  /**
   * 表示に使う単位。
   *
   * 記録されている座標は**常にメートル**（未校正なら px）。
   * calibration.unit は「基準の長さを何で入力したか」でしかなく、
   * これを表示に使うと、中身が m なのに cm と書く、という嘘になる。
   * 実際そうなっていて、加速度が 100 倍ずれて読める状態だった。
   */
  const unit = outputUnit(calibration);
  const calibrated = unit === 'm';
  const scale = timeScale(fpsSettings);
  const target = active.find(o => o.id === objId) ?? active[0];

  /** コマの点検。飛んでいるコマの時刻を当てはめから外すのに使う */
  const quality = useMemo(
    () => checkTrack(
      historyData, target?.id ?? objId,
      target?.initialRoi?.width ?? target?.roi?.width ?? 0
    ),
    [historyData, target?.id, target?.initialRoi?.width, target?.roi?.width, objId]
  );
  const excludeTimes = useMemo(
    () => (dropIssues ? new Set(quality.issueTimes) : undefined),
    [dropIssues, quality]
  );

  const series = useMemo(
    () => rawSeries(historyData, target?.id ?? objId, scale, timeRange, excludeTimes),
    [historyData, target?.id, objId, scale, timeRange, excludeTimes]
  );
  const values = pickQuantity(series, quantity);
  /** 区間内の全部の点（軸の範囲と「選ばなかった点」の表示に使う） */
  const allPts = useMemo(
    () => series.t.map((t, i) => ({ t, y: values[i] })),
    [series.t, values]
  );
  /** 矩形で絞ったあとの、当てはめに使う点 */
  const pts = useMemo(() => insideBox(allPts, box), [allPts, box]);
  const fit = useMemo(() => fitSeries(pts, model), [pts, model]);

  // 量やモデルを変えたら、縦軸の意味が変わるので選択は外す。
  // 残したままだと、別の量の値域で切った矩形がそのまま効いてしまう。
  const lastQ = useRef<string>('');
  const qKey = `${target?.id ?? ''}|${quantity}`;
  if (lastQ.current !== qKey) {
    lastQ.current = qKey;
    if (box) setBox(null);
  }

  // ---- a-t ----
  // 位置の 2 階差分で出す。速度を選んでいるときは、その軸の位置を使う。
  const atSource = quantity === 'vx' || quantity === 'x' ? series.x : series.y;
  const atRange = useMemo(() => {
    if (!box) return { t: series.t, y: atSource };
    const t: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < series.t.length; i++) {
      if (series.t[i] >= box.t0 && series.t[i] <= box.t1) {
        t.push(series.t[i]);
        y.push(atSource[i]);
      }
    }
    return { t, y };
  }, [series.t, atSource, box]);
  const atDt = useMemo(() => medianStep(atRange.t), [atRange.t]);
  const atKUsed = atK ?? recommendK(atDt);
  const atData = useMemo(
    () => secondDiffSeries(atRange.t, atRange.y, atKUsed),
    [atRange, atKUsed]
  );
  const atStat = useMemo(() => meanSd(atData.map(d => d.a)), [atData]);

  const sdStats = useMemo(() => secondDiffStats(atRange.t, atRange.y), [atRange]);

  const accel = fit ? accelerationOf(quantity, fit) : null;
  const vel = fit ? velocityOf(quantity, fit) : null;
  const isVel = quantity === 'vx' || quantity === 'vy';
  /** その量そのものの単位（cm や cm/s） */
  const qUnit = isVel ? `${unit}/s` : unit;
  /** 加速度の単位は、何に当てはめたかに関係なく常にこれ */
  const aUnit = `${unit}/s²`;
  const qNote = QUANTITIES.find(q => q.key === quantity)?.note ?? '';

  /**
   * g の何倍か。値はすでに m/s² なので、そのまま割る。
   * 校正していなければ px/s² なので比べない。
   */
  const gRatio = accel && calibrated
    ? Math.abs(accel.value) / G_STANDARD
    : null;

  const chip = (on: boolean) => `chip ${on ? 'is-active' : ''}`;
  const sub = { fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 };

  return (
    <div className="glass-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sigma size={17} color="var(--accent-primary)" />
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>解析（当てはめ）</h3>
      </div>

      {/* ---- 何を当てはめるか ---- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {active.length > 1 && (
          <div style={{ display: 'flex', gap: 4 }}>
            {active.map(o => (
              <button key={o.id} className={chip(o.id === objId)}
                onClick={() => setObjId(o.id)}
                style={{ borderColor: o.id === objId ? o.color : undefined }}>
                {o.id}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {QUANTITIES.map(q => (
            <button key={q.key} className={chip(q.key === quantity)}
              onClick={() => {
                setQuantity(q.key);
                setModel(q.key === 'vx' || q.key === 'vy' ? 'linear' : 'quadratic');
              }}>
              {q.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button className={chip(model === 'linear')} onClick={() => setModel('linear')}>
            直線
          </button>
          <button className={chip(model === 'quadratic')} onClick={() => setModel('quadratic')}>
            放物線
          </button>
        </div>
      </div>

      <div style={sub}>
        {target?.id ?? ''} の<b>{qNote}</b>（{quantity}）の時間変化に、
        <b>{model === 'linear' ? '直線' : '放物線'}</b>を当てはめます。
        {fit && <> 使った点は <b>{fit.n} 点</b>、
          {pts[0].t.toFixed(2)} 〜 {pts[pts.length - 1].t.toFixed(2)} s の範囲です。</>}
      </div>

      {quality.issueTimes.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, padding: '7px 11px', borderRadius: 8,
          background: 'rgba(245,158,11,0.10)',
          border: '1px solid rgba(245,158,11,0.3)',
        }}>
          <span style={{ fontSize: '0.78rem', color: '#fbbf24' }}>
            位置の飛んだコマ {quality.issueTimes.length} 個
            {dropIssues ? 'を外しています' : 'も入れています'}
          </span>
          <button className="btn btn-secondary btn-sm"
            onClick={() => setDropIssues(v => !v)}>
            {dropIssues ? '入れる' : '外す'}
          </button>
        </div>
      )}

      {!calibrated && (
        <div className="notice notice-info" style={{ margin: 0 }}>
          まだ校正していないので、数値は <b>px</b> のままです。
          スケールを決めると m・m/s・m/s² になります。
        </div>
      )}

      {!fit && (
        <div className="notice notice-info" style={{ margin: 0 }}>
          当てはめに足りる点がありません（{pts.length} 点）。
          区間を広げるか、先に追跡してください。
        </div>
      )}

      {fit && (
        <>
          {/* ---- 絵で見せる ---- */}
          <div>
            <FitPlot
              all={allPts} used={pts} fit={fit}
              yLabel={`${quantity} (${qUnit})`}
              box={box} onBox={setBox}
            />
            {box ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10, marginTop: 6,
              }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--accent-primary)' }}>
                  選んだ範囲の <b>{pts.length}</b> 点で当てはめています
                  （全 {allPts.length} 点）
                </span>
                <button className="btn btn-secondary btn-sm" onClick={() => setBox(null)}>
                  全部に戻す
                </button>
              </div>
            ) : (
              <div style={{ ...sub, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                青い点が実測、白い線が当てはめた{model === 'linear' ? '直線' : '放物線'}です。
                <b>グラフの上をドラッグすると、その矩形の中の点だけで当てはめ直します</b>
                （直線になっている区間だけを取りたいときに）。
              </div>
            )}
          </div>

          {/* ---- 答え ---- */}
          {(accel || vel) && (
            <div style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'rgba(99,102,241,0.10)',
              border: '1px solid rgba(99,102,241,0.35)',
            }}>
              {accel && (
                <>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    加速度 ＝ {isVel ? '速度の傾き' : 't² の係数 × 2'}
                  </div>
                  <div className="mono" style={{
                    fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)',
                    lineHeight: 1.3,
                  }}>
                    {fmt(accel.value, 3)} ± {fmt(accel.err, 3)} {aUnit}
                  </div>
                  {gRatio !== null && gRatio > 0.3 && gRatio < 3 && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                      g の <b>{gRatio.toFixed(3)} 倍</b>（標準重力 {G_STANDARD} m/s²）
                    </div>
                  )}
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>
                    ± は傾きの標準誤差です。点が多いほど、区間が広いほど小さくなります。
                  </div>
                </>
              )}
              {vel && (
                <>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    速度 ＝ 位置の傾き
                  </div>
                  <div className="mono" style={{
                    fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)',
                  }}>
                    {fmt(vel.value, 3)} ± {fmt(vel.err, 3)} {unit}/s
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- 当てはまり具合 ---- */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, marginBottom: 6,
            }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                当てはまり具合
              </span>
              <button className="btn btn-secondary btn-sm"
                onClick={() => setShowResid(v => !v)}>
                {showResid ? '残差を閉じる' : '残差を見る'}
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { k: 'R²（1 に近いほど線に乗っている）', v: fit.r2.toFixed(6) },
                { k: 'RMSE（線からの平均的なずれ）', v: `${fmt(fit.rmse, 4)} ${qUnit}` },
              ].map(s => (
                <div key={s.k} style={{
                  padding: '8px 10px', borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-color)',
                }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{s.k}</div>
                  <div className="mono" style={{ fontSize: '0.86rem', fontWeight: 600 }}>{s.v}</div>
                </div>
              ))}
            </div>
            {showResid && (
              <div style={{ marginTop: 10 }}>
                <ResidualPlot
                  residuals={fit.residuals} rmse={fit.rmse}
                  scale={scale} unit={qUnit} onSeek={onSeek}
                />
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  残差＝実測 − 当てはめ。<b>でたらめにばらついていれば、その
                  モデルで足りています。</b>弓なりに曲がっていたらモデルが違います
                  （直線を当てはめた速度が曲がる＝加速度が一定でない）。
                  橙の点は RMSE の 2.5 倍を超えた点で、クリックするとその時刻へ飛びます。
                </div>
              </div>
            )}
          </div>

          {/* ---- a-t 図 ---- */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, marginBottom: 6,
            }}>
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: '0.8rem', color: 'var(--text-secondary)',
              }}>
                <Activity size={14} />
                a-t 図（2 階差分）
              </span>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowAt(v => !v)}>
                {showAt ? '閉じる' : '開く'}
              </button>
            </div>
            {showAt && (
              atData.length < 2 ? (
                <div style={{ ...sub, color: 'var(--text-muted)' }}>
                  この Δt では点が足りません。Δt を小さくするか、範囲を広げてください。
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                    {[1, 2, 4, 8, 16].map(k => (
                      <button key={k} className={chip(k === atKUsed)}
                        onClick={() => setAtK(k)}>
                        {(atDt * k * 1000).toFixed(0)}ms
                        {k === recommendK(atDt) && atK === null ? '（自動）' : ''}
                      </button>
                    ))}
                  </div>
                  <AtPlot data={atData} mean={atStat.mean} sd={atStat.sd} unit={aUnit} />
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '0.84rem', marginTop: 6,
                  }}>
                    <span>平均</span>
                    <b className="mono">
                      {fmt(atStat.mean, 3)} ± {fmt(atStat.sd, 3)} {aUnit}
                    </b>
                  </div>
                  {accel && (
                    <div style={{ ...sub, fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      当てはめから出した加速度は <b className="mono">{fmt(accel.value, 3)}</b>。
                      この 2 つが近ければ、どちらの出し方でも同じ答えが出ているということです。
                    </div>
                  )}
                  <div style={{ ...sub, fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    Δt を小さくするとばらつきが跳ね上がります（分母が (Δt)² なので、
                    半分にすると 4 倍）。大きくすると「その区間で加速度が一定」という
                    前提が効いてきて、変化のある運動では鈍ります。
                    <b>実時間で 30ms 前後</b>が目安です。
                  </div>
                </>
              )
            )}
          </div>

          {/* ---- Δt の選び方 ---- */}
          {sdStats.length > 0 && (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 6,
              }}>
                <Activity size={14} />
                2 階差分で加速度を出すなら、Δt をどう取るか
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)' }}>
                    <th style={{ textAlign: 'left', padding: '3px 6px' }}>Δt</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px' }}>コマ数</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px' }}>平均 a</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px' }}>ばらつき (SD)</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px' }}>点</th>
                  </tr>
                </thead>
                <tbody className="mono">
                  {sdStats.map(s => (
                    <tr key={s.k} style={{ borderTop: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '3px 6px' }}>{(s.dt * 1000).toFixed(1)} ms</td>
                      <td style={{ textAlign: 'right', padding: '3px 6px' }}>{s.k}</td>
                      <td style={{ textAlign: 'right', padding: '3px 6px' }}>{fmt(s.mean, 3)}</td>
                      <td style={{ textAlign: 'right', padding: '3px 6px' }}>{fmt(s.sd, 3)}</td>
                      <td style={{ textAlign: 'right', padding: '3px 6px', color: 'var(--text-muted)' }}>{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 6 }}>
                分母が (Δt)² なので、<b>Δt を 2 倍にするとばらつきは 1/4</b> になります。
                一方で広げると「その区間で加速度が一定」という前提が効いてきます。
                <b>平均が動かなくなって、ばらつきが十分小さい最小の Δt</b> を選んでください。
              </div>
            </div>
          )}

          {/* ---- 前提 ---- */}
          <div style={{ paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowWhy(v => !v)}>
              {showWhy ? 'この数値の前提を閉じる' : 'この数値の前提'}
            </button>
            {showWhy && (
              <div style={{
                fontSize: '0.74rem', color: 'var(--text-muted)',
                lineHeight: 1.65, marginTop: 8,
              }}>
                当てはめているのは<b>平滑化していない生データ</b>です。平滑化した
                データに当てはめると、傾きはほとんど変わらないのに R² と標準誤差
                だけが良くなります（隣の点と相関ができて「独立な n 点」という
                前提が崩れるため）。見やすさのための平滑化と、数値を出すための
                当てはめは別の作業です。
                <br /><br />
                <b>スケールの誤差は加速度に比例、時間軸の誤差は 2 乗で効きます。</b>
                撮影 fps を 2 倍間違えると加速度は 4 倍ずれます。
                <br /><br />
                見失った点と、追跡が飛んだと判定された点（✕ の付いた点）は
                当てはめから除いています。
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
