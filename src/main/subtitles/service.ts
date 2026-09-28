import { spawn } from 'child_process';
import { ByteSource, openByteSource, RangeNotSupportedError } from './byte-source';
import {
  readMkvIndex, mapStreamIndexToTrack, extractTrackViaCues, cueCoverage, decodeCodecPrivate,
  isMatroskaSignature, MkvIndex, MkvTrack, RawSubtitlePacket, MKV_TRACK_TYPE
} from './mkv';
import { readMp4Info, extractMp4TextTrack, isMp4Signature, MP4_TEXT_ENTRIES } from './mp4';
import { FfmpegSubtitleStream } from './ffmpeg-stream';
import { resolveFfmpegPath, resolveFfprobePath } from '../binary-resolver';
import { createMkvTextContext, textFromMkvFrame, MkvTextContext } from '../../shared/subtitles/text';
import { readVobSubTiming } from '../../shared/subtitles/vobsub';
import { groupPgsSegmentPackets, pgsPacketEndsDisplaySet } from '../../shared/subtitles/pgs';
import type {
  BitmapSubtitlePacket, SubtitleCue, SubtitleRenderKind, SubtitleSessionEvent, SubtitleSessionRequest,
  SubtitleTrackHeader, SubtitleExtractionMethod
} from '../../shared/subtitles/types';

type Send = (evt: SubtitleSessionEvent) => void;

interface CachedTrack {
  header: SubtitleTrackHeader;
  cues: SubtitleCue[];
  packets: BitmapSubtitlePacket[];
  method: SubtitleExtractionMethod;
  bytes: number;
}

const TEXT_CODEC_IDS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASCII', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_ASS', 'S_SSA', 'S_TEXT/WEBVTT']);
const MAX_CACHE_BYTES = 160 * 1024 * 1024;

export function kindForMkvCodec(codecId: string): SubtitleRenderKind | null {
  const c = codecId.toUpperCase();
  if (TEXT_CODEC_IDS.has(c) || c.startsWith('D_WEBVTT')) return 'text';
  if (c === 'S_HDMV/PGS') return 'pgs';
  if (c === 'S_VOBSUB') return 'vobsub';
  return null;
}

