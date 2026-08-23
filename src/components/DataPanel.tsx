// src/components/DataPanel.tsx — Ver.2.1
// 改修点:
//   1. 平滑化後の速度を「中心差分」で算出（前方差分より 1/2 フレーム分の
//      位相ずれがなく、ノイズにも強い）
//   2. vx / vy を個別に保持・出力（等加速度運動の解析がしやすい）
//   3. マッチングスコアを出力し、追跡の信頼度を後から検証できるようにした
//   4. 未校正時は px 単位でそのまま扱う
//   5. グラフ概形モードを追加。平滑化後（＝CSV に出るのと同じ）の値を描く

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TrackedObject, FrameData, FilterSettings, ScaleCalibration, FpsSettings,
} from '../types';
import { timeScale, isTimeScaled, toFileTime } from '../utils/timeScale';
import {
  applySavitzkyGolay, sgWindowSeconds, recommendSgWindow, SG_WINDOW_WARN_SEC,
} from '../utils/savitzkyGolay';
import { autoFilter, butterworthZeroPhase, derivative, medianDt } from '../utils/butterworth';
import { isCalibrated } from '../utils/calibration';
import { smoothSeries } from '../utils/graphSmooth';
import {
  TimeRange, clipToRange, hasRange, MIN_RANGE_POINTS,
} from '../utils/timeRange';
import { GraphPanel } from './GraphPanel';
import { AxisKey } from './MotionGraph';
import {
  Download, Sliders, Activity, ArrowRightLeft, ChevronDown, ChevronUp,
  LineChart, Maximize2, X, Scissors,
} from 'lucide-react';

interface DataPanelProps {
  objects: TrackedObject[];
  historyData: FrameData[];
  /** 解析区間。ここで絞られたデータだけがグラフ・フィルタ・CSV に入る */
  timeRange: TimeRange;
  filterSettings: FilterSettings;
  onUpdateFilterSettings: (settings: FilterSettings) => void;
  calibration: ScaleCalibration;
  /** 時間軸の換算（スロー動画対応）に使う */
  fpsSettings: FpsSettings;

  // ---- グラフ概形 ----
  // 軸の選択と非表示オブジェクトは App 側で保持する。
  // パネルが再マウントされても選んだ組み合わせを失わないため。
  graphX: AxisKey;
  graphY: AxisKey;
  onChangeGraphX: (k: AxisKey) => void;
  onChangeGraphY: (k: AxisKey) => void;
  hiddenGraphIds: string[];
  onToggleGraphId: (id: string) => void;
  /** グラフ上をクリックしたとき、その時刻へ動画を移動させる */
  onSeek?: (t: number) => void;

  /** グラフ表示だけにかける追加の平滑化（CSV には影響しない） */
  graphSmooth: boolean;
  graphSmoothWindow: number;
  onChangeGraphSmooth: (on: boolean) => void;
  onChangeGraphSmoothWindow: (w: number) => void;
}

