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

import React, { useMemo, useState } from 'react';
import {
  TrackedObject, FrameData, FpsSettings, ScaleCalibration,
} from '../types';
import {
  fitSeries, rawSeries, pickQuantity, accelerationOf, velocityOf,
  secondDiffStats, FitModel, FitQuantity, FitResult, G_STANDARD,
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
  pts: { t: number; y: number }[];
  fit: FitResult;
  yLabel: string;
}> = ({ pts, fit, yLabel }) => {
  const W = 560;
  const H = 240;
  const pad = { l: 60, r: 12, t: 12, b: 28 };
  const tMin = Math.min(...pts.map(p => p.t));
  const tMax = Math.max(...pts.map(p => p.t));
  const ysAll = [...pts.map(p => p.y), fit.evalAt(tMin), fit.evalAt(tMax)];
  let yMin = Math.min(...ysAll);
  let yMax = Math.max(...ysAll);
  const span = yMax - yMin || 1;
  yMin -= span * 0.08;
  yMax += span * 0.08;

  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (y: number) =>
    H - pad.b - ((y - yMin) / Math.max(1e-12, yMax - yMin)) * (H - pad.t - pad.b);

  const xTicks = ticksFor(tMin, tMax, 6);
  const yTicks = ticksFor(yMin, yMax, 5);
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1;
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;

  const curve: string = Array.from({ length: 81 }, (_, i) => {
    const t = tMin + ((tMax - tMin) * i) / 80;
    return `${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(fit.evalAt(t)).toFixed(1)}`;
  }).join(' ');

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
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
      {pts.map((p, i) => (
        <circle key={i} cx={px(p.t)} cy={py(p.y)} r={2.8} fill={DOT} opacity={0.9} />
      ))}
      <path d={curve} fill="none" stroke={LINE} strokeWidth={1.8} opacity={0.95} />
      <text x={pad.l} y={H - 3} fill="var(--text-muted)" fontSize={10}>t (s)</text>
      <text x={3} y={pad.t + 2} fill="var(--text-muted)" fontSize={10}>{yLabel}</text>
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
  const pts = useMemo(
    () => series.t.map((t, i) => ({ t, y: values[i] })),
    [series.t, values]
  );
  const fit = useMemo(() => fitSeries(pts, model), [pts, model]);
  const sdStats = useMemo(() => {
    if (quantity === 'vx' || quantity === 'vy') return [];
    return secondDiffStats(series.t, values);
  }, [series.t, values, quantity]);

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
            <FitPlot pts={pts} fit={fit} yLabel={`${quantity} (${qUnit})`} />
            <div style={{ ...sub, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              青い点が実測、白い線が当てはめた{model === 'linear' ? '直線' : '放物線'}です。
              点が線から系統的に離れていたら、モデルか追跡のどちらかが合っていません。
            </div>
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