export function kindForFfmpegCodec(codec: string | undefined): SubtitleRenderKind | 'unsupported' {
  const c = (codec || '').toLowerCase();
  if (c === 'hdmv_pgs_subtitle' || c === 'pgssub') return 'pgs';
  if (c === 'dvd_subtitle' || c === 'dvdsub') return 'vobsub';
  if (c === 'dvb_subtitle' || c === 'xsub' || c === 'dvb_teletext' || c === 'eia_608' || c === 'arib_caption') return 'unsupported';
  return 'text';
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Converts raw container frames into cues / bitmap packets for one track. */
class PacketConverter {
  private textCtx: MkvTextContext | null = null;
  private pgsPending: RawSubtitlePacket[] = [];

  constructor(public readonly header: SubtitleTrackHeader, codecPrivate?: Uint8Array) {
    if (header.kind === 'text') this.textCtx = createMkvTextContext(header.codecId, codecPrivate);
  }

  toCues(packets: RawSubtitlePacket[]): SubtitleCue[] {
    const out: SubtitleCue[] = [];
    if (!this.textCtx) return out;
    for (const p of packets) {
      const res = textFromMkvFrame(this.textCtx, p.data);
      if (!res) continue;
      const dur = p.durationMs && p.durationMs > 0 ? p.durationMs : 4000;
      out.push({
        id: `${Math.round(p.startMs)}:${hashText(res.text)}`,
        startMs: p.startMs,
        endMs: p.startMs + dur,
        text: res.text,
        ...(res.align ? { align: res.align } : {})
      });
    }
    return out;
  }

  /**
   * Bitmap packets. `ordered` means packets arrive in time order (ffmpeg stream), which lets
   * PGS segments that were muxed one-per-packet be regrouped into display sets on the fly.
   */
  toBitmaps(packets: RawSubtitlePacket[], ordered: boolean): BitmapSubtitlePacket[] {
    const out: BitmapSubtitlePacket[] = [];
    for (const p of packets) {
      if (this.header.kind === 'vobsub') {
        const timing = readVobSubTiming(p.data);
        const start = p.startMs + (timing?.startDelayMs || 0);
        let end: number | undefined;
        if (timing?.stopDelayMs !== undefined && timing.stopDelayMs > (timing.startDelayMs || 0)) end = p.startMs + timing.stopDelayMs;
        else if (p.durationMs && p.durationMs > 0) end = p.startMs + p.durationMs;
        out.push({ startMs: start, endMs: end, data: p.data });
      } else if (this.header.kind === 'pgs') {
        if (ordered && (this.pgsPending.length > 0 || !pgsPacketEndsDisplaySet(p.data))) {
          this.pgsPending.push(p);
          if (pgsPacketEndsDisplaySet(p.data)) {
            const grouped = groupPgsSegmentPackets(this.pgsPending.map(x => ({ startMs: x.startMs, data: x.data })));
            this.pgsPending = [];
            out.push(...grouped);
          }
          continue;
        }
        out.push({ startMs: p.startMs, endMs: p.durationMs ? p.startMs + p.durationMs : undefined, data: p.data });
      }
    }
    return out;
  }
}

interface CoverageSegment {
  fromMs: number;
  untilMs: number;
  reachedEnd: boolean;
  stream: FfmpegSubtitleStream | null;
}

class Session {
  cancelled = false;
  readonly abort = new AbortController();
  header: SubtitleTrackHeader | null = null;
  converter: PacketConverter | null = null;
  cues: SubtitleCue[] = [];
  packets: BitmapSubtitlePacket[] = [];
  seen = new Set<string>();
  mode: 'probing' | 'index' | 'ffmpeg' | 'done' = 'probing';
  method: SubtitleExtractionMethod = 'mkv-index';
  playheadMs: number;
  segments: CoverageSegment[] = [];
  startedAt = Date.now();
  receivedAnything = false;
  lastError = '';
  ffmpegFailures = 0;
  private pendingCues: SubtitleCue[] = [];
  private pendingPackets: BitmapSubtitlePacket[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly req: SubtitleSessionRequest, private readonly sendRaw: Send) {
    this.playheadMs = req.startTimeMs || 0;
  }

  send(evt: Omit<SubtitleSessionEvent, 'sessionId'>) {
    if (this.cancelled) return;
    try {
      this.sendRaw({ sessionId: this.req.sessionId, ...evt });
    } catch { /* window closed */ }
  }

  setHeader(header: SubtitleTrackHeader, codecPrivate?: Uint8Array) {
    const changed = !this.header || this.header.kind !== header.kind || this.header.codecId !== header.codecId;
    this.header = header;
    if (!this.converter || changed) this.converter = new PacketConverter(header, codecPrivate);
    this.send({ type: 'header', header });
  }

  addCues(cues: SubtitleCue[]) {
    for (const c of cues) {
      if (this.seen.has(c.id)) continue;
      this.seen.add(c.id);
      this.cues.push(c);
      this.pendingCues.push(c);
      this.receivedAnything = true;
    }
    this.scheduleFlush();
  }

  addPackets(packets: BitmapSubtitlePacket[]) {
    for (const p of packets) {
      const key = `${Math.round(p.startMs)}:${p.data.length}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.packets.push(p);
      this.pendingPackets.push(p);
      this.receivedAnything = true;
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 100);
  }

  flush(progress?: SubtitleSessionEvent['progress']) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const CHUNK = 500;
    while (this.pendingCues.length > 0) {
      this.send({ type: 'data', cues: this.pendingCues.splice(0, CHUNK), method: this.method });
    }
    while (this.pendingPackets.length > 0) {
      this.send({ type: 'data', packets: this.pendingPackets.splice(0, 60), method: this.method });
    }
    if (progress) this.send({ type: 'progress', progress, method: this.method });
  }

  itemCount() {
    return this.header?.kind === 'text' ? this.cues.length : this.packets.length;
  }

  dispose() {
    this.cancelled = true;
    this.abort.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const s of this.segments) s.stream?.stop();
  }
}

export class SubtitleService {
  private sessions = new Map<string, Session>();
  private cache = new Map<string, CachedTrack>();
  private mkvIndexCache = new Map<string, Promise<MkvIndex>>();

  private cacheKey(url: string, streamIndex: number) {
    return `${url}#${streamIndex}`;
  }

  start(req: SubtitleSessionRequest, send: Send): void {
    // One active subtitle session per video keeps bandwidth for playback
    for (const [id, s] of this.sessions) {
      if (id === req.sessionId || s.req.videoUrl === req.videoUrl) {
        s.dispose();
        this.sessions.delete(id);
      }
    }
    const session = new Session(req, send);
    this.sessions.set(req.sessionId, session);
    this.run(session).catch((err) => {
      if (session.cancelled) return;
      session.flush();
      session.send({ type: 'error', error: err?.message || String(err), elapsedMs: Date.now() - session.startedAt });
      this.sessions.delete(req.sessionId);
    });
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.dispose();
      this.sessions.delete(sessionId);
    }
  }

  cancelAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  /** Playback position updates; drives seek-aware restarts and pausing of the ffmpeg fallback. */
  updatePlayhead(sessionId: string, timeMs: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.cancelled) return;
    s.playheadMs = timeMs;
    if (s.mode !== 'ffmpeg') return;

    const covered = s.segments.some(seg =>
      timeMs >= seg.fromMs - 3000 && (seg.reachedEnd || timeMs <= seg.untilMs + 45000)
    );
    const running = s.segments.find(seg => seg.stream?.running);
    if (!covered) {
      this.startFfmpegSegment(s, timeMs);
      return;
    }
    if (running?.stream) {
      const ahead = running.untilMs - timeMs;
      if (ahead > 15 * 60 * 1000) running.stream.setPaused(true);
      else if (ahead < 5 * 60 * 1000) running.stream.setPaused(false);
    }
  }

  getMkvIndex(url: string, src?: ByteSource): Promise<MkvIndex> {
    let p = this.mkvIndexCache.get(url);
    if (!p) {
      const own = !src;
      const source = src || openByteSource(url);
      p = readMkvIndex(source).finally(() => {
        if (own) source.close();
      });
      p.catch(() => this.mkvIndexCache.delete(url));
      this.mkvIndexCache.set(url, p);
      if (this.mkvIndexCache.size > 12) {
        const oldest = this.mkvIndexCache.keys().next().value;
        if (oldest !== undefined) this.mkvIndexCache.delete(oldest);
      }
    }
    return p;
  }

  // -------------------------------------------------------------------------

  private async run(s: Session): Promise<void> {
    const { req } = s;
    const key = this.cacheKey(req.videoUrl, req.streamIndex);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached); // LRU touch
      s.method = 'memory-cache';
      s.setHeader(cached.header);
      s.addCues(cached.cues);
      s.addPackets(cached.packets);
      s.flush();
      s.mode = 'done';
      s.send({ type: 'complete', method: 'memory-cache', totalItems: cached.cues.length + cached.packets.length, elapsedMs: Date.now() - s.startedAt });
      this.sessions.delete(req.sessionId);
      return;
    }

    const src = openByteSource(req.videoUrl, s.abort.signal);
    try {
      let head: Buffer | null = null;
      try {
        head = await src.read(0, 64);
      } catch (err) {
        if (!(err instanceof RangeNotSupportedError)) throw err;
      }
      if (s.cancelled) return;

      if (head && isMatroskaSignature(head)) {
        if (await this.tryMkvIndex(s, src)) return;
      } else if (head && isMp4Signature(head)) {
        if (await this.tryMp4Index(s, src)) return;
      }
    } finally {
      src.close();
    }
    if (s.cancelled) return;
    this.startFfmpegFallback(s);
  }

  private async tryMkvIndex(s: Session, src: ByteSource): Promise<boolean> {
    const { req } = s;
    let index: MkvIndex;
    try {
      index = await this.getMkvIndex(req.videoUrl, src);
    } catch (err: any) {
      s.lastError = `Matroska index: ${err?.message || err}`;
      return false;
    }
    if (s.cancelled) return true;
    const track = mapStreamIndexToTrack(index, req.streamIndex, req.streamTypes);
    if (!track) return false;
    const kind = kindForMkvCodec(track.codecId);
    if (!kind) {
      if (track.codecId.toUpperCase() === 'S_DVBSUB') throw new Error('DVB bitmap subtitles are not supported. Pick another subtitle track.');
      return false; // let ffmpeg convert unusual text codecs
    }
    const cov = cueCoverage(index, track.number);
    if (cov.count === 0 || cov.withRelative < cov.count) {
      s.lastError = cov.count === 0 ? 'No index entries for subtitle track' : 'Index lacks block positions';
      return false;
    }

    const codecPrivate = decodeCodecPrivate(track);
    s.mode = 'index';
    s.method = 'mkv-index';
    s.setHeader({
      kind,
      codecId: track.codecId,
      vobsubIdx: kind === 'vobsub' && codecPrivate ? new TextDecoder('utf-8').decode(codecPrivate) : undefined
    }, codecPrivate);

    const converter = s.converter!;
    // PGS muxed one segment per block cannot be shown until neighbours are known; hold those
    let holdPgs = false;
    const held: RawSubtitlePacket[] = [];
    let result;
    try {
      result = await extractTrackViaCues(src, index, track, {
        getPriorityMs: () => s.playheadMs,
        concurrency: 4,
        backgroundConcurrency: 2,
        shouldStop: () => s.cancelled,
        onPackets: (batch, loaded, total) => {
          if (kind === 'text') s.addCues(converter.toCues(batch));
          else if (kind === 'pgs') {
            if (!holdPgs && batch.some(p => !pgsPacketEndsDisplaySet(p.data))) holdPgs = true;
            if (holdPgs) held.push(...batch);
            else s.addPackets(converter.toBitmaps(batch, false));
          } else s.addPackets(converter.toBitmaps(batch, false));
          s.flush({ loaded, total });
        }
      });
    } catch (err: any) {
      if (s.cancelled) return true;
      s.lastError = `Index extraction: ${err?.message || err}`;
      // Partial data already delivered stays; the stream fallback fills in the rest (deduplicated)
      return false;
    }
    if (s.cancelled) return true;

    if (holdPgs) {
      const all = [...held].sort((a, b) => a.startMs - b.startMs);
      s.addPackets(groupPgsSegmentPackets(all.map(p => ({ startMs: p.startMs, data: p.data }))));
    }
    s.flush({ loaded: result.total, total: result.total });
    this.finish(s, 'mkv-index');
    return true;
  }

  private async tryMp4Index(s: Session, src: ByteSource): Promise<boolean> {
    const { req } = s;
    let info;
    try {
      info = await readMp4Info(src);
    } catch (err: any) {
      s.lastError = `MP4 index: ${err?.message || err}`;
      return false;
    }
    if (s.cancelled) return true;
    const track = info.tracks.find(t => t.index === req.streamIndex);
    if (!track || !['sbtl', 'text', 'subt'].includes(track.handler) || !MP4_TEXT_ENTRIES.has(track.sampleEntry)) return false;

    s.mode = 'index';
    s.method = 'mp4-index';
    s.setHeader({ kind: 'text', codecId: `MP4/${track.sampleEntry.toUpperCase()}` });
    try {
      await extractMp4TextTrack(src, track, {
        priorityTimeMs: s.playheadMs,
        shouldStop: () => s.cancelled,
        onCues: (batch, loaded, total) => {
          s.addCues(batch);
          s.flush({ loaded, total });
        }
      });
    } catch (err: any) {
      if (s.cancelled) return true;
      s.lastError = `MP4 extraction: ${err?.message || err}`;
      return false;
    }
    if (s.cancelled) return true;
    s.flush();
    this.finish(s, 'mp4-index');
    return true;
  }

  private startFfmpegFallback(s: Session) {
    const kind = kindForFfmpegCodec(s.req.codec);
    if (kind === 'unsupported') {
      throw new Error(`${(s.req.codec || 'This').toUpperCase()} subtitles are not supported. Pick another subtitle track.`);
    }
    const ff = resolveFfmpegPath();
    if (!ff.available) {
      throw new Error(`Subtitle index not usable (${s.lastError || 'unknown container'}) and ffmpeg is not installed for the streaming fallback.`);
    }
    s.mode = 'ffmpeg';
    s.method = 'ffmpeg-stream';
    this.startFfmpegSegment(s, s.playheadMs);
  }

  private startFfmpegSegment(s: Session, fromMs: number, withProgressClock = true) {
    // Only one ffmpeg reader per session
    for (const seg of s.segments) {
      seg.stream?.stop();
      seg.stream = null;
    }

    const codec = (s.req.codec || '').toLowerCase();
    const expectedKind = kindForFfmpegCodec(codec);
    const pending: RawSubtitlePacket[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let segmentBlocks = 0;
    let seg: CoverageSegment;

    const flushPending = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (s.converter && pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        if (s.header?.kind === 'text') s.addCues(s.converter.toCues(batch));
        else s.addPackets(s.converter.toBitmaps(batch, true));
      }
      s.flush({ coveredFromMs: seg.fromMs, coveredUntilMs: seg.untilMs });
    };

    const advance = (ms: number) => {
      seg.untilMs = Math.max(seg.untilMs, ms);
      // Ran into an already covered region: stop, the rest is known
      const next = s.segments.find(o => o !== seg && o.fromMs > seg.fromMs && seg.untilMs >= o.fromMs);
      if (next) {
        seg.untilMs = Math.max(seg.untilMs, next.untilMs);
        seg.reachedEnd = seg.reachedEnd || next.reachedEnd;
        s.segments = s.segments.filter(o => o !== next);
        stream.stop();
      }
      if (!flushTimer) flushTimer = setTimeout(flushPending, 150);
    };

    const stream: FfmpegSubtitleStream = new FfmpegSubtitleStream(s.req.videoUrl, s.req.streamIndex, codec, fromMs, {
      onTrack: (track: MkvTrack) => {
        const kind = kindForMkvCodec(track.codecId) || (expectedKind === 'unsupported' ? 'text' : expectedKind);
        const cp = decodeCodecPrivate(track);
        if (!s.header || s.header.kind !== kind || s.header.codecId !== track.codecId) {
          s.setHeader({
            kind,
            codecId: track.codecId,
            vobsubIdx: kind === 'vobsub' && cp ? new TextDecoder('utf-8').decode(cp) : undefined
          }, cp);
        }
      },
      onBlock: (block) => {
        segmentBlocks++;
        pending.push(block);
        advance(block.startMs);
      },
      onProgress: (ms) => advance(ms),
      onExit: ({ code, stderr, reachedEnd, stoppedByUs }) => {
        flushPending();
        if (s.cancelled) return;
        if (seg.stream === stream) seg.stream = null;
        if (reachedEnd) seg.reachedEnd = true;
        if (!stoppedByUs && !reachedEnd) {
          s.ffmpegFailures++;
          if (withProgressClock && segmentBlocks === 0) {
            // Retry without the audio clock in case the audio codec cannot be muxed
            s.segments = s.segments.filter(o => o !== seg);
            this.startFfmpegSegment(s, fromMs, false);
            return;
          }
          if (s.ffmpegFailures > 4 || !s.receivedAnything) {
            const detail = stderr.split('\n').filter(Boolean).slice(-2).join(' ') || `exit code ${code}`;
            s.send({ type: 'error', error: `ffmpeg subtitle extraction failed: ${detail}`, elapsedMs: Date.now() - s.startedAt });
            this.sessions.delete(s.req.sessionId);
            s.dispose();
            return;
          }
        }
        this.afterSegmentExit(s);
      }
    }, withProgressClock);

    seg = { fromMs: stream.seekMs, untilMs: stream.seekMs, reachedEnd: false, stream };
    s.segments.push(seg);
    stream.start();
  }

  /** When the forward pass hits the end, backfill the part before the first segment. */
  private afterSegmentExit(s: Session) {
    if (s.cancelled || s.segments.some(seg => seg.stream?.running)) return;
    const sorted = [...s.segments].sort((a, b) => a.fromMs - b.fromMs);
    // Merge overlapping segments
    const merged: CoverageSegment[] = [];
    for (const seg of sorted) {
      const last = merged[merged.length - 1];
      if (last && seg.fromMs <= last.untilMs + 1000) {
        last.untilMs = Math.max(last.untilMs, seg.untilMs);
        last.reachedEnd = last.reachedEnd || seg.reachedEnd;
      } else merged.push({ ...seg, stream: null });
    }
    s.segments = merged;
    const first = merged[0];
    if (first && first.fromMs <= 1000 && first.reachedEnd) {
      s.flush();
      this.finish(s, 'ffmpeg-stream');
      return;
    }
    // Fill the earliest gap: before the first segment, or after a segment that did not reach the end
    if (first && first.fromMs > 1000) {
      this.startFfmpegSegment(s, 0);
      return;
    }
    const gap = merged.find(seg => !seg.reachedEnd);
    if (gap) this.startFfmpegSegment(s, gap.untilMs + 8000);
  }

  private finish(s: Session, method: SubtitleExtractionMethod) {
    s.mode = 'done';
    const header = s.header;
    const total = s.itemCount();
    s.send({ type: 'complete', method, totalItems: total, elapsedMs: Date.now() - s.startedAt });
    if (header) {
      const bytes = s.packets.reduce((a, p) => a + p.data.length, 0) + s.cues.reduce((a, c) => a + c.text.length * 2 + 64, 0);
      this.putCache(this.cacheKey(s.req.videoUrl, s.req.streamIndex), {
        header, cues: s.cues, packets: s.packets, method, bytes
      });
    }
    this.sessions.delete(s.req.sessionId);
  }

  private putCache(key: string, entry: CachedTrack) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    let total = 0;
    for (const e of this.cache.values()) total += e.bytes;
    while (total > MAX_CACHE_BYTES && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value as string;
      total -= this.cache.get(oldestKey)?.bytes || 0;
      this.cache.delete(oldestKey);
    }
  }

  // -------------------------------------------------------------------------
  // Keyframe lookup used by the audio remuxer so its timeline offset is exact
  // -------------------------------------------------------------------------

  async findVideoKeyframeMs(url: string, targetMs: number): Promise<number | null> {
    try {
      const index = await this.getMkvIndex(url);
      const video = index.tracks.find(t => t.type === MKV_TRACK_TYPE.video);
      const cues = video ? index.cuesByTrack.get(video.number) : undefined;
      if (cues && cues.length > 0) {
        const scale = index.timestampScale / 1e6;
        let lo = 0;
        let hi = cues.length - 1;
        let best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (cues[mid].timeTicks * scale <= targetMs + 1) {
            best = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        if (best >= 0) return cues[best].timeTicks * scale;
        return 0;
      }
    } catch {
      // not Matroska or unreadable index: fall through to ffprobe
    }
    return this.probeKeyframeMs(url, targetMs);
  }

  private probeKeyframeMs(url: string, targetMs: number): Promise<number | null> {
    const probe = resolveFfprobePath();
    if (!probe.available || !probe.path) return Promise.resolve(null);
    const t = targetMs / 1000;
    const from = Math.max(0, t - 20);
    return new Promise((resolve) => {
      const proc = spawn(probe.path!, [
        '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${from.toFixed(3)}%${(t + 0.5).toFixed(3)}`,
        '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', url
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 8000);
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('error', () => { clearTimeout(timer); resolve(null); });
      proc.on('close', () => {
        clearTimeout(timer);
        let best: number | null = null;
        for (const line of out.split('\n')) {
          const [pts, flags] = line.split(',');
          const v = Number(pts);
          if (Number.isFinite(v) && flags && flags.includes('K') && v <= t + 0.001) {
            if (best === null || v > best) best = v;
          }
        }
        resolve(best !== null ? best * 1000 : null);
      });
    });
  }
}

export const subtitleService = new SubtitleService();
