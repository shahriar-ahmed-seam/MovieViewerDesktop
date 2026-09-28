import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { PlaybackPosition, ServerBookmark, formatTimeMs, AppSettings, DEFAULT_SETTINGS, DEFAULT_SERVER_URL } from '../shared/types';

export class AppDatabase {
  private dataPath: string;
  private settingsPath: string;
  private data: {
    history: PlaybackPosition[];
    bookmarks: ServerBookmark[];
  } = { history: [], bookmarks: [] };

  constructor() {
    const userDataPath = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.movieviewer_data');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    this.dataPath = path.join(userDataPath, 'movie_viewer_store.json');
    this.settingsPath = path.join(userDataPath, 'settings.json');

    this.loadData();
  }

  private loadData() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          history: Array.isArray(parsed.history) ? parsed.history : [],
          bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
        };
      } else {
        this.saveData();
      }
    } catch (e) {
      console.error('Failed to load database file, initializing empty store:', e);
      this.data = { history: [], bookmarks: [] };
    }
  }

  private saveData() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to write database file:', err);
    }
  }

  // --- Playback History ---
  getRecentHistory(limit: number = 15): PlaybackPosition[] {
    return [...this.data.history]
      .sort((a, b) => b.lastPlayedTimestamp - a.lastPlayedTimestamp)
      .slice(0, limit)
      .map(this.enhancePlaybackPosition);
  }

  getPosition(videoUrl: string): PlaybackPosition | null {
    const item = this.data.history.find(h => h.videoUrl === videoUrl);
    return item ? this.enhancePlaybackPosition(item) : null;
  }

  savePosition(pos: PlaybackPosition): void {
    const isCompleted = pos.durationMs > 0 && pos.positionMs >= (pos.durationMs * 0.95);
    const timestamp = Date.now();

    const index = this.data.history.findIndex(h => h.videoUrl === pos.videoUrl);
    const updated: PlaybackPosition = {
      ...pos,
      lastPlayedTimestamp: timestamp,
      completed: isCompleted
    };

    if (index >= 0) {
      this.data.history[index] = updated;
    } else {
      this.data.history.push(updated);
    }

    this.saveData();
  }

  deleteHistory(videoUrl: string): void {
    this.data.history = this.data.history.filter(h => h.videoUrl !== videoUrl);
    this.saveData();
  }

  clearHistory(): void {
    this.data.history = [];
    this.saveData();
  }

  // --- Bookmarks ---
  getBookmarks(): ServerBookmark[] {
    return [...this.data.bookmarks].sort((a, b) => b.lastVisitedTimestamp - a.lastVisitedTimestamp);
  }

  addBookmark(bookmark: { title: string; url: string }): void {
    const timestamp = Date.now();
    const existing = this.data.bookmarks.find(b => b.url === bookmark.url);
    if (!existing) {
      this.data.bookmarks.push({
        id: Date.now(),
        title: bookmark.title,
        url: bookmark.url,
        lastVisitedTimestamp: timestamp
      });
      this.saveData();
    }
  }

  deleteBookmark(id: number): void {
    this.data.bookmarks = this.data.bookmarks.filter(b => b.id !== id);
    this.saveData();
  }

  // --- Settings ---
  getSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_SETTINGS, ...parsed };
        // Migrate old hardcoded Prison Break URL to root URL
        if (!merged.serverUrl || merged.serverUrl.includes('Prison%20Break')) {
          merged.serverUrl = DEFAULT_SERVER_URL;
          this.saveSettings(merged);
        }
        return merged;
      }
    } catch (e) {
      console.error('Error reading settings:', e);
    }
    return DEFAULT_SETTINGS;
  }

  saveSettings(settings: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving settings:', e);
    }
    return updated;
  }

  private enhancePlaybackPosition(pos: PlaybackPosition): PlaybackPosition {
    const fraction = pos.durationMs > 0 ? Math.min(1, Math.max(0, pos.positionMs / pos.durationMs)) : 0;
    return {
      ...pos,
      progressFraction: fraction,
      formattedPosition: formatTimeMs(pos.positionMs),
      formattedDuration: formatTimeMs(pos.durationMs)
    };
  }
}
