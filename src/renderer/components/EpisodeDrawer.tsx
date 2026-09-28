import React from 'react';
import { MediaFile } from '../types/media';

interface EpisodeDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  videoFiles: MediaFile[];
  currentVideoUrl: string;
  directoryTitle: string;
  onSelectEpisode: (file: MediaFile) => void;
}

export const EpisodeDrawer: React.FC<EpisodeDrawerProps> = ({
  isOpen,
  onClose,
  videoFiles,
  currentVideoUrl,
  directoryTitle,
  onSelectEpisode
}) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: '360px',
        backgroundColor: 'rgba(33, 31, 38, 0.95)',
        backdropFilter: 'blur(16px)',
        borderLeft: '1px solid var(--glass-border)',
        boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.5)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1500,
        animation: 'slideInRight 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Drawer Header */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--dark-outline-variant)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Episodes & Media
          </div>
          {directoryTitle && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--elegant-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {directoryTitle}
            </div>
          )}
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

      {/* Episode List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {videoFiles.map((file, idx) => {
          const isPlaying = file.fullUrl === currentVideoUrl;
          return (
            <div
              key={file.fullUrl}
              onClick={() => {
                onSelectEpisode(file);
                onClose();
              }}
              style={{
                padding: '12px 14px',
                margin: '4px 0',
                borderRadius: 'var(--radius-md)',
                backgroundColor: isPlaying ? 'var(--elegant-primary-container)' : 'var(--dark-surface-card)',
                color: isPlaying ? 'var(--elegant-on-primary-container)' : 'var(--text-primary)',
                border: '1px solid',
                borderColor: isPlaying ? 'var(--elegant-primary)' : 'var(--dark-outline-variant)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                display: 'flex',
                alignItems: 'center',
                gap: '12px'
              }}
              onMouseEnter={(e) => {
                if (!isPlaying) {
                  e.currentTarget.style.backgroundColor = 'var(--dark-surface-elevated)';
                  e.currentTarget.style.borderColor = 'var(--elegant-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isPlaying) {
                  e.currentTarget.style.backgroundColor = 'var(--dark-surface-card)';
                  e.currentTarget.style.borderColor = 'var(--dark-outline-variant)';
                }
              }}
            >
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: isPlaying ? 'var(--elegant-primary)' : 'rgba(255, 255, 255, 0.08)',
                  color: isPlaying ? 'var(--elegant-on-primary)' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                  flexShrink: 0
                }}
              >
                {isPlaying ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                ) : (
                  idx + 1
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: isPlaying ? 700 : 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={file.cleanDisplayName}
                >
                  {file.cleanDisplayName}
                </div>
                {file.sizeString && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>
                    {file.sizeString}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
