import React from 'react';
import { MediaFile, FileType } from '../types/media';

interface MediaItemCardProps {
  item: MediaFile;
  onClick: () => void;
}

export const MediaItemCard: React.FC<MediaItemCardProps> = ({ item, onClick }) => {
  const isEpisode = 
    /s\d{1,2}e\d{1,2}|episode\s*\d+/i.test(item.cleanDisplayName);

  const getIconInfo = () => {
    switch (item.fileType) {
      case FileType.DIRECTORY:
        return {
          bg: 'rgba(208, 188, 255, 0.18)',
          color: 'var(--elegant-primary)',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
          )
        };
      case FileType.VIDEO:
        return {
          bg: 'rgba(128, 212, 255, 0.18)',
          color: 'var(--accent-cyan)',
          icon: isEpisode ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
            </svg>
          )
        };
      case FileType.SUBTITLE:
        return {
          bg: 'rgba(167, 139, 250, 0.18)',
          color: 'var(--accent-purple)',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/>
            </svg>
          )
        };
      case FileType.AUDIO:
        return {
          bg: 'rgba(140, 216, 180, 0.18)',
          color: 'var(--accent-green)',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          )
        };
      default:
        return {
          bg: 'rgba(255, 255, 255, 0.08)',
          color: 'var(--text-muted)',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
          )
        };
    }
  };

  const iconInfo = getIconInfo();

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        margin: '4px 0',
        borderRadius: 'var(--radius-md)',
        background: item.isDirectory ? 'var(--dark-surface-card)' : 'rgba(54, 52, 59, 0.45)',
        border: '1px solid var(--dark-outline-variant)',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--dark-surface-elevated)';
        e.currentTarget.style.borderColor = 'var(--elegant-primary-container)';
        e.currentTarget.style.transform = 'translateX(4px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = item.isDirectory ? 'var(--dark-surface-card)' : 'rgba(54, 52, 59, 0.45)';
        e.currentTarget.style.borderColor = 'var(--dark-outline-variant)';
        e.currentTarget.style.transform = 'translateX(0)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: 0 }}>
        <div
          style={{
            width: '42px',
            height: '42px',
            borderRadius: 'var(--radius-md)',
            background: iconInfo.bg,
            color: iconInfo.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          {iconInfo.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '14px',
              fontWeight: item.isDirectory ? 600 : 500,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginBottom: '3px'
            }}
            title={item.cleanDisplayName}
          >
            {item.cleanDisplayName}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            {item.extension && (
              <span
                style={{
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  fontSize: '10px',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  background: iconInfo.bg,
                  color: iconInfo.color
                }}
              >
                {item.extension}
              </span>
            )}
            {item.sizeString && <span>{item.sizeString}</span>}
            {item.dateString && <span>• {item.dateString}</span>}
          </div>
        </div>
      </div>

      {item.isPlayableVideo && (
        <button
          className="btn btn-icon"
          style={{
            background: 'var(--elegant-primary-container)',
            color: 'var(--elegant-on-primary-container)',
            marginLeft: '12px'
          }}
          title="Play Stream"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      )}
    </div>
  );
};
