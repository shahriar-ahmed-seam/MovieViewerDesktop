import React, { useState } from 'react';
import { AppSettings, DEFAULT_SERVER_URL } from '../types/settings';
import { ServerBookmark } from '../types/media';

interface SettingsModalProps {
  settings: AppSettings;
  bookmarks: ServerBookmark[];
  isOpen: boolean;
  onClose: () => void;
  onSaveSettings: (settings: Partial<AppSettings>) => void;
  onSelectBookmark: (url: string) => void;
  onAddBookmark: (title: string, url: string) => void;
  onDeleteBookmark: (id: number) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  bookmarks,
  isOpen,
  onClose,
  onSaveSettings,
  onSelectBookmark,
  onAddBookmark,
  onDeleteBookmark
}) => {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [seekJump, setSeekJump] = useState(settings.seekJumpSeconds);
  const [developerDiagnostics, setDeveloperDiagnostics] = useState(settings.developerDiagnostics || false);
  const [subLanguage, setSubLanguage] = useState(settings.preferredSubtitleLanguage || 'eng');
  const [subAutoEnable, setSubAutoEnable] = useState(settings.subtitlesEnabledByDefault !== false);
  const [subScale, setSubScale] = useState(settings.subtitleScale || 1);
  const [bookmarkTitle, setBookmarkTitle] = useState('');
  const [showAddBookmark, setShowAddBookmark] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveSettings({
      serverUrl: serverUrl.trim(),
      seekJumpSeconds: seekJump,
      developerDiagnostics,
      preferredSubtitleLanguage: subLanguage,
      subtitlesEnabledByDefault: subAutoEnable,
      subtitleScale: subScale
    });
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        animation: 'fadeIn 0.2s ease-out'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '560px',
          maxHeight: '85vh',
          overflowY: 'auto',
          backgroundColor: 'var(--dark-surface-card)',
          border: '1px solid var(--dark-outline-variant)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          boxShadow: 'var(--glass-glow)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Media Server Settings
          </h2>
          <button
            className="btn-icon titlebar-btn"
            onClick={onClose}
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Server URL Input */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Server / Directory URL
          </label>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://192.168.1.100/movies/"
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--dark-bg)',
              border: '1px solid var(--dark-outline-variant)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
            onFocus={(e) => e.target.style.borderColor = 'var(--elegant-primary)'}
            onBlur={(e) => e.target.style.borderColor = 'var(--dark-outline-variant)'}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
            <button
              className="btn btn-surface"
              style={{ fontSize: '11px', padding: '4px 8px' }}
              onClick={() => setServerUrl(DEFAULT_SERVER_URL)}
            >
              Reset Example URL
            </button>
          </div>
        </div>

        {/* Bookmarks Section */}
        <div style={{ marginBottom: '24px', borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
              Bookmarks & Locations
            </span>
            <button
              className="btn btn-surface"
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={() => setShowAddBookmark(!showAddBookmark)}
            >
              {showAddBookmark ? 'Cancel' : '+ Add Current'}
            </button>
          </div>

          {showAddBookmark && (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <input
                type="text"
                value={bookmarkTitle}
                onChange={(e) => setBookmarkTitle(e.target.value)}
                placeholder="Bookmark label (e.g. Prison Break S1)"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--dark-bg)',
                  border: '1px solid var(--dark-outline-variant)',
                  color: 'var(--text-primary)',
                  fontSize: '12px'
                }}
              />
              <button
                className="btn btn-primary"
                style={{ fontSize: '12px', padding: '8px 14px' }}
                onClick={() => {
                  if (bookmarkTitle.trim()) {
                    onAddBookmark(bookmarkTitle.trim(), serverUrl);
                    setBookmarkTitle('');
                    setShowAddBookmark(false);
                  }
                }}
              >
                Save
              </button>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {bookmarks.length === 0 ? (
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No saved bookmarks yet.</span>
            ) : (
              bookmarks.map((bm) => (
                <div
                  key={bm.id || bm.url}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--dark-surface-variant)',
                    border: '1px solid var(--dark-outline-variant)',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    onSelectBookmark(bm.url);
                    onClose();
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--elegant-primary)">
                    <path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
                  </svg>
                  <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {bm.title}
                  </span>
                  {bm.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteBookmark(bm.id!);
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: '2px'
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Seek Jump Interval */}
        <div style={{ marginBottom: '24px', borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '10px' }}>
            Seek Jump Interval (Arrow Keys / Buttons)
          </label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {[5, 10, 15, 30].map((sec) => (
              <button
                key={sec}
                className={`btn ${seekJump === sec ? 'btn-primary' : 'btn-surface'}`}
                style={{ flex: 1, padding: '8px 0' }}
                onClick={() => setSeekJump(sec)}
              >
                {sec}s
              </button>
            ))}
          </div>
        </div>

        {/* Subtitle Preferences */}
        <div style={{ marginBottom: '24px', borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '16px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '10px' }}>
            Subtitles
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '12px' }}>
            <label htmlFor="sub-language" style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Preferred language</label>
            <select
              id="sub-language"
              value={subLanguage}
              onChange={(e) => setSubLanguage(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--dark-bg)',
                border: '1px solid var(--dark-outline-variant)',
                color: 'var(--text-primary)',
                fontSize: '12px'
              }}
            >
              {[
                ['eng', 'English'], ['ben', 'Bengali'], ['hin', 'Hindi'], ['kor', 'Korean'], ['jpn', 'Japanese'],
                ['chi', 'Chinese'], ['ara', 'Arabic'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'],
                ['ind', 'Indonesian'], ['may', 'Malay'], ['tha', 'Thai'], ['tur', 'Turkish'], ['por', 'Portuguese']
              ].map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <label htmlFor="sub-auto" style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Turn subtitles on automatically</label>
            <input
              id="sub-auto"
              type="checkbox"
              checked={subAutoEnable}
              onChange={(e) => setSubAutoEnable(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--elegant-primary)' }}
            />
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginBottom: '8px' }}>Text size</div>
          <div style={{ display: 'flex', gap: '10px' }} role="group" aria-label="Subtitle text size">
            {[[0.8, 'Small'], [1, 'Normal'], [1.25, 'Large'], [1.5, 'Huge']].map(([v, name]) => (
              <button
                key={name as string}
                className={`btn ${subScale === v ? 'btn-primary' : 'btn-surface'}`}
                style={{ flex: 1, padding: '8px 0' }}
                aria-pressed={subScale === v}
                onClick={() => setSubScale(v as number)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {/* Developer Diagnostics Toggle */}
        <div style={{ marginBottom: '24px', borderTop: '1px solid var(--dark-outline-variant)', paddingTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Developer Playback Diagnostics
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Show stream metadata, active cues, buffer percentages, and pipeline diagnostics in player
              </div>
            </div>
            <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={developerDiagnostics}
                onChange={(e) => setDeveloperDiagnostics(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--elegant-primary)' }}
              />
            </label>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button className="btn btn-surface" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            Save & Connect
          </button>
        </div>
      </div>
    </div>
  );
};
