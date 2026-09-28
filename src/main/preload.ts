import { contextBridge, ipcRenderer, shell, IpcRendererEvent } from 'electron';
import { PlaybackPosition, ServerBookmark, AppSettings } from '../shared/types';
import type { SubtitleSessionEvent, SubtitleSessionRequest } from '../shared/subtitles/types';
import { ElectronAPI } from '../renderer/types/electron';

const electronAPI: ElectronAPI = {
  // Directory & Media
  fetchDirectory: (url: string) => ipcRenderer.invoke('fetch-directory', url),
  analyzeMediaTracks: (videoUrl: string) => ipcRenderer.invoke('analyze-media-tracks', videoUrl),
  inspectMedia: (videoUrl: string) => ipcRenderer.invoke('inspect-media', videoUrl),

  // Subtitles
  startSubtitleSession: (req: SubtitleSessionRequest) => ipcRenderer.invoke('subtitle-start', req),
  updateSubtitlePlayhead: (sessionId: string, timeMs: number) => ipcRenderer.send('subtitle-playhead', { sessionId, timeMs }),
  cancelSubtitleSession: (sessionId: string) => ipcRenderer.invoke('subtitle-cancel', sessionId),
  onSubtitleEvent: (listener: (evt: SubtitleSessionEvent) => void) => {
    const handler = (_: IpcRendererEvent, evt: SubtitleSessionEvent) => listener(evt);
    ipcRenderer.on('subtitle-event', handler);
    return () => {
      ipcRenderer.removeListener('subtitle-event', handler);
    };
  },
  fetchSubtitleFile: (url: string) => ipcRenderer.invoke('fetch-subtitle-file', url),

  prepareAudioRemux: (params: { videoUrl: string; audioStreamIndex: number; startTime?: number; sessionId?: string }) => ipcRenderer.invoke('prepare-audio-remux', params),
  cancelAudioRemux: (sessionId: string) => ipcRenderer.invoke('cancel-audio-remux', sessionId),
  getBinaryDiagnostics: () => ipcRenderer.invoke('get-binary-diagnostics'),
  pickLocalSubtitle: () => ipcRenderer.invoke('pick-local-subtitle'),
  openExternalPlayer: (url: string) => ipcRenderer.invoke('open-external-player', url),

  // Database: History
  getRecentHistory: (limit?: number) => ipcRenderer.invoke('get-recent-history', limit),
  getPosition: (videoUrl: string) => ipcRenderer.invoke('get-position', videoUrl),
  savePosition: (pos: PlaybackPosition) => ipcRenderer.invoke('save-position', pos),
  deleteHistory: (videoUrl: string) => ipcRenderer.invoke('delete-history', videoUrl),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Database: Bookmarks
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (bookmark: { title: string; url: string }) => ipcRenderer.invoke('add-bookmark', bookmark),
  deleteBookmark: (id: number) => ipcRenderer.invoke('delete-bookmark', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('save-settings', settings),

  // Window Controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  setFullscreen: (flag: boolean) => ipcRenderer.send('window-set-fullscreen', flag),
  openExternal: (url: string) => shell.openExternal(url)
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
