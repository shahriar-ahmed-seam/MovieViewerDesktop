import React, { useState } from 'react';

export interface SubtitleOption {
  id: string;
  label: string;
  language?: string;
  codec?: string;
  /** Raw ffprobe codec_name for embedded streams. */
  codecName?: string;
  isExternal: boolean;
  isEmbedded?: boolean;
  /** Loaded from the user's computer. */
  isLocal?: boolean;
  trackNumber?: number;
  streamIndex?: number;
  format?: string;
  isBitmap?: boolean;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isCommentary?: boolean;
  /** Sidecar file on the media server. */
  sidecarUrl?: string;
  sidecarName?: string;
  /** VobSub .sub partner of an .idx sidecar. */
  companionUrl?: string;
  companionName?: string;
  /** How well a sidecar file name matches the playing video. */
  matchScore?: number;
  title?: string;
}

export interface SubtitleStatusInfo {
  state: 'off' | 'loading' | 'ready' | 'empty' | 'error';
  message: string | null;
  itemCount: number;
  detail: string | null;
}

export interface AudioOption {
  id: string;
  streamIndex: number; // True ffprobe container stream index
  label: string;
  language?: string;
  codec?: string;
  channels?: number;
  trackNumber?: number;
  isDefault?: boolean;
  title?: string;
}

interface TrackSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  subtitleOptions: SubtitleOption[];
  selectedSubtitleId: string | null;
  onSelectSubtitle: (id: string | null) => void;
  onLoadLocalSubtitle: () => void;
  /** Loading / error state of the selected subtitle track. */
  subtitleStatus?: SubtitleStatusInfo;
  audioOptions: AudioOption[];
  selectedAudioId: string | null;
  onSelectAudio: (id: string) => void;
  audioSwitching?: boolean;
  audioSwitchError?: string | null;
  subtitleDelayMs: number;
  onSubtitleDelayChange: (delayMs: number) => void;
  audioBoost: number;
  onAudioBoostChange: (boost: number) => void;
  onOpenExternalPlayer?: () => void;
  diagnosticsData?: any;
  onOpenDiagnostics?: () => void;
}

