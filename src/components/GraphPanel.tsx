// src/components/GraphPanel.tsx
// グラフ本体＋軸セレクタ＋凡例をひとまとめにしたもの。
// 右ペインのカードと全画面表示の両方で同じものを使う。
// 軸の選択状態は呼び出し側（App）が持つので、
// 全画面に切り替えても、パネルを畳んでも選んだ組み合わせが保たれる。

import React from 'react';
import { TrackedObject, FrameData } from '../types';
import { MotionGraph, AxisKey, X_AXES, Y_AXES } from './MotionGraph';
import { SMOOTH_WINDOWS } from '../utils/graphSmooth';

interface Props {
  objects: TrackedObject[];
  data: FrameData[];
  unit: string;
  xKey: AxisKey;
  yKey: AxisKey;
  onChangeX: (k: AxisKey) => void;
  onChangeY: (k: AxisKey) => void;
  hiddenIds: string[];
  onToggleId: (id: string) => void;
  onSeek?: (t: number) => void;
  height?: number;

  /** 表示だけにかける平滑化。data は呼び出し側で平滑化済みのものが渡ってくる */
  smooth: boolean;
  smoothWindow: number;
  onChangeSmooth: (on: boolean) => void;
  onChangeSmoothWindow: (w: number) => void;
}

/** よく使う組み合わせへのショートカット */
const PRESETS: { label: string; x: AxisKey; y: AxisKey }[] = [
  { label: 'x-t', x: 't', y: 'x' },
  { label: 'y-t', x: 't', y: 'y' },
  { label: 'vx-t', x: 't', y: 'vx' },
  { label: 'vy-t', x: 't', y: 'vy' },
  { label: 'y-x', x: 'x', y: 'y' },
  { label: 'vy-vx', x: 'vx', y: 'vy' },
];

export const GraphPanel: React.FC<Props> = ({
  objects, data, unit, xKey, yKey, onChangeX, onChangeY,
  hiddenIds, onToggleId, onSeek, height,
  smooth, smoothWindow, onChangeSmooth, onChangeSmoothWindow,
}) => {
  const active = objects.filter(o => o.active);
  const visibleIds = active.filter(o => !hiddenIds.includes(o.id)).map(o => o.id);

  // スライダーは点数そのものではなく段の番号を動かす。
  // 3→5→7… と飛び飛びの値を選ばせるため。
  const stepIndex = Math.max(
    0,
    SMOOTH_WINDOWS.findIndex(w => w === smoothWindow)
  );

  return (
    <>
      <div className="axis-row">
        <span className="axis-row__label">縦軸</span>
        <div className="chips">
          {Y_AXES.map(a => (
            <button
              key={a.key}
              className={`chip ${yKey === a.key ? 'is-active' : ''}`}
              onClick={() => onChangeY(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="axis-row">
        <span className="axis-row__label">横軸</span>
        <div className="chips">
          {X_AXES.map(a => (
            <button
              key={a.key}
              className={`chip ${xKey === a.key ? 'is-active' : ''}`}
              onClick={() => onChangeX(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* 定番の組み合わせは 1 タップで */}
      <div className="chips">
        {PRESETS.map(p => (
          <button
            key={p.label}
            className={`chip ${xKey === p.x && yKey === p.y ? 'is-active' : ''}`}
            style={{ minHeight: 30, padding: '3px 10px', fontSize: '0.71rem' }}
            onClick={() => { onChangeX(p.x); onChangeY(p.y); }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 表示だけの平滑化。位置を均し、速度もその位置から取り直す */}
      <div className="axis-row">
        <span className="axis-row__label">平滑化</span>
        <div
          className="chips"
          style={{ alignItems: 'center', gap: '8px', flex: 1 }}
        >
          <button
            className={`chip ${smooth ? 'is-active' : ''}`}
            onClick={() => onChangeSmooth(!smooth)}
            title="位置 x, y を 2 次 Savitzky-Golay で均して表示します。速度も均した位置から計算し直します。CSV には影響しません"
          >
            {smooth ? 'ON' : 'OFF'}
          </button>

          {smooth && (
            <>
              <input
                type="range"
                min={0}
                max={SMOOTH_WINDOWS.length - 1}
                step={1}
                value={stepIndex}
                onChange={e =>
                  onChangeSmoothWindow(SMOOTH_WINDOWS[parseInt(e.target.value)])
                }
                style={{ flex: 1, minWidth: 80, maxWidth: 180 }}
                title="窓を広げるほど滑らかになりますが、本物のピークも鈍ります"
              />
              <span
                className="mono"
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {smoothWindow} 点
              </span>
            </>
          )}
        </div>
      </div>

      <MotionGraph
        objects={objects}
        data={data}
        unit={unit}
        xKey={xKey}
        yKey={yKey}
        visibleIds={visibleIds}
        height={height}
        onSeek={onSeek}
      />

      {active.length > 1 && (
        <div className="legend">
          {active.map(o => {
            const off = hiddenIds.includes(o.id);
            return (
              <button
                key={o.id}
                className={`legend__item ${off ? 'is-off' : ''}`}
                onClick={() => onToggleId(o.id)}
              >
                <span className="legend__line" style={{ background: o.color }} />
                {o.id}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
};
