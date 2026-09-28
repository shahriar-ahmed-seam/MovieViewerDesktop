import React, { useEffect, useState } from 'react';
import type { BinaryDiagnostics } from '../../shared/types';
import type { SubtitleOption, SubtitleStatusInfo } from './TrackSelector';
import { SubtitleTrackStore } from '../subtitles/SubtitleTrackStore';

interface SubtitleDebugHudProps {
  store: SubtitleTrackStore | null;
  option: SubtitleOption | null;
  status: SubtitleStatusInfo;
  getMediaTimeMs: () => number;
  delayMs: number;
  binaryDiagnostics: BinaryDiagnostics | null;
  onTestOverlay: () => void;
  onLoadLocal: () => void;
}

function fmt(ms: number): string {
  const s = Math.max(0, ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Compact developer HUD for the subtitle pipeline. Refreshes itself 4x per second so the
 * player page does not re-render every animation frame.
 */
export const SubtitleDebugHud: React.FC<SubtitleDebugHudProps> = ({
  store, option, status, getMediaTimeMs, delayMs, binaryDiagnostics, onTestOverlay, onLoadLocal
}) => {
  const [, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const now = getMediaTimeMs() - delayMs;
  let active = 'none';
  if (store) {
    if (store.kind === 'text') {
      const cues = store.activeCues(now);
      if (cues.length) active = cues.map(c => c.text.replace(/\n/g, ' / ')).join(' | ');
    } else {
      const p = store.activeBitmap(now);
      if (p) active = `bitmap @ ${fmt(p.startMs)}${p.endMs ? ` → ${fmt(p.endMs)}` : ''}`;
    }
  }
  const color = status.state === 'ready' ? '#4ADE80' : status.state === 'loading' ? '#38BDF8' : status.state === 'off' ? '#94A3B8' : '#F87171';

  return (
    <div
      id="subtitle-debug-hud"
      style={{
        position: 'absolute', top: 64, left: 16, zIndex: 1250, maxWidth: 460,
        background: 'rgba(10, 15, 29, 0.9)', border: `1px solid ${color}`, borderRadius: 8,
        padding: '8px 10px', color: '#E2E8F0', font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'auto'
      }}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <strong style={{ color }}>SUBS: {status.state.toUpperCase()}</strong>
        <span>{fmt(now)}</span>
        <button onClick={() => setCollapsed(c => !c)} style={{ background: 'transparent', color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
          {collapsed ? 'more' : 'less'}
        </button>
      </div>
      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Active: {active}</div>
      {!collapsed && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div>Track: {option?.label || 'none'}{option?.streamIndex !== undefined ? ` (#${option.streamIndex})` : ''}</div>
          <div>Kind: {store?.kind || '-'} / {store?.header?.codecId || option?.codecName || '-'}</div>
          <div>Method: {store?.method || '-'} | items: {store?.itemCount ?? 0}</div>
          <div>Status: {status.message || '-'}{status.detail ? ` (${status.detail})` : ''}</div>
          <div>Delay: {delayMs} ms</div>
          <div>ffmpeg: {binaryDiagnostics?.ffmpeg?.available ? binaryDiagnostics.ffmpeg.path : 'NOT FOUND'}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button className="btn btn-surface" style={{ fontSize: 10, padding: '2px 8px' }} onClick={onTestOverlay}>Test overlay</button>
            <button className="btn btn-surface" style={{ fontSize: 10, padding: '2px 8px' }} onClick={onLoadLocal}>Load file…</button>
          </div>
        </div>
      )}
    </div>
  );
};
