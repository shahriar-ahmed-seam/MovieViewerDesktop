import type {
  BitmapSubtitlePacket, SubtitleCue, SubtitleProgress, SubtitleRenderKind, SubtitleTrackHeader, SubtitleExtractionMethod
} from '../../shared/subtitles/types';
import { parsePgsDisplaySet, renderPgsComposition, PgsDisplaySet, DecodedComposition } from '../../shared/subtitles/pgs';
import { decodeVobSubPacket, parseVobSubIdx, VobSubIdx } from '../../shared/subtitles/vobsub';

export type SubtitleLoadStatus = 'loading' | 'ready' | 'empty' | 'error';

/** Longest time a bitmap without an explicit end stays on screen. */
const MAX_BITMAP_DISPLAY_MS = 12000;

/**
 * Holds one subtitle track (text cues or bitmap packets) as it streams in, and answers
 * "what is on screen at time t" efficiently (binary search, lazy bitmap decoding).
 */
export class SubtitleTrackStore {
  kind: SubtitleRenderKind = 'text';
  header: SubtitleTrackHeader | null = null;
  status: SubtitleLoadStatus = 'loading';
  error: string | null = null;
  method: SubtitleExtractionMethod | 'file' | null = null;
  progress: SubtitleProgress | null = null;
  startedAt = Date.now();
  completedInMs: number | null = null;
  /** Bumped on every change so React consumers can re-render cheaply. */
  version = 0;

  private cues: SubtitleCue[] = [];
  private cueIds = new Set<string>();
  private maxCueDurationMs = 0;
  private packets: BitmapSubtitlePacket[] = [];
  private packetKeys = new Set<string>();
  private listeners = new Set<() => void>();
  private pgsParsed = new WeakMap<BitmapSubtitlePacket, PgsDisplaySet | null>();
  private decoded = new Map<BitmapSubtitlePacket, DecodedComposition | null>();
  private vobIdx: VobSubIdx | null = null;

  constructor(readonly optionId: string, readonly sessionId: string | null = null) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  setHeader(header: SubtitleTrackHeader) {
    const kindChanged = this.header && this.header.kind !== header.kind;
    this.header = header;
    this.kind = header.kind;
    this.vobIdx = header.kind === 'vobsub' ? parseVobSubIdx(header.vobsubIdx) : null;
    if (kindChanged) {
      this.cues = [];
      this.cueIds.clear();
      this.packets = [];
      this.packetKeys.clear();
      this.decoded.clear();
    }
    this.changed();
  }

  addCues(cues: SubtitleCue[]) {
    if (!cues.length) return;
    let needsSort = false;
    for (const c of cues) {
      if (this.cueIds.has(c.id)) continue;
      this.cueIds.add(c.id);
      const last = this.cues[this.cues.length - 1];
      if (last && c.startMs < last.startMs) needsSort = true;
      this.cues.push(c);
      this.maxCueDurationMs = Math.max(this.maxCueDurationMs, c.endMs - c.startMs);
    }
    if (needsSort) this.cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    this.changed();
  }

  addPackets(packets: BitmapSubtitlePacket[]) {
    if (!packets.length) return;
    let needsSort = false;
    for (const p of packets) {
      const key = `${Math.round(p.startMs)}:${p.data.length}`;
      if (this.packetKeys.has(key)) continue;
      this.packetKeys.add(key);
      const last = this.packets[this.packets.length - 1];
      if (last && p.startMs < last.startMs) needsSort = true;
      this.packets.push(p);
    }
    if (needsSort) this.packets.sort((a, b) => a.startMs - b.startMs);
    this.changed();
  }

  setStatus(status: SubtitleLoadStatus, error?: string | null) {
    this.status = status;
    this.error = error ?? null;
    if (status !== 'loading' && this.completedInMs === null) this.completedInMs = Date.now() - this.startedAt;
    this.changed();
  }

