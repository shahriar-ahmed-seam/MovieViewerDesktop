import { MediaFile, PlaybackPosition, ServerBookmark, AppSettings, MediaTracksResult, BinaryDiagnostics } from '../../shared/types';
import type { SubtitleSessionEvent, SubtitleSessionRequest } from '../../shared/subtitles/types';

export interface LocalSubtitleFile {
  fileName: string;
  extension: string;
  bytes: Uint8Array;
  /** Partner file for VobSub .idx/.sub pairs. */
  companion?: { fileName: string; bytes: Uint8Array };
}

export interface ElectronAPI {
  // Directory & Media
  fetchDirectory: (url: string) => Promise<{ success: boolean; data?: MediaFile[]; error?: string }>;
  analyzeMediaTracks: (videoUrl: string) => Promise<MediaTracksResult>;
  inspectMedia: (videoUrl: string) => Promise<any>;

  // Subtitles
  startSubtitleSession: (req: SubtitleSessionRequest) => Promise<{ ok: boolean; error?: string }>;
  updateSubtitlePlayhead: (sessionId: string, timeMs: number) => void;
  cancelSubtitleSession: (sessionId: string) => Promise<{ ok: boolean }>;
  onSubtitleEvent: (listener: (evt: SubtitleSessionEvent) => void) => () => void;
  fetchSubtitleFile: (url: string) => Promise<{ success: boolean; bytes?: Uint8Array; error?: string }>;

  prepareAudioRemux: (params: { videoUrl: string; audioStreamIndex: number; startTime?: number; sessionId?: string }) => Promise<{ success: boolean; streamUrl?: string; startTime?: number; error?: string }>;
  cancelAudioRemux: (sessionId: string) => Promise<{ success: boolean }>;
  getBinaryDiagnostics: () => Promise<BinaryDiagnostics>;
  pickLocalSubtitle: () => Promise<LocalSubtitleFile | null>;
  openExternalPlayer: (url: string) => Promise<{ success: boolean; error?: string }>;
  
  // Database: History
  getRecentHistory: (limit?: number) => Promise<PlaybackPosition[]>;
  getPosition: (videoUrl: string) => Promise<PlaybackPosition | null>;
  savePosition: (pos: PlaybackPosition) => Promise<void>;
  deleteHistory: (videoUrl: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  // Database: Bookmarks
  getBookmarks: () => Promise<ServerBookmark[]>;
  addBookmark: (bookmark: { title: string; url: string }) => Promise<void>;
  deleteBookmark: (id: number) => Promise<void>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;

  // Window Controls
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isMaximized: () => Promise<boolean>;
  setFullscreen: (flag: boolean) => void;
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