export const DataPanel: React.FC<DataPanelProps> = ({
  objects,
  historyData: historyDataAll,
  timeRange,
  filterSettings,
  onUpdateFilterSettings,
  calibration,
  fpsSettings,
  graphX, graphY, onChangeGraphX, onChangeGraphY,
  hiddenGraphIds, onToggleGraphId, onSeek,
  graphSmooth, graphSmoothWindow, onChangeGraphSmooth, onChangeGraphSmoothWindow,
}) => {
  /**
   * 区間で絞ったデータ。以降の処理はすべてこちらを見る。
   *
   * 記録側でも区間外は弾いているので、通常はここで減らない。
   * 効くのは「一度記録したあとで区間を狭めた」場合で、
   * そのときは取り直さずにグラフ・フィルタ・CSV が新しい区間に追随する。
   * 記録そのものは残っているので、区間を広げれば戻る（非破壊）。
   */
  const historyData = useMemo(
    () => clipToRange(historyDataAll, timeRange),
    [historyDataAll, timeRange]
  );
  /** 区間で切り落とされたフレーム数（UI の説明に使う） */
  const clippedCount = historyDataAll.length - historyData.length;
  /** 点数が少なすぎると Butterworth の自動遮断周波数の選択が不安定になる */
  const tooFewInRange =
    hasRange(timeRange) && historyData.length > 0 && historyData.length < MIN_RANGE_POINTS;

  const activeObjects = useMemo(() => objects.filter(o => o.active), [objects]);
  const [showFilterSettings, setShowFilterSettings] = useState(false);
  /** グラフを全画面で見る（形の判断は大きいほうが確実） */
  const [graphFull, setGraphFull] = useState(false);

  // 全画面グラフは Esc で閉じる（マウスを閉じるボタンまで運ばずに済む）
  useEffect(() => {
    if (!graphFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGraphFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [graphFull]);

  /** 未校正なら px 表記にフォールバック（plane モードは pxPerUnit を使わない） */
  const unitLabel = isCalibrated(calibration) ? calibration.unit : 'px';

  // -------------------------------------------------
  // Savitzky-Golay フィルタ適用
  // -------------------------------------------------

  const { processedData, report } = useMemo(() => {
    const cutoffs: { [id: string]: number } = {};
    if (historyData.length === 0) {
      return { processedData: historyData, report: { cutoffs, sampleRate: 0 } };
    }

    // 深コピー（フィルタ OFF でも速度は中心差分で計算し直す）
    //
    // ここで時刻を実時間へ換算する。historyData 側は「ファイル上の時刻」の
    // ままにしてあるので、撮影fps を後から直しても追跡をやり直さずに済む。
    // 換算はこの 1 箇所だけ。以降の速度・フィルタ・グラフ・CSV は
    // すべてこの copyData の時刻を見るので、自動的に実時間になる。
    const scale = timeScale(fpsSettings);
    const copyData: FrameData[] = historyData.map(fd => ({
      frameIndex: fd.frameIndex,
      timestamp: fd.timestamp * scale,
      objects: Object.fromEntries(
        Object.entries(fd.objects).map(([k, v]) => [k, { ...v }])
      ),
      distances: { ...fd.distances },
    }));

    const dtAll = medianDt(copyData.map(f => f.timestamp));
    const sampleRate = dtAll > 0 ? 1 / dtAll : 0;

    activeObjects.forEach(obj => {
      // このオブジェクトが記録されているフレームだけを抜き出して処理する
      const idx: number[] = [];
      for (let i = 0; i < copyData.length; i++) {
        if (copyData[i].objects[obj.id]) idx.push(i);
      }
      if (idx.length === 0) return;

      const rawX = idx.map(i => copyData[i].objects[obj.id].xM);
      const rawY = idx.map(i => copyData[i].objects[obj.id].yM);
      const t = idx.map(i => copyData[i].timestamp);
      const dt = medianDt(t);

      let sx = rawX;
      let sy = rawY;

      if (filterSettings.enabled && filterSettings.kind === 'butterworth' && dt > 0) {
        // Kinovea と同じ方式。X と Y で別々に最適な遮断周波数を選び、
        // 表示にはその平均を使う（座標軸ごとにノイズ特性が違うことがある）
        if (filterSettings.autoCutoff) {
          const rx = autoFilter(rawX, dt);
          const ry = autoFilter(rawY, dt);
          sx = rx.values;
          sy = ry.values;
          cutoffs[obj.id] = (rx.cutoff + ry.cutoff) / 2;
        } else {
          sx = butterworthZeroPhase(rawX, dt, filterSettings.cutoffHz);
          sy = butterworthZeroPhase(rawY, dt, filterSettings.cutoffHz);
          cutoffs[obj.id] = filterSettings.cutoffHz;
        }
      } else if (filterSettings.enabled && filterSettings.kind === 'savgol') {
        sx = applySavitzkyGolay(rawX, filterSettings.windowSize, filterSettings.polynomialOrder);
        sy = applySavitzkyGolay(rawY, filterSettings.windowSize, filterSettings.polynomialOrder);
      }

      // --- 中心差分による速度 ---
      const vxs = derivative(sx, t);
      const vys = derivative(sy, t);

      for (let k = 0; k < idx.length; k++) {
        const item = copyData[idx[k]].objects[obj.id];
        item.xM = sx[k];
        item.yM = sy[k];
        item.vx = vxs[k];
        item.vy = vys[k];
        item.speedMs = Math.hypot(vxs[k], vys[k]);
      }
    });

    // 物体間距離を再計算（平滑化後の座標で）
    copyData.forEach(fd => {
      for (let i = 0; i < activeObjects.length; i++) {
        for (let j = i + 1; j < activeObjects.length; j++) {
          const idA = activeObjects[i].id;
          const idB = activeObjects[j].id;
          const a = fd.objects[idA];
          const b = fd.objects[idB];
          if (a && b && !a.lost && !b.lost) {
            fd.distances[`${idA}-${idB}`] = Math.hypot(a.xM - b.xM, a.yM - b.yM);
          }
        }
      }
    });

    return { processedData: copyData, report: { cutoffs, sampleRate } };
  }, [historyData, filterSettings, activeObjects, fpsSettings]);

  /**
   * グラフのクリックから動画へシークするときは、実時間 → ファイル上の時刻へ
   * 戻す必要がある。ここを忘れるとスロー動画で 8 倍ずれた位置へ飛ぶ。
   */
  const handleGraphSeek = useCallback(
    (t: number) => { onSeek?.(toFileTime(t, fpsSettings)); },
    [onSeek, fpsSettings]
  );

  /** 記録されている実時間の長さ（換算が効いているかの確認用） */
  const realSpan = processedData.length > 1
    ? processedData[processedData.length - 1].timestamp - processedData[0].timestamp
    : 0;

  // -------------------------------------------------
  // グラフ表示用の追加平滑化
  // -------------------------------------------------
  //
  // 位置 x, y を移動平均で均し、速度は「均した位置」から中心差分で取り直す。
  // 速度をそのまま平均すると、位置と速度が別々の量になってしまい
  // 「この x-t の傾きがこの vx-t」という対応が崩れる。
  //
  // 平滑化するのはグラフに渡すデータだけで、
  // processedData（CSV とリアルタイム表示の元）には手を触れない。

  const graphData = useMemo(() => {
    if (!graphSmooth || graphSmoothWindow < 5 || processedData.length === 0) {
      return processedData;
    }

    const copy: FrameData[] = processedData.map(fd => ({
      frameIndex: fd.frameIndex,
      timestamp: fd.timestamp,
      objects: Object.fromEntries(
        Object.entries(fd.objects).map(([k, v]) => [k, { ...v }])
      ),
      distances: { ...fd.distances },
    }));

    activeObjects.forEach(obj => {
      // 見失った区間をまたいで平均すると、追跡が飛んだ事実が均されて消える。
      // 連続して追跡できているフレームの塊ごとに処理する。
      let run: number[] = [];

      const flush = () => {
        // 窓より短い塊は smoothSeries が素通しするので、そのまま渡してよい
        if (run.length >= 3) {
          const t = run.map(i => copy[i].timestamp);
          const sx = smoothSeries(
            run.map(i => copy[i].objects[obj.id].xM), graphSmoothWindow
          );
          const sy = smoothSeries(
            run.map(i => copy[i].objects[obj.id].yM), graphSmoothWindow
          );
          const vxs = derivative(sx, t);
          const vys = derivative(sy, t);
          run.forEach((fi, k) => {
            const it = copy[fi].objects[obj.id];
            it.xM = sx[k];
            it.yM = sy[k];
            it.vx = vxs[k];
            it.vy = vys[k];
            it.speedMs = Math.hypot(vxs[k], vys[k]);
          });
        }
        run = [];
      };

      for (let i = 0; i < copy.length; i++) {
        const it = copy[i].objects[obj.id];
        if (it && !it.lost) run.push(i);
        else flush();
      }
      flush();
    });

    return copy;
  }, [processedData, graphSmooth, graphSmoothWindow, activeObjects]);

  // 最新フレームデータ
  const latestFrame = processedData.length > 0
    ? processedData[processedData.length - 1]
    : null;

  // -------------------------------------------------
  // CSV エクスポート
  // -------------------------------------------------

  const downloadCSV = () => {
    if (processedData.length === 0) return;

    // 動的ヘッダー生成
    const headers: string[] = ['Timestamp(s)'];

    const u = isCalibrated(calibration) ? calibration.unit : 'px';

    activeObjects.forEach(obj => {
      headers.push(
        `${obj.id}_X(px)`,
        `${obj.id}_Y(px)`,
        `${obj.id}_X(${u})`,
        `${obj.id}_Y(${u})`,
        `${obj.id}_Vx(${u}/s)`,
        `${obj.id}_Vy(${u}/s)`,
        `${obj.id}_Speed(${u}/s)`,
        `${obj.id}_Score`,
        `${obj.id}_Lost`,
        `${obj.id}_Manual`,
      );
    });

    // 物体間距離ペア
    for (let i = 0; i < activeObjects.length; i++) {
      for (let j = i + 1; j < activeObjects.length; j++) {
        headers.push(
          `Dist_${activeObjects[i].id}_${activeObjects[j].id}(${u})`
        );
      }
    }

    // 行データ生成
    const csvRows: string[] = [headers.join(',')];

    processedData.forEach(fd => {
      const row: (string | number)[] = [fd.timestamp.toFixed(6)];

      activeObjects.forEach(obj => {
        const item = fd.objects[obj.id];
        if (item) {
          row.push(
            item.xPx.toFixed(3),
            item.yPx.toFixed(3),
            item.xM.toFixed(6),
            item.yM.toFixed(6),
            item.vx.toFixed(6),
            item.vy.toFixed(6),
            item.speedMs.toFixed(6),
            item.score.toFixed(3),
            item.lost ? '1' : '0',
            item.manual ? '1' : '0',
          );
        } else {
          row.push('', '', '', '', '', '', '', '', '', '');
        }
      });

      // 物体間距離
      for (let i = 0; i < activeObjects.length; i++) {
        for (let j = i + 1; j < activeObjects.length; j++) {
          const key = `${activeObjects[i].id}-${activeObjects[j].id}`;
          const dist = fd.distances[key];
          row.push(dist !== undefined ? dist.toFixed(5) : '');
        }
      }

      csvRows.push(row.join(','));
    });

    // BOM 付き UTF-8 (Excel で文字化けしないように)
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `motion_trace_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // -------------------------------------------------
  // レンダリング
  // -------------------------------------------------

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ========================================
          0. 解析区間の状態
          区間が効いているのに気づかないまま数値を読む、という事故を防ぐ。
          ======================================== */}
      {hasRange(timeRange) && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: '8px',
            padding: '9px 12px', borderRadius: '8px', lineHeight: 1.6,
            fontSize: '0.76rem',
            background: tooFewInRange ? 'rgba(245,158,11,0.10)' : 'rgba(99,102,241,0.08)',
            border: `1px solid ${tooFewInRange ? 'rgba(245,158,11,0.4)' : 'rgba(99,102,241,0.25)'}`,
            color: 'var(--text-secondary)',
          }}
        >
          <Scissors
            size={14}
            color={tooFewInRange ? '#f59e0b' : 'var(--accent-primary)'}
            style={{ flexShrink: 0, marginTop: '3px' }}
          />
          <span>
            <b style={{ color: 'var(--text-primary)' }}>
              区間 {timeRange.start !== null ? `${timeRange.start.toFixed(3)} s` : '先頭'}
              {' 〜 '}
              {timeRange.end !== null ? `${timeRange.end.toFixed(3)} s` : '末尾'}
            </b>
            {' '}のデータだけを使っています（{historyData.length} 点
            {clippedCount > 0 && ` / 区間外 ${clippedCount} 点を除外`}）。
            {tooFewInRange && (
              <span style={{ color: '#fcd34d', fontWeight: 600 }}>
                {' '}⚠ {MIN_RANGE_POINTS} 点未満です。Butterworth の遮断周波数の自動選択が
                不安定になります。区間を広げるか、コマ送り幅を細かくしてください。
              </span>
            )}
          </span>
        </div>
      )}

      {/* ========================================
          1. グラフ概形（計測が使い物になるかの判断用）
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: '12px',
          }}
        >
          <div className="section-title">
            <LineChart size={17} color="var(--accent-primary)" />
            グラフ概形
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setGraphFull(true)}
            disabled={processedData.length === 0}
            title="全画面で見る"
          >
            <Maximize2 size={14} />
            拡大
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <GraphPanel
            objects={objects}
            data={graphData}
            unit={unitLabel}
            xKey={graphX}
            yKey={graphY}
            onChangeX={onChangeGraphX}
            onChangeY={onChangeGraphY}
            hiddenIds={hiddenGraphIds}
            onToggleId={onToggleGraphId}
            onSeek={handleGraphSeek}
            smooth={graphSmooth}
            smoothWindow={graphSmoothWindow}
            onChangeSmooth={onChangeGraphSmooth}
            onChangeSmoothWindow={onChangeGraphSmoothWindow}
            height={210}
          />
          <div
            style={{
              fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6,
              background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px',
            }}
          >
            vx-t / vy-t に鋭いスパイクが出ていたら、そこで追跡が飛んでいます。
            グラフをクリックするとその時刻へ動画が移動するので、
            映像側の「修正」ツールで点を直してください。
            {graphSmooth ? (
              <>
                {' '}
                <span style={{ color: '#fcd34d' }}>
                  いまは表示用の平滑化が入っているため、CSV に出る値とは一致しません。
                  スパイクを探すときは OFF にしてください。
                </span>
              </>
            ) : (
              ' 描いているのはフィルタ適用後の値、つまり CSV に出るのと同じ数字です。'
            )}
          </div>
        </div>
      </div>

      {/* ---- 全画面グラフ ---- */}
      {graphFull && (
        <div className="graph-full fade-in">
          <div className="graph-full__head">
            <div className="section-title" style={{ marginBottom: 0 }}>
              <LineChart size={17} color="var(--accent-primary)" />
              グラフ概形
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 400 }}>
                （{processedData.length} フレーム・単位 {unitLabel}
                {realSpan > 0 && `・実時間 ${realSpan.toFixed(3)} s`}）
              </span>
              {isTimeScaled(fpsSettings) && (
                <span style={{ fontSize: '0.72rem', color: '#fcd34d', fontWeight: 700 }}>
                  実時間 ×{timeScale(fpsSettings).toFixed(3)}
                </span>
              )}
              {graphSmooth && (
                <span style={{ fontSize: '0.72rem', color: '#fcd34d', fontWeight: 700 }}>
                  表示平滑化 {graphSmoothWindow} 点
                </span>
              )}
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setGraphFull(false)}
              title="閉じる"
            >
              <X size={16} />
              閉じる
            </button>
          </div>
          <GraphPanel
            objects={objects}
            data={graphData}
            unit={unitLabel}
            xKey={graphX}
            yKey={graphY}
            onChangeX={onChangeGraphX}
            onChangeY={onChangeGraphY}
            hiddenIds={hiddenGraphIds}
            onToggleId={onToggleGraphId}
            onSeek={handleGraphSeek}
            smooth={graphSmooth}
            smoothWindow={graphSmoothWindow}
            onChangeSmooth={onChangeGraphSmooth}
            onChangeSmoothWindow={onChangeGraphSmoothWindow}
          />
        </div>
      )}

      {/* ========================================
          2. リアルタイム運動データ
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '12px',
          }}
        >
          <div className="section-title">
            <Activity size={17} color="var(--accent-primary)" />
            リアルタイム運動データ
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            単位: {unitLabel}
          </span>
        </div>

        {activeObjects.length === 0 ? (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
            追跡オブジェクトなし
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {activeObjects.map(obj => {
              const item = latestFrame?.objects[obj.id];
              const isLost = obj.status === 'lost';
              const isExited = obj.status === 'exited';

              return (
                <div
                  key={obj.id}
                  style={{
                    background: 'var(--bg-secondary)',
                    padding: '10px 14px',
                    borderRadius: '9px',
                    borderLeft: `4px solid ${isLost ? 'var(--color-danger)' : isExited ? '#f59e0b' : obj.color}`,
                    opacity: isLost || isExited ? 0.7 : 1,
                    transition: 'opacity 0.2s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        className={`status-dot ${obj.status}`}
                        style={{
                          backgroundColor: isLost
                            ? 'var(--color-danger)'
                            : isExited
                            ? '#f59e0b'
                            : obj.status === 'tracking'
                            ? 'var(--color-success)'
                            : 'var(--text-muted)',
                        }}
                      />
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{obj.name}</span>
                      {isExited && (
                        <span style={{ fontSize: '0.68rem', color: '#fcd34d', fontWeight: 700 }}>
                          追尾終了（画面外）
                        </span>
                      )}
                    </div>
                    <span className="mono" style={{ fontSize: '0.78rem', color: '#a5b4fc' }}>
                      {item ? item.speedMs.toFixed(3) : '0.000'} {unitLabel}/s
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '6px',
                      fontSize: '0.78rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div>
                      X:{' '}
                      <span className="mono" style={{ color: 'var(--text-primary)' }}>
                        {item ? item.xM.toFixed(4) : '0.0000'}
                      </span>{' '}
                      {unitLabel}
                    </div>
                    <div>
                      Y:{' '}
                      <span className="mono" style={{ color: 'var(--text-primary)' }}>
                        {item ? item.yM.toFixed(4) : '0.0000'}
                      </span>{' '}
                      {unitLabel}
                    </div>
                    <div>
                      Xpx:{' '}
                      <span className="mono" style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                        {item ? item.xPx.toFixed(1) : '---'}
                      </span>
                    </div>
                    <div>
                      Ypx:{' '}
                      <span className="mono" style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                        {item ? item.yPx.toFixed(1) : '---'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 物体間距離 */}
        {activeObjects.length >= 2 && (
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                marginBottom: '8px',
              }}
            >
              <ArrowRightLeft size={13} />
              相対距離 (Distance)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {activeObjects.flatMap((objA, i) =>
                activeObjects.slice(i + 1).map(objB => {
                  const key = `${objA.id}-${objB.id}`;
                  const dist = latestFrame?.distances[key];
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.78rem',
                        background: 'rgba(255,255,255,0.03)',
                        padding: '6px 10px',
                        borderRadius: '7px',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            width: '8px', height: '8px',
                            borderRadius: '2px',
                            backgroundColor: objA.color,
                          }}
                        />
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {objA.id} ↔ {objB.id}
                        </span>
                      </div>
                      <span className="mono" style={{ fontWeight: 600, fontSize: '0.82rem' }}>
                        {dist !== undefined ? `${dist.toFixed(4)} ${unitLabel}` : '---'}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* ========================================
          3. 座標フィルタ設定（折りたたみ可能）
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <button
          onClick={() => setShowFilterSettings(!showFilterSettings)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            padding: 0,
          }}
        >
          <div className="section-title">
            <Sliders size={17} color="var(--accent-primary)" />
            座標フィルタ（ノイズ除去）
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* ON/OFF トグル */}
            <div
              onClick={e => {
                e.stopPropagation();
                onUpdateFilterSettings({ ...filterSettings, enabled: !filterSettings.enabled });
              }}
              style={{
                width: '36px', height: '20px', borderRadius: '10px',
                background: filterSettings.enabled ? 'var(--accent-primary)' : 'var(--text-muted)',
                position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
              }}
            >
              <div style={{
                width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
                position: 'absolute', top: '2px', left: filterSettings.enabled ? '18px' : '2px',
                transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
              }} />
            </div>
            {showFilterSettings ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
        </button>

        {/* 現在の状態を常に一行で示す */}
        {filterSettings.enabled && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '8px' }}>
            {filterSettings.kind === 'butterworth' ? (
              <>
                Butterworth 零位相
                {filterSettings.autoCutoff ? '・遮断周波数は自動選択' : `・${filterSettings.cutoffHz} Hz 固定`}
                {report.sampleRate > 0 && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {'　'}(サンプリング {report.sampleRate.toFixed(1)} Hz)
                  </span>
                )}
              </>
            ) : (
              <>Savitzky-Golay・{filterSettings.windowSize}点 {filterSettings.polynomialOrder}次</>
            )}
          </div>
        )}

        {showFilterSettings && filterSettings.enabled && (
          <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '14px' }}>

            {/* 方式の選択 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button
                className={`btn btn-sm ${filterSettings.kind === 'butterworth' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '0.74rem', justifyContent: 'center' }}
                onClick={() => onUpdateFilterSettings({ ...filterSettings, kind: 'butterworth' })}>
                Butterworth（推奨）
              </button>
              <button
                className={`btn btn-sm ${filterSettings.kind === 'savgol' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '0.74rem', justifyContent: 'center' }}
                onClick={() => onUpdateFilterSettings({ ...filterSettings, kind: 'savgol' })}>
                Savitzky-Golay
              </button>
            </div>

            {/* ---- Butterworth ---- */}
            {filterSettings.kind === 'butterworth' && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={filterSettings.autoCutoff}
                    onChange={e => onUpdateFilterSettings({ ...filterSettings, autoCutoff: e.target.checked })}
                    style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }} />
                  遮断周波数を自動で決める（推奨）
                </label>

                {filterSettings.autoCutoff ? (
                  <div style={{
                    fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.7,
                    background: 'rgba(16,217,124,0.06)', border: '1px solid rgba(16,217,124,0.2)',
                    padding: '9px 11px', borderRadius: '7px',
                  }}>
                    残差の自己相関（Durbin-Watson 統計量）が最小になる遮断周波数を、
                    0.5Hz からナイキスト周波数まで走査して自動で選びます。
                    {Object.keys(report.cutoffs).length > 0 && (
                      <div style={{ marginTop: '5px' }}>
                        {activeObjects.map(o => (
                          report.cutoffs[o.id] !== undefined ? (
                            <div key={o.id} className="mono" style={{ color: '#10d97c', fontSize: '0.74rem' }}>
                              {o.id}: {report.cutoffs[o.id].toFixed(2)} Hz
                            </div>
                          ) : null
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      <span>遮断周波数</span>
                      <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {filterSettings.cutoffHz.toFixed(1)} Hz
                      </span>
                    </div>
                    <input type="range" min={0.5}
                      max={Math.max(2, report.sampleRate > 0 ? report.sampleRate / 2 : 15)}
                      step={0.1} value={filterSettings.cutoffHz}
                      onChange={e => onUpdateFilterSettings({ ...filterSettings, cutoffHz: parseFloat(e.target.value) })}
                      style={{ width: '100%' }} />
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      低くするほど滑らかになりますが、下げすぎると本物の運動まで削られます
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ---- Savitzky-Golay ---- */}
            {filterSettings.kind === 'savgol' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.82rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>ウィンドウ幅:</span>
                  <select value={filterSettings.windowSize}
                    onChange={e => onUpdateFilterSettings({ ...filterSettings, windowSize: parseInt(e.target.value) })}
                    style={{ width: '100px' }}>
                    <option value={3}>3 pts</option>
                    <option value={5}>5 pts</option>
                    <option value={7}>7 pts</option>
                    <option value={9}>9 pts</option>
                    <option value={11}>11 pts</option>
                    <option value={15}>15 pts</option>
                  </select>
                </div>

                {/* 点数だけでは判断できない。効くかどうかは「時間として何ms均すか」で決まる */}
                {report.sampleRate > 0 && (() => {
                  const sec = sgWindowSeconds(filterSettings.windowSize, report.sampleRate);
                  const tooWide = sec > SG_WINDOW_WARN_SEC;
                  const rec = recommendSgWindow(report.sampleRate);
                  return (
                    <div style={{
                      fontSize: '0.75rem', lineHeight: 1.6, padding: '8px 10px', borderRadius: '6px',
                      background: tooWide ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${tooWide ? 'rgba(239,68,68,0.35)' : 'var(--border-color)'}`,
                      color: tooWide ? '#fca5a5' : 'var(--text-muted)',
                    }}>
                      この設定で均す時間:{' '}
                      <span className="mono" style={{ fontWeight: 700 }}>
                        {(sec * 1000).toFixed(0)} ms
                      </span>
                      （サンプリング {report.sampleRate.toFixed(1)} Hz）
                      {tooWide && (
                        <div style={{ marginTop: 4 }}>
                          長すぎます。実際の運動まで削られ、速度の誤差がかえって増えます。
                          この動画なら <b>{rec} 点</b> 相当が上限の目安です。
                          {rec <= 3 && '（＝この条件で Savitzky-Golay を使う意味は薄いということです）'}
                          {' '}Butterworth はサンプリング間隔に自動で追随するので、
                          迷う場合はそちらを使ってください。
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.82rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>多項式次数:</span>
                  <select value={filterSettings.polynomialOrder}
                    onChange={e => onUpdateFilterSettings({ ...filterSettings, polynomialOrder: parseInt(e.target.value) })}
                    style={{ width: '100px' }}>
                    <option value={2}>2次</option>
                    <option value={3}>3次</option>
                  </select>
                </div>
              </>
            )}

            <div style={{
              fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.6,
              background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px',
            }}>
              位置を微分して速度を出すとノイズが Δt で割られて増幅されます。
              微分の前に平滑化するのが定石で、合成データでは Butterworth（自動遮断）が
              どの条件でも速度の誤差を 35〜77% 減らしました（手動記録のように
              点数が少ない場合も含みます）。
              Savitzky-Golay は窓が時間として長すぎると逆効果になるため、
              迷う場合は Butterworth を選んでください。
              フィルタは画面表示と CSV 出力の両方に効きます。
            </div>
          </div>
        )}
      </div>

      {/* ========================================
          4. CSV ダウンロード
          ======================================== */}
      <div className="glass-panel" style={{ padding: '16px' }}>
        <button
          className="btn btn-primary"
          onClick={downloadCSV}
          disabled={processedData.length === 0}
          style={{ width: '100%', padding: '12px', fontSize: '0.92rem', justifyContent: 'center' }}
        >
          <Download size={18} />
          CSV ダウンロード ({processedData.length} フレーム)
        </button>

        {processedData.length > 0 && (
          <div
            style={{
              marginTop: '10px',
              fontSize: '0.74rem',
              color: 'var(--text-muted)',
              lineHeight: 1.6,
            }}
          >
            <div>
              出力列:{' '}
              {[
                'Timestamp',
                ...activeObjects.flatMap(o => [
                  `${o.id}_X(px)`, `${o.id}_Y(px)`,
                  `${o.id}_X`, `${o.id}_Y`,
                  `${o.id}_Vx`, `${o.id}_Vy`, `${o.id}_Speed`,
                  `${o.id}_Score`, `${o.id}_Lost`, `${o.id}_Manual`,
                ]),
                ...activeObjects.flatMap((oA, i) =>
                  activeObjects.slice(i + 1).map(oB => `Dist_${oA.id}_${oB.id}`)
                ),
              ].join(', ')}
            </div>
            <div style={{ marginTop: '4px', color: 'rgba(255,255,255,0.25)' }}>
              BOM付きUTF-8 / Excel対応
              {hasRange(timeRange) &&
                ` / 区間 ${timeRange.start !== null ? timeRange.start.toFixed(3) : '先頭'}〜${
                  timeRange.end !== null ? timeRange.end.toFixed(3) : '末尾'
                } s のみ`}
              {calibration.mode === 'plane' && calibration.homography && ' / 射影変換で遠近補正済み'}
              {filterSettings.enabled && ' / フィルタ適用後の値'}
              {isTimeScaled(fpsSettings) &&
                ` / 撮影 ${fpsSettings.captureFps} fps として実時間に換算済み`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
