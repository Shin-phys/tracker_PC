// src/components/AnalysisPanel.tsx
// ============================================================
// 解析 — 当てはめて数値を出すためのパネル。
//
// グラフ概形の確認（DataPanel）と分けてあるのは、やることが違うから。
// あちらは「計測が使い物になるか」を見る場所で、平滑化も効く。
// こちらは「数値をいくつとして報告するか」を決める場所なので、
//   ・当てはめるのは**生データ**（平滑化すると不確かさが過小評価される）
//   ・傾きには**標準誤差を必ず添える**
//   ・残差を見せる（構造が残っていたらモデルが違う）
// の 3 つを外さない。
// ============================================================

import React, { useMemo, useState } from 'react';
import { TrackedObject, FrameData, FpsSettings, ScaleCalibration } from '../types';
import {
  fitSeries, rawSeries, pickQuantity, accelerationOf, velocityOf,
  secondDiffStats, FitModel, FitQuantity, G_STANDARD,
} from '../utils/fit';
import { timeScale } from '../utils/timeScale';
import { TimeRange } from '../utils/timeRange';
import { TrendingUp, Sigma, Activity } from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  historyData: FrameData[];
  timeRange: TimeRange;
  fpsSettings: FpsSettings;
  calibration: ScaleCalibration;
  /** 残差の外れ点から動画へ飛ぶ */
  onSeek?: (t: number) => void;
}

const QUANTITIES: { key: FitQuantity; label: string }[] = [
  { key: 'x', label: 'x' },
  { key: 'y', label: 'y' },
  { key: 'vx', label: 'vx' },
  { key: 'vy', label: 'vy' },
];

const fmt = (v: number, d = 4): string => {
  if (!isFinite(v)) return '---';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(d);
};