  setProgress(progress: SubtitleProgress) {
    this.progress = { ...this.progress, ...progress };
    this.changed();
  }

  get itemCount(): number {
    return this.kind === 'text' ? this.cues.length : this.packets.length;
  }

  /** All text cues (sorted). */
  getCues(): readonly SubtitleCue[] {
    return this.cues;
  }

  firstItemStartMs(): number | null {
    if (this.kind === 'text') return this.cues[0]?.startMs ?? null;
    return this.packets[0]?.startMs ?? null;
  }

  /** Index of the last element whose startMs <= t, or -1. */
  private static lastStartingBefore<T extends { startMs: number }>(arr: T[], t: number): number {
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].startMs <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  activeCues(timeMs: number): SubtitleCue[] {
    if (this.kind !== 'text' || this.cues.length === 0) return [];
    const idx = SubtitleTrackStore.lastStartingBefore(this.cues, timeMs);
    const out: SubtitleCue[] = [];
    for (let i = idx; i >= 0; i--) {
      const c = this.cues[i];
      if (c.startMs < timeMs - this.maxCueDurationMs) break;
      if (c.endMs > timeMs) out.push(c);
    }
    return out.reverse();
  }

  /** The bitmap packet visible at `timeMs`, or null. */
  activeBitmap(timeMs: number): BitmapSubtitlePacket | null {
    if (this.kind === 'text' || this.packets.length === 0) return null;
    const idx = SubtitleTrackStore.lastStartingBefore(this.packets, timeMs);
    if (idx < 0) return null;
    const p = this.packets[idx];
    const next = this.packets[idx + 1];
    let end = p.endMs ?? (next ? next.startMs : p.startMs + MAX_BITMAP_DISPLAY_MS);
    if (next && next.startMs < end && this.kind === 'pgs') end = next.startMs;
    end = Math.min(end, p.startMs + (p.endMs !== undefined ? 60000 : MAX_BITMAP_DISPLAY_MS));
    if (timeMs >= end) {
      // VobSub entries can overlap; look one step back
      if (this.kind === 'vobsub' && idx > 0) {
        const prev = this.packets[idx - 1];
        if (prev.endMs !== undefined && timeMs < prev.endMs) return prev;
      }
      return null;
    }
    if (this.kind === 'pgs') {
      const ds = this.parsePgs(p);
      if (!ds || ds.objects.length === 0) return null;
    }
    return p;
  }

  private parsePgs(p: BitmapSubtitlePacket): PgsDisplaySet | null {
    let ds = this.pgsParsed.get(p);
    if (ds === undefined) {
      try { ds = parsePgsDisplaySet(p.data); } catch { ds = null; }
      this.pgsParsed.set(p, ds);
    }
    return ds;
  }

  /** Decodes (and caches) the bitmaps of a packet returned by activeBitmap(). */
  decode(p: BitmapSubtitlePacket): DecodedComposition | null {
    if (this.decoded.has(p)) {
      const hit = this.decoded.get(p)!;
      this.decoded.delete(p);
      this.decoded.set(p, hit); // LRU touch
      return hit;
    }
    let result: DecodedComposition | null = null;
    try {
      if (this.kind === 'vobsub') {
        result = decodeVobSubPacket(p.data, this.vobIdx || parseVobSubIdx(undefined));
      } else if (this.kind === 'pgs') {
        const idx = this.packets.indexOf(p);
        if (idx >= 0) {
          // Earlier display sets in the same epoch may define objects/palettes this one reuses
          const from = Math.max(0, idx - 16);
          const window = this.packets.slice(from, idx + 1).map(x => this.parsePgs(x));
          result = renderPgsComposition(window, window.length - 1);
        }
      }
    } catch {
      result = null;
    }
    this.decoded.set(p, result);
    while (this.decoded.size > 24) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) break;
      this.decoded.delete(oldest);
    }
    return result;
  }
}
