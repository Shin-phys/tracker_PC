// src/components/ControlPanel.tsx — Ver.2.1
// ============================================================
// ③ スケール校正の入力しやすさを全面改善
//   ・「①線を引く → ②その長さを入力」の 2 ステップに整理し、
//     現在どちらの段階かを画面上で明示する
//   ・数値入力は大きく、単位は m/cm/mm のセグメント切替
//     （単位を変えても実長さが変わらないよう自動換算）
//   ・よく使う長さ（1/5/10/20/30/50cm, 1m）をワンタップ入力
//   ・引いた線は端点ドラッグ／矢印キーで後から微調整できる
//   ・校正結果 (px/unit, 1px = ?) を常時表示
//
// ② 追跡精度に関わるパラメータ（マーカー種別・感度など）を新設
// ④ 画面外に出た物体は EXIT バッジで表示し、再指定ボタンを出す
// ============================================================

import React from 'react';
import {
  TrackedObject, ScaleCalibration, FpsSettings, TrackingSettings,
  LengthUnit, MarkerMode, DEFAULT_TRACKING,
} from '../types';
import {
  recalcScale, convertValue, pixelDistance, fmt,
  isCalibrated as calibDone, scaleVariation,
} from '../utils/calibration';
import { RECOMMENDED_ROI_SIZE } from '../utils/tracker';
import {
  CAPTURE_FPS_PRESETS, describeTimeScale, isTimeScaled, durationCheck,
} from '../utils/timeScale';
import {
  Layers, Plus, Trash2, RefreshCw, Ruler,
  AlertTriangle, CheckCircle, Timer, Crosshair, LogOut, Settings2, RotateCcw,
} from 'lucide-react';

interface ControlPanelProps {
  objects: TrackedObject[];
  selectedObjId: string;
  onSelectObjId: (id: string) => void;
  onAddObject: () => void;
  onRemoveObject: (id: string) => void;
  onRecalibrateObject: (id: string) => void;
  calibration: ScaleCalibration;
  onUpdateCalibration: (calib: ScaleCalibration) => void;
  tracking: TrackingSettings;
  onUpdateTracking: (t: TrackingSettings) => void;
  fpsSettings: FpsSettings;
  onUpdateFpsSettings: (fps: FpsSettings) => void;
  /** 動画の長さ [s] */
  videoDuration?: number;
  isLineCalibrating: boolean;
  setIsLineCalibrating: (v: boolean) => void;
  videoWidth: number;
  videoHeight: number;
}

/** よく使う基準物のプリセット（実寸 mm 起点で cm に換算して保持） */
const PLANE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'A4 横', w: 29.7, h: 21 },
  { label: 'A4 縦', w: 21, h: 29.7 },
  { label: 'A3 横', w: 42, h: 29.7 },
  { label: '方眼 50×50', w: 50, h: 50 },
  { label: '床タイル 30', w: 30, h: 30 },
];

const UNITS: LengthUnit[] = ['mm', 'cm', 'm'];

/** よく使う実長さのプリセット（値, 単位, 表示） */
const PRESETS: { v: number; u: LengthUnit; label: string }[] = [
  { v: 1, u: 'cm', label: '1cm' },
  { v: 5, u: 'cm', label: '5cm' },
  { v: 10, u: 'cm', label: '10cm' },
  { v: 20, u: 'cm', label: '20cm' },
  { v: 30, u: 'cm', label: '30cm' },
  { v: 50, u: 'cm', label: '50cm' },
  { v: 1, u: 'm', label: '1m' },
];

