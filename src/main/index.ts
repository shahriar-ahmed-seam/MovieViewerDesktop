import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { AppDatabase } from './database';
import { HttpDirectoryParser } from './http-parser';
import { MediaInspector } from './media-inspector';
import { RemuxStreamer } from './remux-streamer';
import { getBinaryDiagnostics } from './binary-resolver';
import { subtitleService } from './subtitles/service';
import type { SubtitleSessionRequest } from '../shared/subtitles/types';

// Ensure stable Wayland, X11 & hardware-accelerated HEVC / H.265 / multi-audio playback
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks');
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false, // Sleek frameless window with integrated titlebar on both browser & player
    backgroundColor: '#141218',
    title: 'MovieViewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Allows streaming media and subtitles from any HTTP media server without CORS blockage
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message}`);
  });

  const distHtml = path.join(__dirname, '../renderer/index.html');
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173').catch(() => {
      if (fs.existsSync(distHtml)) {
        mainWindow?.loadFile(distHtml);
      }
    });
  } else if (fs.existsSync(distHtml)) {
    mainWindow.loadFile(distHtml);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  db = new AppDatabase();
  try {
    await RemuxStreamer.start();
  } catch (err) {
    console.error('Failed to start RemuxStreamer:', err);
  }
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  subtitleService.cancelAll();
  RemuxStreamer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function setupIpcHandlers() {
  // --- Window Controls ---
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window-is-maximized', () => {
    return mainWindow?.isMaximized() || false;
  });

  ipcMain.on('window-set-fullscreen', (_, flag: boolean) => {
    mainWindow?.setFullScreen(flag);
  });

  // --- External Player Launch ---
  ipcMain.handle('open-external-player', async (_, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e: any) {
      console.error('Failed to open external player:', e);
      return { success: false, error: e.message };
    }
  });

  // --- Media Inspection, Track Analysis & Subtitle Extraction (ffprobe / ffmpeg) ---
  ipcMain.handle('inspect-media', async (_, videoUrl: string) => {
    try {
      return await MediaInspector.inspectMedia(videoUrl);
    } catch (e: any) {
      console.error('Error inspecting media:', e);
      return {
        success: false,
        url: videoUrl,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
        error: e.message || 'Media inspection failed'
      };
    }
  });

  ipcMain.handle('analyze-media-tracks', async (_, videoUrl: string) => {
    try {
      return await MediaInspector.analyzeTracks(videoUrl);
    } catch (e: any) {
      console.error('Error analyzing media tracks:', e);
      return { audioTracks: [], subtitleTracks: [] };
    }
  });

  // --- Embedded subtitle sessions (index-based fast extraction with streaming ffmpeg fallback) ---
  ipcMain.handle('subtitle-start', async (event, req: SubtitleSessionRequest) => {
    if (!req || typeof req.videoUrl !== 'string' || typeof req.sessionId !== 'string' || typeof req.streamIndex !== 'number') {
      return { ok: false, error: 'Invalid subtitle request' };
    }
    const sender = event.sender;
    subtitleService.start(req, (evt) => {
      if (!sender.isDestroyed()) sender.send('subtitle-event', evt);
    });
    return { ok: true };
  });

  ipcMain.on('subtitle-playhead', (_, payload: { sessionId: string; timeMs: number }) => {
    if (payload && typeof payload.sessionId === 'string' && Number.isFinite(payload.timeMs)) {
      subtitleService.updatePlayhead(payload.sessionId, payload.timeMs);
    }
  });

  ipcMain.handle('subtitle-cancel', async (_, sessionId: string) => {
    subtitleService.cancel(sessionId);
    return { ok: true };
  });

  // Sidecar subtitle files are fetched as raw bytes so the renderer can detect their charset
  ipcMain.handle('fetch-subtitle-file', async (_, url: string) => {
    try {
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'Only HTTP(S) URLs are supported' };
      const res = await fetch(url, {
        headers: { 'User-Agent': 'MovieViewer/1.0 (Desktop; Electron)' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 40 * 1024 * 1024) return { success: false, error: 'Subtitle file is too large' };
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { success: true, bytes };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to download subtitle file' };
    }
  });

  ipcMain.handle('prepare-audio-remux', async (_, params: { videoUrl: string; audioStreamIndex: number; startTime?: number; sessionId?: string }) => {
    try {
      // With stream-copied video, ffmpeg's output clock starts at the video keyframe at/before the
      // requested time (audio begins a little later). Using the raw request as the timeline offset
      // shifted subtitles and the clock late by up to a GOP. The offset is therefore the keyframe
      // time, and ffmpeg is asked to seek slightly past it so rounding can never land on the
      // previous keyframe.
      const requested = params.startTime ?? 0;
      let seekTime = requested;
      let timelineStart = requested;
      if (requested > 0) {
        const kfMs = await subtitleService.findVideoKeyframeMs(params.videoUrl, requested * 1000);
        if (kfMs !== null && kfMs <= requested * 1000 + 1 && kfMs >= requested * 1000 - 30000) {
          timelineStart = kfMs / 1000;
          seekTime = Math.max(requested, timelineStart + 0.1);
        }
      }
      const streamUrl = RemuxStreamer.getStreamUrl({ ...params, startTime: seekTime });
      // `startTime` = media time at which the remuxed stream's clock reads 0
      return { success: true, streamUrl, startTime: timelineStart };
    } catch (e: any) {
      console.error('Error preparing audio remux:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('cancel-audio-remux', async (_, sessionId: string) => {
    RemuxStreamer.cancelSession(sessionId);
    return { success: true };
  });

  ipcMain.handle('get-binary-diagnostics', async () => {
    return getBinaryDiagnostics();
  });

  ipcMain.handle('pick-local-subtitle', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Subtitle File',
      filters: [
        { name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa', 'smi', 'sami', 'sub', 'idx', 'sup', 'txt', 'mpl'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 200 * 1024 * 1024) return null;
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      const ext = path.extname(filePath).replace('.', '').toLowerCase();
      const fileName = path.basename(filePath);
      // VobSub comes as an .idx/.sub pair; load the partner file as well
      let companion: { fileName: string; bytes: Uint8Array } | undefined;
      if (ext === 'idx' || ext === 'sub') {
        const partner = filePath.replace(/\.[^.]+$/, ext === 'idx' ? '.sub' : '.idx');
        if (fs.existsSync(partner)) {
          companion = { fileName: path.basename(partner), bytes: new Uint8Array(fs.readFileSync(partner)) };
        }
      }
      return { fileName, extension: ext, bytes, companion };
    } catch (e) {
      console.error('Failed to read local subtitle file:', e);
      return null;
    }
  });

  // --- HTTP Directory Fetcher with Unicode & Korean path safety ---
  ipcMain.handle('fetch-directory', async (_, directoryUrl: string) => {
    try {
      const cleanUrl = directoryUrl.trim();
      const normalizedUrl = !cleanUrl.endsWith('/') && !cleanUrl.includes('?') 
        ? `${cleanUrl}/` 
        : cleanUrl;

      let requestUrl: string;
      try {
        requestUrl = new URL(normalizedUrl).toString();
      } catch {
        requestUrl = normalizedUrl;
      }

      const response = await fetch(requestUrl, {
        headers: {
          'User-Agent': 'MovieViewer/1.0 (Desktop; Electron)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8,ja;q=0.7,*;q=0.5'
        }
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Server returned HTTP ${response.status}: ${response.statusText}`
        };
      }

      const html = await response.text();
      if (!html || html.trim().length === 0) {
        return {
          success: false,
          error: 'Empty response received from media server'
        };
      }

      const items = HttpDirectoryParser.parse(html, normalizedUrl);
      return {
        success: true,
        data: items
      };
    } catch (err: any) {
      console.error('Fetch directory error:', err);
      return {
        success: false,
        error: err.message || 'Failed to connect to media server'
      };
    }
  });

  // --- Database: History ---
  ipcMain.handle('get-recent-history', async (_, limit?: number) => {
    return db.getRecentHistory(limit || 15);
  });

  ipcMain.handle('get-position', async (_, videoUrl: string) => {
    return db.getPosition(videoUrl);
  });

  ipcMain.handle('save-position', async (_, pos) => {
    db.savePosition(pos);
  });

  ipcMain.handle('delete-history', async (_, videoUrl: string) => {
    db.deleteHistory(videoUrl);
  });

  ipcMain.handle('clear-history', async () => {
    db.clearHistory();
  });

  // --- Database: Bookmarks ---
  ipcMain.handle('get-bookmarks', async () => {
    return db.getBookmarks();
  });

  ipcMain.handle('add-bookmark', async (_, bookmark) => {
    db.addBookmark(bookmark);
  });

  ipcMain.handle('delete-bookmark', async (_, id: number) => {
    db.deleteBookmark(id);
  });

  // --- Settings ---
  ipcMain.handle('get-settings', async () => {
    return db.getSettings();
  });

  ipcMain.handle('save-settings', async (_, settings) => {
    return db.saveSettings(settings);
  });
}