/** 残差グラフ。構造（曲がり・うねり）が見えたらモデルが違う */
const ResidualPlot: React.FC<{
  residuals: { t: number; r: number }[];
  rmse: number;
  color: string;
  onSeek?: (t: number) => void;
  scale: number;
}> = ({ residuals, rmse, color, onSeek, scale }) => {
  const W = 560;
  const H = 120;
  const pad = { l: 46, r: 8, t: 10, b: 20 };
  if (residuals.length < 2) return null;
  const ts = residuals.map(p => p.t);
  const rs = residuals.map(p => p.r);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const rAbs = Math.max(...rs.map(Math.abs), 1e-12);
  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (r: number) =>
    pad.t + (0.5 - (r / (rAbs * 1.15)) * 0.5) * (H - pad.t - pad.b);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {/* ±RMSE の帯。点の 2/3 ほどがこの中に入るのが素直な姿 */}
      <rect
        x={pad.l} y={py(rmse)} width={W - pad.l - pad.r}
        height={Math.max(1, py(-rmse) - py(rmse))}
        fill="rgba(99,102,241,0.12)"
      />
      <line x1={pad.l} y1={py(0)} x2={W - pad.r} y2={py(0)}
        stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
      <text x={4} y={py(0) + 4} fill="var(--text-muted)" fontSize={10}>0</text>
      <text x={4} y={py(rAbs) + 10} fill="var(--text-muted)" fontSize={10}>
        {rAbs.toExponential(1)}
      </text>
      {residuals.map((p, i) => (
        <circle
          key={i} cx={px(p.t)} cy={py(p.r)} r={2.6}
          fill={Math.abs(p.r) > 2.5 * rmse ? '#ef4444' : color}
          style={{ cursor: onSeek ? 'pointer' : 'default' }}
          onClick={() => onSeek?.(scale > 0 ? p.t / scale : p.t)}
        />
      ))}
      <text x={pad.l} y={H - 6} fill="var(--text-muted)" fontSize={10}>
        {tMin.toFixed(3)} s
      </text>
      <text x={W - pad.r} y={H - 6} fill="var(--text-muted)" fontSize={10}
        textAnchor="end">
        {tMax.toFixed(3)} s
      </text>
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

  const unit = calibration.unit;
  const scale = timeScale(fpsSettings);
  const target = active.find(o => o.id === objId) ?? active[0];

  const series = useMemo(
    () => rawSeries(historyData, target?.id ?? objId, scale, timeRange),
    [historyData, target?.id, objId, scale, timeRange]
  );

  const values = pickQuantity(series, quantity);
  const pts = useMemo(
    () => series.t.map((t, i) => ({ t, y: values[i] })),
    [series.t, values]
  );
  const fit = useMemo(() => fitSeries(pts, model), [pts, model]);

  // 2 階差分は位置に対してだけ意味がある
  const sdStats = useMemo(() => {
    if (quantity === 'vx' || quantity === 'vy') return [];
    return secondDiffStats(series.t, values);
  }, [series.t, values, quantity]);

  const accel = fit ? accelerationOf(quantity, fit) : null;
  const vel = fit ? velocityOf(quantity, fit) : null;
  const isVel = quantity === 'vx' || quantity === 'vy';
  const qUnit = isVel ? `${unit}/s` : unit;

  const chip = (on: boolean) => `chip ${on ? 'is-active' : ''}`;

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
                // 位置なら放物線、速度なら直線が既定。
                // 加速度を読みたい場面がほとんどなので、そこへ寄せる。
                setModel(q.key === 'vx' || q.key === 'vy' ? 'linear' : 'quadratic');
              }}>
              {q.label}-t
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

      {!fit && (
        <div className="notice notice-info" style={{ margin: 0 }}>
          当てはめに足りる点がありません（{pts.length} 点）。
          区間を広げるか、先に追跡してください。
        </div>
      )}

      {fit && (
        <>
          {/* ---- 物理量として読んだ値 ---- */}
          {(accel || vel) && (
            <div style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'rgba(99,102,241,0.10)',
              border: '1px solid rgba(99,102,241,0.35)',
            }}>
              {accel && (
                <>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    加速度{isVel ? '（速度の傾き）' : '（t² の係数 × 2）'}
                  </div>
                  <div className="mono" style={{
                    fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)',
                    lineHeight: 1.3,
                  }}>
                    {fmt(accel.value, 3)} ± {fmt(accel.err, 3)} {qUnit}
                    {isVel ? '' : '²'}
                    {isVel ? '/s' : ''}
                  </div>
                  {unit === 'm' && Math.abs(accel.value) > G_STANDARD * 0.3
                    && Math.abs(accel.value) < G_STANDARD * 3 && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                      g の {(Math.abs(accel.value) / G_STANDARD).toFixed(3)} 倍
                      （標準重力 {G_STANDARD} m/s²）
                    </div>
                  )}
                </>
              )}
              {vel && (
                <>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    速度（位置の傾き）
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

          {/* ---- 当てはめの中身 ---- */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { k: '点の数', v: `${fit.n}` },
              { k: 'R²', v: fit.r2.toFixed(6) },
              { k: 'RMSE', v: `${fmt(fit.rmse, 5)} ${qUnit}` },
              {
                k: '式',
                v: fit.model === 'linear'
                  ? `${fmt(fit.coef[1], 3)} t ${fit.coef[0] >= 0 ? '+' : '−'} ${fmt(Math.abs(fit.coef[0]), 3)}`
                  : `${fmt(fit.coef[2], 3)} t² …`,
              },
            ].map(s => (
              <div key={s.k} style={{
                padding: '8px 10px', borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-color)',
              }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{s.k}</div>
                <div className="mono" style={{ fontSize: '0.82rem', fontWeight: 600 }}>{s.v}</div>
              </div>
            ))}
          </div>

          {/* ---- 残差 ---- */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 4,
            }}>
              <TrendingUp size={14} />
              残差（実測 − 当てはめ）
            </div>
            <ResidualPlot
              residuals={fit.residuals} rmse={fit.rmse}
              color={target?.color ?? '#6366f1'} onSeek={onSeek} scale={scale}
            />
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              ばらついているだけなら、そのモデルで足りています。
              <b>弓なりに曲がっていたらモデルが違います</b>
              （直線を当てはめた速度が曲がる＝加速度が一定でない）。
              赤い点は RMSE の 2.5 倍を超えた点で、クリックするとその時刻へ飛びます。
            </div>
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
                一方で Δt を広げると「その区間で加速度が一定」という前提が効いてくるので、
                等加速度でない運動では平均が偏ります。
                <b>平均が動かなくなって、ばらつきが十分小さい最小の Δt</b> を選ぶのが定石です。
              </div>
            </div>
          )}

          {/* ---- 原則 ---- */}
          <div style={{
            fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.65,
            paddingTop: 10, borderTop: '1px solid var(--border-color)',
          }}>
            当てはめているのは<b>平滑化していない生データ</b>です。平滑化したデータに
            当てはめると、傾きはほとんど変わらないのに R² と標準誤差だけが良くなります
            （平滑化は隣の点と相関を作るので「独立な n 点」という前提が崩れ、
            不確かさが実際より小さく出ます）。
            <br />
            誤差の効き方も覚えておいてください。<b>スケールの誤差は加速度に比例、
            時間軸の誤差は 2 乗で効きます</b>。撮影 fps を 2 倍間違えると加速度は 4 倍ずれます。
          </div>
        </>
      )}
    </div>
  );
};