export const TrackSelectorModal: React.FC<TrackSelectorModalProps> = ({
  isOpen,
  onClose,
  subtitleOptions,
  selectedSubtitleId,
  onSelectSubtitle,
  onLoadLocalSubtitle,
  subtitleStatus,
  audioOptions,
  selectedAudioId,
  onSelectAudio,
  audioSwitching = false,
  audioSwitchError = null,
  subtitleDelayMs,
  onSubtitleDelayChange,
  audioBoost,
  onAudioBoostChange,
  onOpenExternalPlayer,
  diagnosticsData,
  onOpenDiagnostics
}) => {
  const [activeTab, setActiveTab] = useState<'subtitles' | 'audio' | 'diagnostics'>('subtitles');

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1600,
        animation: 'fadeIn 0.15s ease-out'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '520px',
          maxHeight: '85vh',
          backgroundColor: 'var(--dark-surface-card)',
          border: '1px solid var(--dark-outline-variant)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px 24px',
          boxShadow: '0 16px 40px rgba(0,0,0,0.8), 0 0 30px rgba(124, 77, 255, 0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn ${activeTab === 'subtitles' ? 'btn-primary' : 'btn-surface'}`}
              onClick={() => setActiveTab('subtitles')}
              style={{ fontSize: '13px' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/>
              </svg>
              Subtitles ({subtitleOptions.length})
            </button>
            <button
              className={`btn ${activeTab === 'audio' ? 'btn-primary' : 'btn-surface'}`}
              onClick={() => setActiveTab('audio')}
              style={{ fontSize: '13px' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
              Audio ({audioOptions.length > 0 ? audioOptions.length : 1})
            </button>
            <button
              className={`btn ${activeTab === 'diagnostics' ? 'btn-primary' : 'btn-surface'}`}
              onClick={() => setActiveTab('diagnostics')}
              style={{ fontSize: '13px' }}
              title="Media stream & ffprobe diagnostics"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              Diagnostics
            </button>
          </div>

          <button
            className="titlebar-btn"
            onClick={onClose}
            style={{ width: '32px', height: '32px' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tab Content: Subtitles */}
        {activeTab === 'subtitles' && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Selected track status */}
            {subtitleStatus && subtitleStatus.state !== 'off' && (
              <div
                role="status"
                style={{
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  backgroundColor: subtitleStatus.state === 'ready' ? 'rgba(34, 197, 94, 0.12)' : subtitleStatus.state === 'loading' ? 'rgba(56, 189, 248, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                  border: `1px solid ${subtitleStatus.state === 'ready' ? 'rgba(34, 197, 94, 0.4)' : subtitleStatus.state === 'loading' ? 'rgba(56, 189, 248, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                  color: subtitleStatus.state === 'ready' ? '#4ade80' : subtitleStatus.state === 'loading' ? '#38bdf8' : '#f87171'
                }}
              >
                {subtitleStatus.state === 'loading' && (
                  <div style={{ width: '14px', height: '14px', flexShrink: 0, border: '2px solid #38bdf8', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span>{subtitleStatus.message || (subtitleStatus.state === 'loading' ? 'Loading subtitles…' : 'Subtitle problem')}</span>
                  {subtitleStatus.detail && subtitleStatus.state === 'loading' && (
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>{subtitleStatus.detail}</span>
                  )}
                </div>
              </div>
            )}

            {/* Load Local Subtitle File Button */}
            <button
              className="btn btn-surface"
              onClick={onLoadLocalSubtitle}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                border: '1px dashed var(--elegant-primary)',
                color: 'var(--elegant-primary)',
                marginBottom: '4px'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
              Load Subtitle File from Computer (.srt, .ass, .vtt, .smi, .sup, .idx)...
            </button>

            {/* Off Option */}
            <div
              onClick={() => onSelectSubtitle(null)}
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: selectedSubtitleId === null ? 'var(--elegant-primary-container)' : 'var(--dark-surface-variant)',
                color: selectedSubtitleId === null ? 'var(--elegant-on-primary-container)' : 'var(--text-primary)',
                border: '1px solid',
                borderColor: selectedSubtitleId === null ? 'var(--elegant-primary)' : 'var(--dark-outline-variant)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontWeight: selectedSubtitleId === null ? 700 : 500
              }}
            >
              <span>Subtitles Off</span>
              {selectedSubtitleId === null && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              )}
            </div>

            {/* List of Available Subtitle Tracks */}
            {subtitleOptions.map((sub) => {
              const isSelected = selectedSubtitleId === sub.id;
              return (
                <div
                  key={sub.id}
                  onClick={() => onSelectSubtitle(sub.id)}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-md)',
                    background: isSelected ? 'var(--elegant-primary-container)' : 'var(--dark-surface-variant)',
                    color: isSelected ? 'var(--elegant-on-primary-container)' : 'var(--text-primary)',
                    border: '1px solid',
                    borderColor: isSelected ? 'var(--elegant-primary)' : 'var(--dark-outline-variant)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontWeight: isSelected ? 700 : 500
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                    {sub.streamIndex !== undefined && (
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(255, 255, 255, 0.12)',
                          color: '#e2e8f0',
                          fontFamily: 'monospace'
                        }}
                      >
                        #{sub.streamIndex}
                      </span>
                    )}
                    {sub.isBitmap || sub.format === 'pgs' || sub.format === 'vobsub' ? (
                      <span
                        title="Image-based subtitles (Blu-ray PGS / DVD VobSub)"
                        style={{
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(249, 115, 22, 0.25)',
                          color: '#fb923c'
                        }}
                      >
                        {sub.format === 'pgs' ? 'PGS' : sub.format === 'vobsub' || sub.format === 'idx' ? 'VobSub' : 'Image'}
                      </span>
                    ) : sub.isLocal ? (
                      <span
                        style={{
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(167, 139, 250, 0.25)',
                          color: 'var(--accent-purple)'
                        }}
                      >
                        Local
                      </span>
                    ) : sub.isExternal ? (
                      <span
                        style={{
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(167, 139, 250, 0.25)',
                          color: 'var(--accent-purple)'
                        }}
                      >
                        Sidecar
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(56, 189, 248, 0.2)',
                          color: '#38bdf8'
                        }}
                      >
                        Embedded
                      </span>
                    )}
                    <span style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub.label}>
                      {sub.label}
                    </span>
                    {(sub.isForced || sub.isCommentary) && (
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {sub.isForced ? 'forced only' : 'commentary'}
                      </span>
                    )}
                  </div>

                  {isSelected && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  )}
                </div>
              );
            })}

            {/* Subtitle Delay Adjuster */}
            {selectedSubtitleId !== null && (
              <div style={{ marginTop: '16px', borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Subtitle Sync / Delay</span>
                  <span style={{ fontWeight: 700, color: 'var(--elegant-primary)' }}>
                    {subtitleDelayMs === 0 ? '0.0s' : `${subtitleDelayMs > 0 ? '+' : ''}${(subtitleDelayMs / 1000).toFixed(1)}s`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-surface"
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onSubtitleDelayChange(subtitleDelayMs - 500)}
                    title="Show subtitles earlier"
                  >
                    -0.5s
                  </button>
                  <button
                    className="btn btn-surface"
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onSubtitleDelayChange(subtitleDelayMs - 100)}
                  >
                    -0.1s
                  </button>
                  <button
                    className="btn btn-surface"
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onSubtitleDelayChange(0)}
                  >
                    Reset
                  </button>
                  <button
                    className="btn btn-surface"
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onSubtitleDelayChange(subtitleDelayMs + 100)}
                  >
                    +0.1s
                  </button>
                  <button
                    className="btn btn-surface"
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onSubtitleDelayChange(subtitleDelayMs + 500)}
                    title="Show subtitles later"
                  >
                    +0.5s
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab Content: Audio */}
        {activeTab === 'audio' && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Audio Switching Loading Banner */}
            {audioSwitching && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'rgba(56, 189, 248, 0.15)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  color: '#38bdf8',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px'
                }}
              >
                <div
                  style={{
                    width: '14px',
                    height: '14px',
                    border: '2px solid #38bdf8',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite'
                  }}
                />
                <span>Switching audio stream via remuxer...</span>
              </div>
            )}

            {/* Audio Switch Error Banner */}
            {audioSwitchError && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  color: '#f87171',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <span>{audioSwitchError}</span>
              </div>
            )}

            {audioOptions.length > 0 ? (
              audioOptions.map((aud) => {
                const isSelected = selectedAudioId === aud.id;
                return (
                  <div
                    key={aud.id}
                    onClick={() => {
                      if (!audioSwitching) onSelectAudio(aud.id);
                    }}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 'var(--radius-md)',
                      background: isSelected ? 'var(--elegant-primary-container)' : 'var(--dark-surface-variant)',
                      color: isSelected ? 'var(--elegant-on-primary-container)' : 'var(--text-primary)',
                      border: '1px solid',
                      borderColor: isSelected ? 'var(--elegant-primary)' : 'var(--dark-outline-variant)',
                      cursor: audioSwitching ? 'wait' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontWeight: isSelected ? 700 : 500,
                      opacity: audioSwitching && !isSelected ? 0.7 : 1
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(255, 255, 255, 0.12)',
                          color: '#e2e8f0',
                          fontFamily: 'monospace'
                        }}
                      >
                        #{aud.streamIndex}
                      </span>
                      <span
                        style={{
                          fontSize: '10px',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(34, 197, 94, 0.2)',
                          color: '#4ade80'
                        }}
                      >
                        {aud.codec || 'Audio'}
                      </span>
                      <span style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {aud.label}
                      </span>
                    </div>
                    {isSelected && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                      </svg>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>
                Standard Default Audio Stream
              </div>
            )}

            {/* Multi-Audio & Codec Note */}
            {onOpenExternalPlayer && (
              <div style={{ borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '12px', marginTop: '4px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: 1.5 }}>
                  Secondary audio tracks are dynamically mapped and transcoded to high-fidelity AAC on-the-fly with 100% original video preserved.
                </div>
                <button
                  className="btn btn-surface"
                  onClick={() => {
                    onOpenExternalPlayer();
                    onClose();
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    fontSize: '12px',
                    color: 'var(--elegant-primary)'
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                  Open in System Media Player (VLC / Totem)
                </button>
              </div>
            )}

            {/* Audio Boost */}
            <div style={{ borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '14px', marginTop: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Audio Boost / Voice Clarity (Night Mode)</span>
                <span style={{ fontWeight: 700, color: 'var(--elegant-primary)' }}>{Math.round(audioBoost * 100)}%</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[1.0, 1.25, 1.5, 2.0].map((b) => (
                  <button
                    key={b}
                    className={`btn ${audioBoost === b ? 'btn-primary' : 'btn-surface'}`}
                    style={{ flex: 1, padding: '6px 0', fontSize: '12px' }}
                    onClick={() => onAudioBoostChange(b)}
                  >
                    {Math.round(b * 100)}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab Content: Diagnostics */}
        {activeTab === 'diagnostics' && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Real-time media inspection and container stream metadata from verified <code>ffprobe</code> service:
            </div>

            <div
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                border: '1px solid var(--dark-outline-variant)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                fontFamily: 'monospace',
                fontSize: '11px',
                lineHeight: 1.6,
                maxHeight: '340px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                color: '#94a3b8'
              }}
            >
              {diagnosticsData ? JSON.stringify(diagnosticsData, null, 2) : 'No inspection diagnostics available yet for current stream.'}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              {onOpenDiagnostics && (
                <button
                  className="btn btn-primary"
                  style={{ fontSize: '12px', padding: '6px 14px' }}
                  onClick={() => {
                    onOpenDiagnostics();
                    onClose();
                  }}
                >
                  Open Live Diagnostics HUD
                </button>
              )}
              <button
                className="btn btn-surface"
                style={{ fontSize: '12px', padding: '6px 14px' }}
                onClick={() => {
                  if (diagnosticsData) {
                    navigator.clipboard?.writeText(JSON.stringify(diagnosticsData, null, 2));
                  }
                }}
              >
                Copy JSON Diagnostics
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
