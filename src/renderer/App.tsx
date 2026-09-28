import React, { useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { BrowserPage } from './pages/BrowserPage';
import { PlayerPage } from './pages/PlayerPage';
import { MediaFile, DirectoryContext, PlaybackPosition, extractExtension } from './types/media';

type Screen = 'browser' | 'player';

export const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<Screen>('browser');
  const [activeMedia, setActiveMedia] = useState<{
    url: string;
    title: string;
    context: DirectoryContext;
  } | null>(null);

  const handlePlayVideo = (mediaFile: MediaFile, directoryContext: DirectoryContext) => {
    setActiveMedia({
      url: mediaFile.fullUrl,
      title: mediaFile.cleanDisplayName,
      context: directoryContext
    });
    setCurrentScreen('player');
  };

  const handlePlayRecent = async (historyItem: PlaybackPosition) => {
    let dirContext: DirectoryContext = {
      directoryUrl: historyItem.directoryUrl,
      directoryTitle: historyItem.title,
      videoFiles: [
        {
          name: historyItem.title,
          fullUrl: historyItem.videoUrl,
          isDirectory: false,
          extension: extractExtension(historyItem.title),
          fileType: 1 as any,
          cleanDisplayName: historyItem.title,
          isPlayableVideo: true,
          isSubtitleFile: false
        }
      ],
      subtitleFiles: []
    };

    if (window.electronAPI?.fetchDirectory && historyItem.directoryUrl) {
      try {
        const res = await window.electronAPI.fetchDirectory(historyItem.directoryUrl);
        if (res.success && res.data) {
          const videoFiles = res.data.filter((it: MediaFile) => it.isPlayableVideo);
          const subtitleFiles = res.data.filter((it: MediaFile) => it.isSubtitleFile);
          dirContext = {
            directoryUrl: historyItem.directoryUrl,
            directoryTitle: historyItem.title,
            videoFiles: videoFiles.length > 0 ? videoFiles : dirContext.videoFiles,
            subtitleFiles
          };
        }
      } catch (e) {
        console.warn('Could not fetch directory context for recent item:', e);
      }
    }

    setActiveMedia({
      url: historyItem.videoUrl,
      title: historyItem.title,
      context: dirContext
    });
    setCurrentScreen('player');
  };

  const handleNavigateBack = () => {
    setCurrentScreen('browser');
    setActiveMedia(null);
  };

  return (
    <div className="app-container">
      {/* Titlebar is only shown in browser mode, player handles its own full-screen top bar */}
      {currentScreen === 'browser' && (
        <TitleBar title="MovieViewer" />
      )}

      <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{ width: '100%', height: '100%', display: currentScreen === 'browser' ? 'flex' : 'none', flexDirection: 'column' }}>
          <BrowserPage
            onPlayVideo={handlePlayVideo}
            onPlayRecent={handlePlayRecent}
          />
        </div>

        {currentScreen === 'player' && activeMedia && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10 }}>
            <PlayerPage
              mediaUrl={activeMedia.url}
              mediaTitle={activeMedia.title}
              directoryContext={activeMedia.context}
              onNavigateBack={handleNavigateBack}
            />
          </div>
        )}
      </main>
    </div>
  );
};
