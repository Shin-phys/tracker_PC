// src/components/Header.tsx
import React from 'react';
import { Target, Activity, CheckCircle2, Loader2, Cpu, AlertTriangle } from 'lucide-react';
import { FpsSettings } from '../types';

interface HeaderProps {
  isOpenCVReady: boolean;
  cvError?: string | null;
  activeCount: number;
  totalDataCount: number;
  fpsSettings: FpsSettings;
}

export const Header: React.FC<HeaderProps> = ({
  isOpenCVReady,
  cvError,
  activeCount,
  totalDataCount,
  fpsSettings,
}) => {
  return (
    <header
      className="glass-panel"
      style={{ padding: '14px 24px', margin: '16px 20px 0 20px', borderRadius: '14px' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        {/* タイトル */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(99, 102, 241, 0.45)',
              flexShrink: 0,
            }}
          >
            <Target size={24} color="#ffffff" />
          </div>
          <div>
            <h1
              style={{
                fontSize: '1.22rem',
                fontWeight: 700,
                letterSpacing: '-0.025em',
                background: 'linear-gradient(90deg, #f0f4ff 0%, #a5b4fc 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                lineHeight: 1.2,
              }}
            >
              MotionTrace Pro
            </h1>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
              OpenCV.js マルチオブジェクト追跡 &amp; 運動解析 Ver.2.1
            </p>
          </div>
        </div>

        {/* ステータス インジケーター */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' }}>
          {/* OpenCV.js ステータス */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
            <Cpu size={14} color="var(--text-secondary)" />
            <span style={{ color: 'var(--text-secondary)' }}>OpenCV.js:</span>
            {cvError ? (
              <span
                className="badge"
                title={cvError}
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                }}
              >
                <AlertTriangle size={12} style={{ marginRight: '4px' }} />
                読み込み失敗
              </span>
            ) : isOpenCVReady ? (
              <span
                className="badge"
                style={{
                  background: 'rgba(16, 217, 124, 0.12)',
                  color: '#10d97c',
                  border: '1px solid rgba(16, 217, 124, 0.3)',
                }}
              >
                <CheckCircle2 size={12} style={{ marginRight: '4px' }} />
                Ready
              </span>
            ) : (
              <span
                className="badge"
                style={{
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: '#f59e0b',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                }}
              >
                <Loader2 size={12} className="spin" style={{ marginRight: '4px' }} />
                Loading Wasm...
              </span>
            )}
          </div>

          {/* 追跡オブジェクト数 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>追跡:</span>
            <span
              className="badge mono"
              style={{
                background: 'rgba(99, 102, 241, 0.15)',
                color: '#818cf8',
                border: '1px solid rgba(99, 102, 241, 0.3)',
              }}
            >
              {activeCount} / 5 obj
            </span>
          </div>

          {/* FPS 表示 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>FPS:</span>
            <span
              className="badge mono"
              style={{
                background:
                  fpsSettings.source === 'auto'
                    ? 'rgba(16, 217, 124, 0.12)'
                    : 'rgba(255, 255, 255, 0.07)',
                color:
                  fpsSettings.source === 'auto' ? '#10d97c' : 'var(--text-primary)',
                border:
                  fpsSettings.source === 'auto'
                    ? '1px solid rgba(16, 217, 124, 0.3)'
                    : '1px solid var(--border-color)',
              }}
            >
              {fpsSettings.value.toFixed(2)} {fpsSettings.source === 'auto' ? '(auto)' : '(manual)'}
            </span>
          </div>

          {/* 記録フレーム数 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
            <Activity size={14} color="var(--text-secondary)" />
            <span style={{ color: 'var(--text-secondary)' }}>記録:</span>
            <span
              className="badge mono"
              style={{
                background: 'rgba(255, 255, 255, 0.07)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
              }}
            >
              {totalDataCount} pts
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