const MARKER_MODES: { id: MarkerMode; label: string; hint: string }[] = [
  { id: 'white', label: '白いマーカー', hint: '暗い対象の上に貼った白シール' },
  { id: 'dark', label: '黒いマーカー', hint: '明るい対象の上に貼った黒シール' },
];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  objects,
  selectedObjId,
  onSelectObjId,
  onAddObject,
  onRemoveObject,
  onRecalibrateObject,
  calibration,
  onUpdateCalibration,
  tracking,
  onUpdateTracking,
  fpsSettings,
  onUpdateFpsSettings,
  videoDuration = 0,
  isLineCalibrating,
  setIsLineCalibrating,
  videoWidth,
  videoHeight,
}) => {
  const activeObjects = objects.filter(o => o.active);
  const lostObjects = activeObjects.filter(o => o.status === 'lost');
  const exitedObjects = activeObjects.filter(o => o.status === 'exited');
  const needsAttention = [...lostObjects, ...exitedObjects];

  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const hasLine = calibration.mode === 'line' && calibration.linePoints.length === 2;
  const linePx = hasLine
    ? pixelDistance(calibration.linePoints[0], calibration.linePoints[1])
    : 0;
  const isCalibrated = calibDone(calibration);
  const hasPlane = calibration.mode === 'plane' && calibration.homography !== null;
  const variation = scaleVariation(calibration, videoWidth, videoHeight);

  const setValue = (v: number) =>
    onUpdateCalibration(recalcScale({ ...calibration, realSizeValue: v }));

  const setUnit = (u: LengthUnit) => {
    // 単位を変えても「同じ実長さ」を保つ（10cm → m にしたら 0.1m）
    const v = convertValue(calibration.realSizeValue, calibration.unit, u);
    onUpdateCalibration(recalcScale({ ...calibration, unit: u, realSizeValue: v }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ========================================
          要対応バナー（Lost / 画面外退出）
          ======================================== */}
      {needsAttention.length > 0 && (
        <div style={{
          background: lostObjects.length ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
          border: `1.5px solid ${lostObjects.length ? 'rgba(239,68,68,0.45)' : 'rgba(245,158,11,0.45)'}`,
          borderRadius: '10px', padding: '10px 14px',
        }}>
          {lostObjects.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', color: '#fca5a5', fontWeight: 600, marginBottom: '8px' }}>
              <AlertTriangle size={15} color="#ef4444" />
              追跡ロスト — {lostObjects.length}個の物体を再指定してください
            </div>
          )}
          {exitedObjects.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', color: '#fcd34d', fontWeight: 600, marginBottom: '8px' }}>
              <LogOut size={15} color="#f59e0b" />
              画面外へ退出 — {exitedObjects.map(o => o.id).join(', ')} の追尾を終了しました
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {needsAttention.map(obj => (
              <button key={obj.id}
                className={`btn btn-sm ${obj.status === 'lost' ? 'btn-danger' : 'btn-secondary'}`}
                onClick={() => onRecalibrateObject(obj.id)}
                style={{ justifyContent: 'flex-start', gap: '8px' }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: obj.color, flexShrink: 0 }} />
                <RefreshCw size={12} />
                {obj.name} を再指定して追跡を再開
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ========================================
          1. 追跡オブジェクト
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div className="section-title">
            <Layers size={17} color="var(--accent-primary)" />
            追跡オブジェクト ({activeObjects.length}/5)
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onAddObject} disabled={activeObjects.length >= 5}>
            <Plus size={13} />
            追加
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {activeObjects.map(obj => {
            const isSelected = obj.id === selectedObjId;
            const isLost = obj.status === 'lost';
            const isExited = obj.status === 'exited';
            const isTracking = obj.status === 'tracking';

            return (
              <div key={obj.id} onClick={() => onSelectObjId(obj.id)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: '9px',
                background: isSelected ? `${obj.color}18` : 'var(--bg-secondary)',
                border: `1.5px solid ${isSelected ? obj.color : 'transparent'}`,
                cursor: 'pointer', transition: 'all 0.15s ease',
                boxShadow: isSelected ? `0 0 10px ${obj.color}30` : 'none',
                opacity: isExited ? 0.72 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div className={`status-dot ${obj.status}`} style={{
                    backgroundColor: isLost ? 'var(--color-danger)'
                      : isExited ? '#f59e0b'
                        : isTracking ? 'var(--color-success)' : 'var(--text-muted)',
                  }} />
                  <div style={{ width: 13, height: 13, borderRadius: 4, backgroundColor: obj.color, boxShadow: `0 0 8px ${obj.color}80`, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{obj.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 1 }}>
                      {obj.roi ? (
                        <span style={{
                          color: Math.min(obj.roi.width, obj.roi.height) < RECOMMENDED_ROI_SIZE
                            ? '#fcd34d' : 'var(--text-secondary)',
                          fontWeight: Math.min(obj.roi.width, obj.roi.height) < RECOMMENDED_ROI_SIZE ? 700 : 400,
                        }}>
                          枠 {Math.round(obj.roi.width)}×{Math.round(obj.roi.height)}px
                          {Math.min(obj.roi.width, obj.roi.height) < RECOMMENDED_ROI_SIZE && ' ⚠ 小さすぎ'}
                        </span>
                      ) : '枠未指定'}
                      {obj.center && ` / (${obj.center.x.toFixed(1)}, ${obj.center.y.toFixed(1)})`}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isLost ? (
                    <span className="badge" style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)', fontSize: '0.68rem' }}>
                      <AlertTriangle size={10} style={{ marginRight: 3 }} />LOST
                    </span>
                  ) : isExited ? (
                    <span className="badge" style={{ background: 'rgba(245,158,11,0.18)', color: '#fcd34d', border: '1px solid rgba(245,158,11,0.4)', fontSize: '0.68rem' }}>
                      <LogOut size={10} style={{ marginRight: 3 }} />EXIT
                    </span>
                  ) : isTracking ? (
                    <span className="badge" style={{ background: 'rgba(16,217,124,0.12)', color: '#10d97c', border: '1px solid rgba(16,217,124,0.3)', fontSize: '0.68rem' }}>
                      <CheckCircle size={10} style={{ marginRight: 3 }} />OK
                    </span>
                  ) : null}

                  <button className="btn btn-secondary btn-sm" title="再指定・補正" style={{ padding: '3px 6px' }}
                    onClick={e => { e.stopPropagation(); onRecalibrateObject(obj.id); }}>
                    <RefreshCw size={11} />
                  </button>

                  {activeObjects.length > 1 && (
                    <button className="btn btn-danger btn-sm" title="削除" style={{ padding: '3px 6px' }}
                      onClick={e => { e.stopPropagation(); onRemoveObject(obj.id); }}>
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ========================================
          2. スケール校正（全面刷新）
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div className="section-title">
            <Ruler size={17} color="var(--accent-primary)" />
            スケール校正
          </div>
          <span className="badge" style={{
            fontSize: '0.68rem',
            background: isCalibrated ? 'rgba(16,217,124,0.12)' : 'rgba(245,158,11,0.15)',
            color: isCalibrated ? '#10d97c' : '#fcd34d',
            border: `1px solid ${isCalibrated ? 'rgba(16,217,124,0.3)' : 'rgba(245,158,11,0.35)'}`,
          }}>
            {isCalibrated ? '校正済み' : '未校正'}
          </span>
        </div>

        {/* モード切替 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '6px' }}>
          <button
            className={`btn ${calibration.mode === 'plane' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
            style={{ fontSize: '0.74rem', justifyContent: 'center' }}
            onClick={() => { setIsLineCalibrating(false); onUpdateCalibration(recalcScale({ ...calibration, mode: 'plane' })); }}>
            平面（四隅）
          </button>
          <button
            className={`btn ${calibration.mode === 'line' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
            style={{ fontSize: '0.74rem', justifyContent: 'center' }}
            onClick={() => { setIsLineCalibrating(false); onUpdateCalibration(recalcScale({ ...calibration, mode: 'line' })); }}>
            2点間
          </button>
          <button
            className={`btn ${calibration.mode === 'box' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
            style={{ fontSize: '0.74rem', justifyContent: 'center' }}
            onClick={() => {
              setIsLineCalibrating(false);
              const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
              onUpdateCalibration(recalcScale({ ...calibration, mode: 'box' }, target?.roi?.width));
            }}>
            追跡枠の幅
          </button>
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
          {calibration.mode === 'plane'
            ? '斜めから撮っていても遠近を補正できます。基準物を運動面と同じ平面に置いてください。'
            : '光軸が運動面に垂直なときだけ正確です。斜めなら「平面（四隅）」を使ってください。'}
        </div>

        {/* ---------- PLANE モード ---------- */}
        {calibration.mode === 'plane' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* STEP 1: 四隅を指定 */}
            <div style={{
              border: `1px solid ${hasPlane ? 'rgba(16,217,124,0.3)' : 'rgba(245,158,11,0.35)'}`,
              background: hasPlane ? 'rgba(16,217,124,0.06)' : 'rgba(245,158,11,0.07)',
              borderRadius: '10px', padding: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '0.8rem', fontWeight: 700, color: hasPlane ? '#10d97c' : '#fcd34d' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: '50%', fontSize: '0.68rem',
                  background: hasPlane ? '#10d97c' : '#f59e0b', color: '#06101f', fontWeight: 800,
                }}>1</span>
                基準になる四角形の四隅をクリック
              </div>

              <button
                className={`btn ${isLineCalibrating ? 'btn-warning' : hasPlane ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                onClick={() => {
                  if (!isLineCalibrating) {
                    onUpdateCalibration({ ...calibration, planePoints: [], homography: null });
                  }
                  setIsLineCalibrating(!isLineCalibrating);
                }}
                style={{ width: '100%', justifyContent: 'center' }}>
                <Crosshair size={13} />
                {isLineCalibrating
                  ? `クリック中 ${calibration.planePoints.length}/4（ESCで中止）`
                  : hasPlane ? '四隅を取り直す' : '四隅の指定を開始'}
              </button>

              <div style={{ marginTop: '8px', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <b>左上 → 右上 → 右下 → 左下</b> の順で。指定後は ● をドラッグして微調整できます。
              </div>
            </div>

            {/* STEP 2: 実寸 */}
            <div style={{
              border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px',
              opacity: calibration.planePoints.length === 4 ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '0.8rem', fontWeight: 700 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: '50%', fontSize: '0.68rem',
                  background: 'var(--accent-primary)', color: '#fff', fontWeight: 800,
                }}>2</span>
                その四角形の実寸
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '3px' }}>横</label>
                  <input type="number" inputMode="decimal" step="any" min="0"
                    value={calibration.planeWidth}
                    onFocus={e => e.currentTarget.select()}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      onUpdateCalibration(recalcScale({ ...calibration, planeWidth: isNaN(v) ? 0 : v }));
                    }}
                    style={{ fontSize: '1.1rem', fontWeight: 700, textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }} />
                </div>
                <span style={{ paddingBottom: 8, color: 'var(--text-muted)' }}>×</span>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '3px' }}>縦</label>
                  <input type="number" inputMode="decimal" step="any" min="0"
                    value={calibration.planeHeight}
                    onFocus={e => e.currentTarget.select()}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      onUpdateCalibration(recalcScale({ ...calibration, planeHeight: isNaN(v) ? 0 : v }));
                    }}
                    style={{ fontSize: '1.1rem', fontWeight: 700, textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {UNITS.map(u => (
                    <button key={u}
                      className={`btn btn-sm ${calibration.unit === u ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => {
                        const w = convertValue(calibration.planeWidth, calibration.unit, u);
                        const h = convertValue(calibration.planeHeight, calibration.unit, u);
                        onUpdateCalibration(recalcScale({ ...calibration, unit: u, planeWidth: w, planeHeight: h }));
                      }}
                      style={{ padding: '1px 10px', fontSize: '0.72rem', minWidth: 46, justifyContent: 'center' }}>
                      {u}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '10px' }}>
                {PLANE_PRESETS.map(p => {
                  const w = convertValue(p.w, 'cm', calibration.unit);
                  const h = convertValue(p.h, 'cm', calibration.unit);
                  const active = Math.abs(calibration.planeWidth - w) < 1e-9 && Math.abs(calibration.planeHeight - h) < 1e-9;
                  return (
                    <button key={p.label}
                      className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ fontSize: '0.71rem', padding: '3px 8px' }}
                      onClick={() => onUpdateCalibration(recalcScale({ ...calibration, planeWidth: w, planeHeight: h }))}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 遠近の強さ */}
            {variation && (
              <div style={{
                fontSize: '0.76rem', lineHeight: 1.7, padding: '9px 12px', borderRadius: '8px',
                background: variation.spreadPct > 3 ? 'rgba(245,158,11,0.1)' : 'rgba(16,217,124,0.08)',
                border: `1px solid ${variation.spreadPct > 3 ? 'rgba(245,158,11,0.3)' : 'rgba(16,217,124,0.25)'}`,
                color: 'var(--text-secondary)',
              }}>
                画面内の縮尺のばらつき:{' '}
                <b className="mono" style={{ color: variation.spreadPct > 3 ? '#fcd34d' : '#10d97c' }}>
                  {variation.spreadPct.toFixed(1)}%
                </b>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                  {variation.spreadPct > 3
                    ? 'それなりに斜めから撮れています。単一スケール校正だとこの分がそのまま誤差になっていました。'
                    : 'ほぼ正対しています。2点間校正でも大きな差は出ません。'}
                  （{fmt(variation.min, 2)}〜{fmt(variation.max, 2)} px/{calibration.unit}）
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------- LINE モード ---------- */}
        {calibration.mode === 'line' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* STEP 1: 線を引く */}
            <div style={{
              border: `1px solid ${hasLine ? 'rgba(16,217,124,0.3)' : 'rgba(245,158,11,0.35)'}`,
              background: hasLine ? 'rgba(16,217,124,0.06)' : 'rgba(245,158,11,0.07)',
              borderRadius: '10px', padding: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '0.8rem', fontWeight: 700, color: hasLine ? '#10d97c' : '#fcd34d' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: '50%', fontSize: '0.68rem',
                  background: hasLine ? '#10d97c' : '#f59e0b', color: '#06101f', fontWeight: 800,
                }}>1</span>
                映像上で長さの分かる部分をなぞる
              </div>

              <button
                className={`btn ${isLineCalibrating ? 'btn-warning' : hasLine ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                onClick={() => setIsLineCalibrating(!isLineCalibrating)}
                style={{ width: '100%', justifyContent: 'center' }}>
                <Crosshair size={13} />
                {isLineCalibrating
                  ? 'ドラッグしてください（ESCで中止）'
                  : hasLine ? '線を引き直す' : '映像上でドラッグを開始'}
              </button>

              {hasLine && (
                <div style={{ marginTop: '8px', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  引いた長さ: <b className="mono" style={{ color: '#fbbf24' }}>{linePx.toFixed(1)} px</b>
                  <br />
                  端点の <span style={{ color: '#f59e0b' }}>●</span> / <span style={{ color: '#10b981' }}>●</span> をドラッグ、
                  または <kbd>←↑↓→</kbd>（Shift＋で2点目）で 1px 単位の微調整ができます。
                </div>
              )}
            </div>

            {/* STEP 2: 実長さを入力 */}
            <div style={{
              border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px',
              opacity: hasLine ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: '50%', fontSize: '0.68rem',
                  background: 'var(--accent-primary)', color: '#fff', fontWeight: 800,
                }}>2</span>
                その長さは実際に何cm？
              </div>

              {/* 数値 + 単位 */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={calibration.realSizeValue}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setValue(isNaN(v) ? 0 : v);
                  }}
                  style={{
                    flex: 1, fontSize: '1.35rem', fontWeight: 700, textAlign: 'right',
                    padding: '8px 12px', fontFamily: 'JetBrains Mono, monospace',
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {UNITS.map(u => (
                    <button key={u}
                      className={`btn btn-sm ${calibration.unit === u ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setUnit(u)}
                      style={{ padding: '2px 12px', fontSize: '0.75rem', minWidth: 52, justifyContent: 'center' }}>
                      {u}
                    </button>
                  ))}
                </div>
              </div>

              {/* プリセット */}
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '10px' }}>
                {PRESETS.map(p => {
                  const active = calibration.unit === p.u && Math.abs(calibration.realSizeValue - p.v) < 1e-9;
                  return (
                    <button key={p.label}
                      className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ fontSize: '0.72rem', padding: '3px 9px' }}
                      onClick={() => onUpdateCalibration(recalcScale({ ...calibration, realSizeValue: p.v, unit: p.u }))}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ---------- BOX モード ---------- */}
        {calibration.mode === 'box' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                基準にする追跡枠:
              </label>
              <select
                value={calibration.targetObjId || selectedObjId}
                onChange={e => {
                  const id = e.target.value;
                  const target = activeObjects.find(o => o.id === id);
                  onUpdateCalibration(recalcScale({ ...calibration, targetObjId: id }, target?.roi?.width));
                }}>
                {activeObjects.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.name}{o.roi ? ` (幅 ${Math.round(o.roi.width)}px)` : ' (枠未指定)'}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                その枠の幅は実際に何cm？
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <input
                  type="number" inputMode="decimal" step="any" min="0"
                  value={calibration.realSizeValue}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
                    onUpdateCalibration(
                      recalcScale({ ...calibration, realSizeValue: isNaN(v) ? 0 : v }, target?.roi?.width)
                    );
                  }}
                  style={{ flex: 1, fontSize: '1.35rem', fontWeight: 700, textAlign: 'right', padding: '8px 12px', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {UNITS.map(u => (
                    <button key={u}
                      className={`btn btn-sm ${calibration.unit === u ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => {
                        const v = convertValue(calibration.realSizeValue, calibration.unit, u);
                        const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
                        onUpdateCalibration(recalcScale({ ...calibration, unit: u, realSizeValue: v }, target?.roi?.width));
                      }}
                      style={{ padding: '2px 12px', fontSize: '0.75rem', minWidth: 52, justifyContent: 'center' }}>
                      {u}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 校正結果 */}
        <div style={{
          marginTop: '14px', fontSize: '0.8rem',
          background: isCalibrated ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.03)',
          border: `1px solid ${isCalibrated ? 'rgba(99,102,241,0.25)' : 'var(--border-color)'}`,
          padding: '10px 12px', borderRadius: '8px', color: '#a5b4fc', lineHeight: 1.7,
        }}>
          {!isCalibrated ? (
            <span style={{ color: 'var(--text-secondary)' }}>
              未校正です。上の手順で校正すると、速度や距離が実寸で表示されます
              （未校正のままでも px 単位で記録は取れます）。
            </span>
          ) : calibration.mode === 'plane' ? (
            <div>
              射影変換で校正済み — 画面内の位置に応じて縮尺が自動補正されます。
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                原点は四角形の{calibration.yUp ? '左下' : '左上'}の角、単位は {calibration.unit}。
              </div>
            </div>
          ) : (
            <>
              <div>
                縮尺: <span className="mono" style={{ color: '#c7d2fe', fontWeight: 700 }}>
                  {fmt(calibration.pxPerUnit, 3)} px / {calibration.unit}
                </span>
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                1 px = <span className="mono">{fmt(1 / calibration.pxPerUnit, 4)} {calibration.unit}</span>
              </div>
            </>
          )}
        </div>

        {/* 座標系 */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px',
          fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-secondary)',
        }}>
          <input type="checkbox" checked={calibration.yUp}
            onChange={e => onUpdateCalibration(recalcScale({ ...calibration, yUp: e.target.checked }))}
            style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }} />
          Y軸を上向きにする（物理の座標系に合わせる）
        </label>

        {/* 原点。指定は映像側の「原点」ボタンで行う */}
        <div style={{
          marginTop: '8px', fontSize: '0.75rem', lineHeight: 1.6,
          background: 'rgba(255,255,255,0.03)', padding: '7px 10px',
          borderRadius: '6px', border: '1px solid var(--border-color)',
          color: 'var(--text-muted)',
        }}>
          原点:{' '}
          {calibration.origin ? (
            <span className="mono" style={{ color: '#fcd34d', fontWeight: 700 }}>
              ({calibration.origin.x}, {calibration.origin.y}) px
            </span>
          ) : (
            <span>画像の{calibration.yUp ? '左下' : '左上'}（既定）</span>
          )}
          <div style={{ marginTop: 3 }}>
            映像の下にある「原点」ボタンから、斜面の始点などを原点にできます。
            CSV の x, y がその点からの値になります。
          </div>
        </div>
      </div>

      {/* ========================================
          3. フレームレートと時間軸
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div className="section-title" style={{ marginBottom: '12px' }}>
          <Timer size={17} color="var(--accent-primary)" />
          フレームレートと時間軸
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* ---- ファイルfps（自動計測・編集不可） ---- */}
          <div style={{
            fontSize: '0.78rem', color: 'var(--text-secondary)',
            background: 'rgba(255,255,255,0.03)', padding: '8px 10px',
            borderRadius: '6px', border: '1px solid var(--border-color)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>ファイルのfps（自動計測）</span>
              <span className="mono" style={{ color: 'var(--color-success)', fontWeight: 700 }}>
                {fpsSettings.value.toFixed(2)} fps
              </span>
            </div>
            <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: '0.72rem', lineHeight: 1.6 }}>
              動画を開いたときに、コマ送りして実フレーム間隔を測っています。
              QuickTime の「エンコード FPS」と一致するはずです。
            </div>
          </div>

          {/* ---- 撮影fps（実時間の基準） ---- */}
          <div>
            <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
              撮影fps（スロー動画のときに指定）
            </label>
            <input type="number" step="1" min="0" max="2000"
              value={fpsSettings.captureFps || ''}
              placeholder="未指定（通常の動画）"
              onFocus={e => e.currentTarget.select()}
              onChange={e => {
                const v = parseFloat(e.target.value);
                onUpdateFpsSettings({
                  ...fpsSettings,
                  captureFps: isFinite(v) && v > 0 ? v : 0,
                });
              }} />

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              <button
                className={`btn btn-sm ${!fpsSettings.captureFps ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => onUpdateFpsSettings({ ...fpsSettings, captureFps: 0 })}
                style={{ fontSize: '0.75rem', padding: '3px 8px' }}>
                通常
              </button>
              {CAPTURE_FPS_PRESETS.map(f => (
                <button key={f}
                  className={`btn btn-sm ${Math.abs(fpsSettings.captureFps - f) < 0.01 ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => onUpdateFpsSettings({ ...fpsSettings, captureFps: f })}
                  style={{ fontSize: '0.75rem', padding: '3px 8px' }}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* ---- 換算結果 ---- */}
          <div style={{
            fontSize: '0.76rem', lineHeight: 1.6,
            background: isTimeScaled(fpsSettings)
              ? 'rgba(252,211,77,0.08)' : 'rgba(255,255,255,0.03)',
            border: isTimeScaled(fpsSettings)
              ? '1px solid rgba(252,211,77,0.3)' : '1px solid var(--border-color)',
            padding: '8px 10px', borderRadius: '6px',
            color: isTimeScaled(fpsSettings) ? '#fcd34d' : 'var(--text-muted)',
          }}>
            時間軸: <span className="mono" style={{ fontWeight: 700 }}>
              {describeTimeScale(fpsSettings)}
            </span>

            {/* 秒数でも出す。倍率だけだと、ファイルfps の計測が外れたときに
                時間軸が黙って壊れていても気づけない */}
            {videoDuration > 0 && (() => {
              const d = durationCheck(videoDuration, fpsSettings);
              return (
                <div style={{
                  marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}>
                  この動画:{' '}
                  <span className="mono">再生 {d.playback.toFixed(2)} 秒</span>
                  {' → '}
                  <span className="mono" style={{ fontWeight: 700 }}>
                    実時間 {d.real.toFixed(2)} 秒
                  </span>
                  <div style={{ marginTop: 3, color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                    この秒数が実際の現象の長さと合っているか確認してください。
                    合わなければ撮影fpsの指定が違っています。
                  </div>
                </div>
              );
            })()}

            <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: '0.72rem' }}>
              240fps で撮って 30fps で書き出したスロー動画なら「撮影fps = 240」。
              グラフと CSV の時刻・速度がこの倍率で実時間に直されます。
            </div>
          </div>
        </div>
      </div>

      {/* ========================================
          4. 追跡の詳細設定
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: showAdvanced ? '14px' : 0 }}>
          <div className="section-title">
            <Settings2 size={17} color="var(--accent-primary)" />
            追跡の詳細設定
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdvanced(v => !v)}>
            {showAdvanced ? '閉じる' : '開く'}
          </button>
        </div>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* サブピクセル */}
            <div style={{
              background: 'rgba(16,217,124,0.06)', border: '1px solid rgba(16,217,124,0.22)',
              borderRadius: '8px', padding: '10px 12px',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 600 }}>
                <input type="checkbox" checked={tracking.subpixel}
                  onChange={e => onUpdateTracking({ ...tracking, subpixel: e.target.checked })}
                  style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }} />
                サブピクセル補間（強く推奨）
              </label>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '5px', lineHeight: 1.6 }}>
                相関ピーク近傍に 2 次曲面をあてはめて、1px より細かい位置を求めます。
                実測でガタつき（位置の2階差分RMS）が <b style={{ color: '#10d97c' }}>1.06px → 0.35px</b> に低減しました。
                OFF にすると Ver.2.0 と同じ 1px 刻みに戻ります。
              </div>
            </div>

            {/* 重心補正（任意） */}
            <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 600 }}>
                <input type="checkbox" checked={tracking.centroidRefine}
                  onChange={e => onUpdateTracking({ ...tracking, centroidRefine: e.target.checked })}
                  style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }} />
                マーカー重心での追加補正（上級者向け）
              </label>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '5px', lineHeight: 1.6 }}>
                マーカーが背景から色ではっきり分離できる場合（暗い対象の上の白点など）だけ有効です。
                背景が明るい／マーカーが小さい映像では、ハイライトに重心が引っ張られて
                <b style={{ color: '#f59e0b' }}>むしろ悪化します</b>。既定は OFF。
              </div>

              {tracking.centroidRefine && (
                <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {MARKER_MODES.map(m => (
                      <button key={m.id} title={m.hint}
                        className={`btn btn-sm ${tracking.markerMode === m.id ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => onUpdateTracking({ ...tracking, markerMode: m.id })}
                        style={{ flex: 1, fontSize: '0.73rem', justifyContent: 'center' }}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      <span>重心のしきい値</span>
                      <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {tracking.centroidLevel.toFixed(2)}
                      </span>
                    </div>
                    <input type="range" min={0.2} max={0.8} step={0.05} value={tracking.centroidLevel}
                      onChange={e => onUpdateTracking({ ...tracking, centroidLevel: parseFloat(e.target.value) })}
                      style={{ width: '100%' }} />
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      高いほどマーカーの芯だけを使います
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* スライダー群 */}
            {([
              {
                key: 'lostThreshold' as const, label: 'ロスト判定の厳しさ', min: 0.2, max: 0.8, step: 0.05,
                hint: '高いほど「見失った」と判定しやすい',
                fmt: (v: number) => v.toFixed(2),
              },
              {
                key: 'searchScale' as const, label: '探索範囲', min: 0.6, max: 4, step: 0.2,
                hint: '速く動く対象では大きめに。大きいほど処理は重くなる',
                fmt: (v: number) => `${v.toFixed(1)}×`,
              },
            ]).map(s => (
              <div key={s.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  <span>{s.label}</span>
                  <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    {s.fmt(tracking[s.key])}
                  </span>
                </div>
                <input type="range" min={s.min} max={s.max} step={s.step}
                  value={tracking[s.key]}
                  onChange={e => onUpdateTracking({ ...tracking, [s.key]: parseFloat(e.target.value) })}
                  style={{ width: '100%' }} />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>{s.hint}</div>
              </div>
            ))}

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={tracking.stopOnExit}
                onChange={e => onUpdateTracking({ ...tracking, stopOnExit: e.target.checked })}
                style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }} />
              画面外に出たら、その物体の追尾を打ち切る
            </label>

            {tracking.stopOnExit && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  <span>画面外と判定する余白</span>
                  <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{tracking.exitMargin} px</span>
                </div>
                <input type="range" min={0} max={40} step={1} value={tracking.exitMargin}
                  onChange={e => onUpdateTracking({ ...tracking, exitMargin: parseInt(e.target.value, 10) })}
                  style={{ width: '100%' }} />
              </div>
            )}

            <button className="btn btn-secondary btn-sm" onClick={() => onUpdateTracking({ ...DEFAULT_TRACKING })}
              style={{ justifyContent: 'center' }}>
              <RotateCcw size={12} />
              既定値に戻す
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
