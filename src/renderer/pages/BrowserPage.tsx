import React, { useEffect, useState, useMemo } from 'react';
import { MediaFile, DirectoryContext, PlaybackPosition, ServerBookmark, FileType } from '../types/media';
import { AppSettings, DEFAULT_SETTINGS } from '../types/settings';
import { BreadcrumbsRow, BreadcrumbItem } from '../components/BreadcrumbsRow';
import { ContinueWatchingRow } from '../components/ContinueWatchingRow';
import { MediaItemCard } from '../components/MediaItemCard';
import { SettingsModal } from '../components/SettingsModal';

interface BrowserPageProps {
  onPlayVideo: (file: MediaFile, context: DirectoryContext) => void;
  onPlayRecent: (item: PlaybackPosition) => void;
}

export const BrowserPage: React.FC<BrowserPageProps> = ({ onPlayVideo, onPlayRecent }) => {
  const [currentUrl, setCurrentUrl] = useState<string>(DEFAULT_SETTINGS.serverUrl);
  const [items, setItems] = useState<MediaFile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchVisible, setIsSearchVisible] = useState<boolean>(false);
  const [backStack, setBackStack] = useState<string[]>([]);

  // Settings & Database state
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [history, setHistory] = useState<PlaybackPosition[]>([]);
  const [bookmarks, setBookmarks] = useState<ServerBookmark[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // Initial load
  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    if (!window.electronAPI) return;

    try {
      const loadedSettings = await window.electronAPI.getSettings();
      setSettings(loadedSettings);
      setCurrentUrl(loadedSettings.serverUrl);

      const recentHistory = await window.electronAPI.getRecentHistory(15);
      setHistory(recentHistory);

      const savedBookmarks = await window.electronAPI.getBookmarks();
      setBookmarks(savedBookmarks);

      loadDirectory(loadedSettings.serverUrl);
    } catch (e) {
      console.error('Error loading initial app data:', e);
      loadDirectory(DEFAULT_SETTINGS.serverUrl);
    }
  };

  const loadDirectory = async (url: string, addToBackStack: boolean = false) => {
    const cleanUrl = url.trim();
    if (!cleanUrl) return;

    if (addToBackStack && currentUrl && currentUrl !== cleanUrl) {
      setBackStack((prev) => [...prev, currentUrl]);
    }

    setCurrentUrl(cleanUrl);
    setSearchQuery('');
    setIsLoading(true);
    setErrorMessage(null);

    if (window.electronAPI) {
      const res = await window.electronAPI.fetchDirectory(cleanUrl);
      setIsLoading(false);
      if (res.success && res.data) {
        setItems(res.data);
      } else {
        setErrorMessage(res.error || 'Failed to connect to media server');
      }
    }
  };

  const handleNavigateBack = () => {
    if (backStack.length > 0) {
      const prevUrl = backStack[backStack.length - 1];
      setBackStack((prev) => prev.slice(0, -1));
      loadDirectory(prevUrl, false);
    }
  };

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    if (window.electronAPI) {
      const updated = await window.electronAPI.saveSettings(newSettings);
      setSettings(updated);
      if (newSettings.serverUrl && newSettings.serverUrl !== currentUrl) {
        setBackStack([]);
        loadDirectory(newSettings.serverUrl);
      }
    }
  };

  const handleAddBookmark = async (title: string, url: string) => {
    if (window.electronAPI) {
      await window.electronAPI.addBookmark({ title, url });
      const updated = await window.electronAPI.getBookmarks();
      setBookmarks(updated);
    }
  };

  const handleDeleteBookmark = async (id: number) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteBookmark(id);
      const updated = await window.electronAPI.getBookmarks();
      setBookmarks(updated);
    }
  };

  const handleRemoveHistory = async (videoUrl: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteHistory(videoUrl);
      const updated = await window.electronAPI.getRecentHistory(15);
      setHistory(updated);
    }
  };

  const breadcrumbs: BreadcrumbItem[] = useMemo(() => {
    try {
      const url = new URL(currentUrl);
      const host = url.host;
      const origin = url.origin + '/';
      const crumbs: BreadcrumbItem[] = [{ title: host, targetUrl: origin }];

      const segments = url.pathname.split('/').filter(Boolean);
      let runningPath = origin;

      for (const segment of segments) {
        runningPath += `${segment}/`;
        const decoded = decodeURIComponent(segment);
        crumbs.push({ title: decoded, targetUrl: runningPath });
      }
      return crumbs;
    } catch {
      return [{ title: 'Root', targetUrl: currentUrl }];
    }
  }, [currentUrl]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (item) => item.cleanDisplayName.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const createDirectoryContext = (): DirectoryContext => {
    const videoFiles = items.filter((it) => it.isPlayableVideo);
    const subtitleFiles = items.filter((it) => it.isSubtitleFile);
    const dirTitle = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].title : 'Media Folder';

    return {
      directoryUrl: currentUrl,
      directoryTitle: dirTitle,
      videoFiles,
      subtitleFiles
    };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'var(--dark-surface)',
          borderBottom: '1px solid var(--dark-outline-variant)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {backStack.length > 0 && (
            <button
              className="btn btn-surface btn-icon"
              onClick={handleNavigateBack}
              title="Back"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--elegant-primary)">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
            </svg>
            <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
              Media Browser
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className="btn btn-surface btn-icon"
            onClick={() => setIsSearchVisible(!isSearchVisible)}
            style={{ color: isSearchVisible ? 'var(--elegant-primary)' : 'var(--text-secondary)' }}
            title="Search"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>

          <button
            className="btn btn-surface btn-icon"
            onClick={() => {
              const title = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].title : 'Media Server Location';
              handleAddBookmark(title, currentUrl);
            }}
            title="Bookmark Location"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </button>

          <button
            className="btn btn-surface btn-icon"
            onClick={() => loadDirectory(currentUrl)}
            title="Refresh"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>

          <button
            className="btn btn-surface btn-icon"
            onClick={() => setIsSettingsOpen(true)}
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Search Input Bar */}
      {isSearchVisible && (
        <div style={{ padding: '8px 16px', background: 'var(--dark-surface-card)', borderBottom: '1px solid var(--dark-outline-variant)' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--elegant-primary)"
              strokeWidth="2"
              style={{ position: 'absolute', left: 12 }}
            >
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter items in current folder..."
              autoFocus
              style={{
                width: '100%',
                padding: '8px 36px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--dark-bg)',
                border: '1px solid var(--elegant-primary)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                outline: 'none'
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: 12,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer'
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {/* Breadcrumbs Row */}
      <BreadcrumbsRow
        breadcrumbs={breadcrumbs}
        onCrumbClick={(url) => loadDirectory(url, true)}
      />

      {/* Continue Watching Row */}
      {!searchQuery && (
        <ContinueWatchingRow
          history={history}
          onPlayItem={onPlayRecent}
          onRemoveItem={handleRemoveHistory}
        />
      )}

      {/* Directory Content List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                border: '3px solid var(--dark-outline-variant)',
                borderTopColor: 'var(--elegant-primary)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite'
              }}
            />
            <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Connecting to media server...</span>
            <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          </div>
        ) : errorMessage ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80%', textAlign: 'center', gap: '12px' }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="var(--accent-red)">
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
            </svg>
            <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Unable to load directory
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '400px' }}>
              {errorMessage}
            </div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
              <button className="btn btn-primary" onClick={() => loadDirectory(currentUrl)}>
                Retry
              </button>
              <button className="btn btn-surface" onClick={() => setIsSettingsOpen(true)}>
                Change Server URL
              </button>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80%', color: 'var(--text-muted)', gap: '12px' }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.4">
              <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/>
            </svg>
            <div style={{ fontSize: '14px' }}>
              {searchQuery ? `No files match "${searchQuery}"` : 'No media files or folders found in this directory'}
            </div>
          </div>
        ) : (
          <div>
            {filteredItems.map((item) => (
              <MediaItemCard
                key={item.fullUrl}
                item={item}
                onClick={() => {
                  if (item.isDirectory) {
                    loadDirectory(item.fullUrl, true);
                  } else if (item.isPlayableVideo) {
                    const context = createDirectoryContext();
                    onPlayVideo(item, context);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Settings Modal */}
      <SettingsModal
        settings={settings}
        bookmarks={bookmarks}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSaveSettings={handleSaveSettings}
        onSelectBookmark={(url) => loadDirectory(url, true)}
        onAddBookmark={handleAddBookmark}
        onDeleteBookmark={handleDeleteBookmark}
      />
    </div>
  );
};
