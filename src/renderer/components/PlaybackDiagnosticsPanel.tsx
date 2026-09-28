import React from 'react';
import { PlaybackDiagnosticsState } from '../../shared/types';
import { formatTimeMs } from '../types/media';

interface PlaybackDiagnosticsPanelProps {
  diagnostics: PlaybackDiagnosticsState;
  isOpen: boolean;
  onClose: () => void;
}

export function sanitizeDisplayUrl(rawUrl: string): string {
  if (!rawUrl) return 'None';
  try {
    const parsed = new URL(rawUrl);
    // Remove sensitive query parameters (token, auth, key, password, secret)
    const sensitiveKeys = ['token', 'auth', 'key', 'password', 'secret', 'sig', 'signature', 'access_token'];
    sensitiveKeys.forEach(k => parsed.searchParams.delete(k));

    // Hide user credentials in URL
    parsed.username = '';
    parsed.password = '';

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const fileName = pathParts[pathParts.length - 1] || '';
    const safeHost = parsed.host;

    return `${parsed.protocol}//${safeHost}/.../${decodeURIComponent(fileName)}`;
  } catch {
    // If local file path, sanitize user directory
    const parts = rawUrl.split('/');
    const fileName = parts[parts.length - 1] || rawUrl;
    return `file://.../${fileName}`;
  }
}

