import React from 'react';
import { PlaybackPosition } from '../types/media';

interface ContinueWatchingRowProps {
  history: PlaybackPosition[];
  onPlayItem: (item: PlaybackPosition) => void;
  onRemoveItem: (url: string) => void;
}

export const ContinueWatchingRow: React.FC<ContinueWatchingRowProps> = ({
  history,
  onPlayItem,
  onRemoveItem
}) => {
  if (!history || history.length === 0) return null;

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--dark-outline-variant)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--elegant-primary)">
          <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
        </svg>
        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Continue Watching
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '12px',
          overflowX: 'auto',
          paddingBottom: '6px'
        }}
      >
        {history.map((item) => (
          <div
            key={item.videoUrl}
            onClick={() => onPlayItem(item)}
            style={{
              width: '240px',
              flexShrink: 0,
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--dark-surface-card)',
              border: '1px solid var(--dark-outline-variant)',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
              position: 'relative'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--dark-surface-elevated)';
              e.currentTarget.style.borderColor = 'var(--elegant-primary-container)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--dark-surface-card)';
              e.currentTarget.style.borderColor = 'var(--dark-outline-variant)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent-cyan)" style={{ flexShrink: 0 }}>
                  <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
                </svg>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={item.title}
                >
                  {item.title}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveItem(item.videoUrl);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px'
                }}
                title="Remove from history"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Progress Bar */}
            <div
              style={{
                width: '100%',
                height: '4px',
                background: 'var(--dark-surface-variant)',
                borderRadius: '2px',
                overflow: 'hidden',
                marginBottom: '6px'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(item.progressFraction || 0) * 100}%`,
                  background: 'var(--elegant-primary)',
                  borderRadius: '2px'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--elegant-secondary)', fontWeight: 600 }}>
                {item.formattedPosition || '00:00'}
              </span>
              <span>{item.formattedDuration || '00:00'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