export const PlaybackDiagnosticsPanel: React.FC<PlaybackDiagnosticsPanelProps> = ({
  diagnostics,
  isOpen,
  onClose
}) => {
  if (!isOpen) return null;

  const {
    sanitizedUrl,
    container,
    duration,
    videoStreams,
    audioStreams,
    subtitleStreams,
    selectedAudioStreamIndex,
    selectedSubtitleStreamIndex,
    selectedAudioLabel,
    selectedSubtitleLabel,
    subtitleExtractionStatus,
    subtitleError,
    totalCues,
    activeCues,
    currentTime,
    bufferedEnd,
    bufferedPercent,
    playbackState,
    mediaError,
    lastActionMessage,
    subtitlePipelineDiagnostics
  } = diagnostics;

  return (
    <div
      style={{
        position: 'absolute',
        top: '64px',
        right: '24px',
        width: '420px',
        maxHeight: 'calc(100vh - 140px)',
        backgroundColor: 'rgba(15, 18, 26, 0.94)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: '12px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.65)',
        zIndex: 1600,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: '12px',
        color: '#E0E6ED',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: 'rgba(255, 255, 255, 0.04)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: mediaError ? '#FF5370' : '#C3E88D' }} />
          <span style={{ fontWeight: 700, fontSize: '13px', color: '#FFFFFF', letterSpacing: '0.3px' }}>
            Playback Diagnostics
          </span>
          <span style={{ fontSize: '10px', background: 'rgba(195, 232, 141, 0.15)', color: '#C3E88D', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
            DEV
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#89DDFF',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
            padding: '2px 6px'
          }}
          title="Close Diagnostics (Ctrl+Shift+D)"
        >
          ✕
        </button>
      </div>

      {/* Scrollable Content */}
      <div style={{ padding: '14px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        
        {/* Media & Container Info */}
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
            Container & Target URL
          </div>
          <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '11px', color: '#EEFFFF' }}>
              {sanitizedUrl}
            </div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '6px', color: '#B2CCD6', fontSize: '11px' }}>
              <span>Container: <strong style={{ color: '#F78C6C' }}>{container || 'Detecting...'}</strong></span>
              <span>Duration: <strong style={{ color: '#F78C6C' }}>{duration ? `${duration.toFixed(1)}s (${formatTimeMs(duration * 1000)})` : 'N/A'}</strong></span>
            </div>
          </div>
        </div>

        {/* Playback Pipeline Status */}
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
            Pipeline & Buffer State
          </div>
          <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <div>State: <strong style={{ color: playbackState === 'playing' ? '#C3E88D' : '#FFCB6B' }}>{playbackState.toUpperCase()}</strong></div>
              <div>Buffer: <strong style={{ color: '#89DDFF' }}>{bufferedPercent.toFixed(1)}% ({bufferedEnd.toFixed(1)}s)</strong></div>
              <div>Position: <strong>{currentTime.toFixed(1)}s</strong></div>
              <div>Error: <strong style={{ color: mediaError ? '#FF5370' : '#C3E88D' }}>{mediaError ? 'FAILED' : 'NONE'}</strong></div>
            </div>
            {mediaError && (
              <div style={{ marginTop: '6px', color: '#FF5370', fontSize: '11px', wordBreak: 'break-word' }}>
                {mediaError}
              </div>
            )}
          </div>
        </div>

        {/* Selected Audio & Subtitle */}
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
            Selected Active Streams
          </div>
          <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <div style={{ marginBottom: '4px' }}>
              Audio: <strong style={{ color: '#C792EA' }}>#{selectedAudioStreamIndex ?? 'N/A'} - {selectedAudioLabel || 'Default'}</strong>
            </div>
            <div>
              Subtitle: <strong style={{ color: '#C792EA' }}>#{selectedSubtitleStreamIndex ?? 'N/A'} - {selectedSubtitleLabel || 'Off'}</strong>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: '11px', color: '#B2CCD6' }}>
              <span>Status: <strong style={{ color: subtitleExtractionStatus === 'ready' ? '#C3E88D' : (subtitleExtractionStatus === 'extracting' ? '#89DDFF' : '#FFCB6B') }}>{subtitleExtractionStatus.toUpperCase()}</strong></span>
              <span>Loaded Cues: <strong style={{ color: '#89DDFF' }}>{totalCues}</strong></span>
            </div>
            {subtitleError && (
              <div style={{ marginTop: '4px', color: '#FF5370', fontSize: '11px' }}>
                {subtitleError}
              </div>
            )}
          </div>
        </div>

        {/* Subtitle Pipeline Diagnostics */}
        {subtitlePipelineDiagnostics && (
          <div>
            <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
              Subtitle Pipeline Diagnostics
            </div>
            <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div>
                Stage: <strong style={{ color: subtitlePipelineDiagnostics.pipelineStage === 'actively_rendering' ? '#C3E88D' : (subtitlePipelineDiagnostics.pipelineStage === 'extraction_failed' ? '#FF5370' : '#FFCB6B') }}>
                  {subtitlePipelineDiagnostics.pipelineStage.toUpperCase()}
                </strong>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
                <div>Stream: <strong style={{ color: '#89DDFF' }}>#{subtitlePipelineDiagnostics.streamIndex ?? 'N/A'}</strong></div>
                <div>Codec: <strong style={{ color: '#FFCB6B' }}>{subtitlePipelineDiagnostics.codec || 'N/A'}</strong></div>
                <div>Kind: <strong style={{ color: subtitlePipelineDiagnostics.isBitmap ? '#FF5370' : '#C3E88D' }}>{subtitlePipelineDiagnostics.isBitmap ? 'BITMAP' : 'TEXT'}</strong></div>
                <div>Exit Code: <strong style={{ color: subtitlePipelineDiagnostics.ffmpegExitCode === 0 ? '#C3E88D' : (subtitlePipelineDiagnostics.ffmpegExitCode !== null ? '#FF5370' : '#89DDFF') }}>{subtitlePipelineDiagnostics.ffmpegExitCode ?? 'N/A'}</strong></div>
                <div>Extracted Chars: <strong>{subtitlePipelineDiagnostics.extractedCharCount}</strong></div>
                <div>Extracted Cues: <strong>{subtitlePipelineDiagnostics.extractedCueCount}</strong></div>
              </div>
              <div style={{ fontSize: '11px' }}>
                <div>ffprobe: <span style={{ color: subtitlePipelineDiagnostics.ffprobeInfo?.available ? '#C3E88D' : '#FF5370' }}>{subtitlePipelineDiagnostics.ffprobeInfo?.available ? 'Available' : 'Missing'}</span> ({subtitlePipelineDiagnostics.ffprobeInfo?.path || 'none'})</div>
                <div>ffmpeg: <span style={{ color: subtitlePipelineDiagnostics.ffmpegInfo?.available ? '#C3E88D' : '#FF5370' }}>{subtitlePipelineDiagnostics.ffmpegInfo?.available ? 'Available' : 'Missing'}</span> ({subtitlePipelineDiagnostics.ffmpegInfo?.path || 'none'})</div>
              </div>
              {subtitlePipelineDiagnostics.firstCuePreview && (
                <div style={{ fontSize: '10px', color: '#B2CCD6', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '4px' }}>
                  First Cue: <span style={{ color: '#EEFFFF' }}>{subtitlePipelineDiagnostics.firstCuePreview}</span>
                </div>
              )}
              {subtitlePipelineDiagnostics.ffmpegStderr && (
                <div style={{ fontSize: '10px', color: '#B2CCD6', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '4px' }}>
                  Stderr: <div style={{ maxHeight: '48px', overflowY: 'auto', background: 'rgba(0,0,0,0.4)', padding: '2px 4px', borderRadius: '3px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{subtitlePipelineDiagnostics.ffmpegStderr}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Live Active Cues */}
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
            Live Active Cue(s) ({activeCues.length})
          </div>
          <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)', minHeight: '48px' }}>
            {activeCues.length === 0 ? (
              <span style={{ color: '#546E7A', fontStyle: 'italic' }}>No cues active at current timestamp</span>
            ) : (
              activeCues.map((c, i) => (
                <div key={c.id || i} style={{ borderBottom: i < activeCues.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none', paddingBottom: '4px', marginBottom: '4px' }}>
                  <div style={{ fontSize: '10px', color: '#FFCB6B', fontFamily: 'monospace' }}>
                    [{formatTimeMs(c.startMs)} → {formatTimeMs(c.endMs)}]
                  </div>
                  <div style={{ color: '#FFFFFF', whiteSpace: 'pre-line', marginTop: '2px', fontWeight: 500 }}>
                    {c.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ffprobe Stream Directory */}
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '6px' }}>
            ffprobe Discovered Streams ({videoStreams.length + audioStreams.length + subtitleStreams.length})
          </div>
          <div style={{ background: 'rgba(0, 0, 0, 0.35)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.06)', maxHeight: '160px', overflowY: 'auto' }}>
            {videoStreams.map(v => (
              <div key={`v-${v.streamIndex}`} style={{ padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: '6px' }}>
                <span style={{ color: '#F78C6C', fontWeight: 700 }}>#{v.streamIndex}</span>
                <span style={{ color: '#89DDFF' }}>[VIDEO]</span>
                <span>{v.codec} {v.width ? `${v.width}x${v.height}` : ''} {v.fps ? `@ ${v.fps}fps` : ''}</span>
              </div>
            ))}
            {audioStreams.map(a => (
              <div key={`a-${a.streamIndex}`} style={{ padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: '6px' }}>
                <span style={{ color: '#C792EA', fontWeight: 700 }}>#{a.streamIndex}</span>
                <span style={{ color: '#C3E88D' }}>[AUDIO]</span>
                <span>{a.codec} {a.channels}ch ({a.language.toUpperCase()}) {a.isDefault ? '[Def]' : ''}</span>
              </div>
            ))}
            {subtitleStreams.map(s => (
              <div key={`s-${s.streamIndex}`} style={{ padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: '6px' }}>
                <span style={{ color: '#FFCB6B', fontWeight: 700 }}>#{s.streamIndex}</span>
                <span style={{ color: s.kind === 'bitmap' ? '#FF5370' : '#89DDFF' }}>[{s.kind.toUpperCase()}]</span>
                <span>{s.codec} ({s.language.toUpperCase()}) {s.title || ''}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Action & Cancellation Log */}
        {lastActionMessage && (
          <div>
            <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#82AAFF', fontWeight: 700, marginBottom: '4px' }}>
              Pipeline Event Log
            </div>
            <div style={{ background: 'rgba(0, 0, 0, 0.45)', padding: '6px 8px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '11px', color: '#89DDFF' }}>
              {lastActionMessage}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
