import zlib from 'zlib';
import { ByteSource, runPrioritized } from './byte-source';
import {
  MKV, TOP_LEVEL_IDS, EbmlElement, children, readElementHeader, readFloat, readString, readUInt,
  parseBlockPayload, readId, readVint
} from './ebml';

export interface MkvContentEncoding {
  order: number;
  scope: number;
  type: number;
  compAlgo: number;
  compSettings?: Uint8Array;
}

export interface MkvTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  name?: string;
  language?: string;
  flagEnabled: boolean;
  flagDefault: boolean;
  flagForced: boolean;
  flagHearingImpaired: boolean;
  flagCommentary: boolean;
  encodings: MkvContentEncoding[];
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface MkvCueRef {
  timeTicks: number;
  clusterPosition: number;
  relativePosition?: number;
  durationTicks?: number;
}

export interface MkvIndex {
  segmentDataStart: number;
  timestampScale: number;
  durationMs?: number;
  tracks: MkvTrack[];
  cuesByTrack: Map<number, MkvCueRef[]>;
  hasCues: boolean;
  /** Absolute offset of the first Cluster, if it was seen in the header scan. */
  firstClusterPos?: number;
}

export interface RawSubtitlePacket {
  startMs: number;
  durationMs?: number;
  data: Uint8Array;
}

export const MKV_TRACK_TYPE = { video: 1, audio: 2, complex: 3, logo: 0x10, subtitle: 0x11, buttons: 0x12, control: 0x20, metadata: 0x21 } as const;

export class MkvUnsupportedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MkvUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Element parsers
// ---------------------------------------------------------------------------

function parseInfo(buf: Uint8Array, el: EbmlElement): { timestampScale: number; duration?: number } {
  let timestampScale = 1000000;
  let duration: number | undefined;
  for (const c of children(buf, el.dataStart, el.end)) {
    if (c.id === MKV.TimestampScale) timestampScale = readUInt(buf, c.dataStart, c.dataSize) || 1000000;
    else if (c.id === MKV.Duration) duration = readFloat(buf, c.dataStart, c.dataSize);
  }
  return { timestampScale, duration };
}

function parseEncodings(buf: Uint8Array, el: EbmlElement): MkvContentEncoding[] {
  const out: MkvContentEncoding[] = [];
  for (const enc of children(buf, el.dataStart, el.end)) {
    if (enc.id !== MKV.ContentEncoding) continue;
    const e: MkvContentEncoding = { order: 0, scope: 1, type: 0, compAlgo: 0 };
    for (const c of children(buf, enc.dataStart, enc.end)) {
      if (c.id === MKV.ContentEncodingOrder) e.order = readUInt(buf, c.dataStart, c.dataSize);
      else if (c.id === MKV.ContentEncodingScope) e.scope = readUInt(buf, c.dataStart, c.dataSize);
      else if (c.id === MKV.ContentEncodingType) e.type = readUInt(buf, c.dataStart, c.dataSize);
      else if (c.id === MKV.ContentCompression) {
        for (const cc of children(buf, c.dataStart, c.end)) {
          if (cc.id === MKV.ContentCompAlgo) e.compAlgo = readUInt(buf, cc.dataStart, cc.dataSize);
          else if (cc.id === MKV.ContentCompSettings) e.compSettings = buf.slice(cc.dataStart, cc.end);
        }
      }
    }
    out.push(e);
  }
  return out.sort((a, b) => b.order - a.order);
}

export function parseTracks(buf: Uint8Array, el: EbmlElement): MkvTrack[] {
  const tracks: MkvTrack[] = [];
  for (const te of children(buf, el.dataStart, el.end)) {
    if (te.id !== MKV.TrackEntry) continue;
    const t: MkvTrack = {
      number: 0, type: 0, codecId: '', flagEnabled: true, flagDefault: true, flagForced: false,
      flagHearingImpaired: false, flagCommentary: false, encodings: []
    };
    let bcp47: string | undefined;
    for (const c of children(buf, te.dataStart, te.end)) {
      switch (c.id) {
        case MKV.TrackNumber: t.number = readUInt(buf, c.dataStart, c.dataSize); break;
        case MKV.TrackType: t.type = readUInt(buf, c.dataStart, c.dataSize); break;
        case MKV.FlagEnabled: t.flagEnabled = readUInt(buf, c.dataStart, c.dataSize) !== 0; break;
        case MKV.FlagDefault: t.flagDefault = readUInt(buf, c.dataStart, c.dataSize) !== 0; break;
        case MKV.FlagForced: t.flagForced = readUInt(buf, c.dataStart, c.dataSize) !== 0; break;
        case MKV.FlagHearingImpaired: t.flagHearingImpaired = readUInt(buf, c.dataStart, c.dataSize) !== 0; break;
        case MKV.FlagCommentary: t.flagCommentary = readUInt(buf, c.dataStart, c.dataSize) !== 0; break;
        case MKV.CodecID: t.codecId = readString(buf, c.dataStart, c.dataSize); break;
        case MKV.CodecPrivate: t.codecPrivate = buf.slice(c.dataStart, c.end); break;
        case MKV.Name: t.name = readString(buf, c.dataStart, c.dataSize); break;
        case MKV.Language: t.language = readString(buf, c.dataStart, c.dataSize); break;
        case MKV.LanguageBCP47: bcp47 = readString(buf, c.dataStart, c.dataSize); break;
        case MKV.ContentEncodings: t.encodings = parseEncodings(buf, c); break;
        case MKV.Video:
          for (const v of children(buf, c.dataStart, c.end)) {
            if (v.id === MKV.PixelWidth) t.pixelWidth = readUInt(buf, v.dataStart, v.dataSize);
            else if (v.id === MKV.PixelHeight) t.pixelHeight = readUInt(buf, v.dataStart, v.dataSize);
          }
          break;
      }
    }
    if (!t.language && bcp47) t.language = bcp47;
    if (!t.language) t.language = 'eng'; // Matroska default language
    tracks.push(t);
  }
  return tracks;
}

function parseCues(buf: Uint8Array, el: EbmlElement): Map<number, MkvCueRef[]> {
  const map = new Map<number, MkvCueRef[]>();
  for (const cp of children(buf, el.dataStart, el.end)) {
    if (cp.id !== MKV.CuePoint) continue;
    let time = 0;
    const positions: { track: number; cluster: number; rel?: number; dur?: number }[] = [];
    for (const c of children(buf, cp.dataStart, cp.end)) {
      if (c.id === MKV.CueTime) time = readUInt(buf, c.dataStart, c.dataSize);
      else if (c.id === MKV.CueTrackPositions) {
        const p: { track: number; cluster: number; rel?: number; dur?: number } = { track: 0, cluster: -1 };
        for (const d of children(buf, c.dataStart, c.end)) {
          if (d.id === MKV.CueTrack) p.track = readUInt(buf, d.dataStart, d.dataSize);
          else if (d.id === MKV.CueClusterPosition) p.cluster = readUInt(buf, d.dataStart, d.dataSize);
          else if (d.id === MKV.CueRelativePosition) p.rel = readUInt(buf, d.dataStart, d.dataSize);
          else if (d.id === MKV.CueDuration) p.dur = readUInt(buf, d.dataStart, d.dataSize);
        }
        if (p.cluster >= 0) positions.push(p);
      }
    }
    for (const p of positions) {
      let arr = map.get(p.track);
      if (!arr) {
        arr = [];
        map.set(p.track, arr);
      }
      arr.push({ timeTicks: time, clusterPosition: p.cluster, relativePosition: p.rel, durationTicks: p.dur });
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.timeTicks - b.timeTicks);
  return map;
}

/**
 * Tracks that ffmpeg exposes as streams, in ffprobe stream-index order.
 * libavformat skips entries without a CodecID and entries of unsupported types.
 */
export function ffmpegVisibleTracks(tracks: MkvTrack[]): MkvTrack[] {
  const allowed = new Set<number>([MKV_TRACK_TYPE.video, MKV_TRACK_TYPE.audio, MKV_TRACK_TYPE.subtitle, MKV_TRACK_TYPE.metadata]);
  return tracks.filter(t => t.codecId && allowed.has(t.type));
}

/**
 * Maps an ffprobe stream index to the Matroska track, verifying stream types line up.
 * Falls back to matching the n-th subtitle stream with the n-th subtitle track.
 */
export function mapStreamIndexToTrack(
  index: MkvIndex,
  streamIndex: number,
  probeTypes?: string[]
): MkvTrack | null {
  const visible = ffmpegVisibleTracks(index.tracks);
  const typeName = (t: MkvTrack) => t.type === 1 ? 'video' : t.type === 2 ? 'audio' : t.type === 0x11 ? 'subtitle' : 'data';
  if (probeTypes && probeTypes.length > 0) {
    const aligned = visible.length >= probeTypes.length &&
      probeTypes.every((pt, i) => !pt || pt === 'attachment' || typeName(visible[i]) === pt);
    if (aligned && visible[streamIndex] && visible[streamIndex].type === MKV_TRACK_TYPE.subtitle) {
      return visible[streamIndex];
    }
    // Ordinal fallback among subtitle tracks
    const subOrdinal = probeTypes.slice(0, streamIndex).filter(t => t === 'subtitle').length;
    const subs = visible.filter(t => t.type === MKV_TRACK_TYPE.subtitle);
    return subs[subOrdinal] || null;
  }
  const t = visible[streamIndex];
  return t && t.type === MKV_TRACK_TYPE.subtitle ? t : null;
}

// ---------------------------------------------------------------------------
// Random-access index reader
// ---------------------------------------------------------------------------

async function readWholeElement(src: ByteSource, pos: number, maxSize = 64 * 1024 * 1024): Promise<{ buf: Uint8Array; el: EbmlElement } | null> {
  const head = await src.read(pos, 64);
  const el = readElementHeader(head, 0);
  if (!el || el.dataSize < 0 || el.dataSize > maxSize) return null;
  const total = el.headerLength + el.dataSize;
  const buf = total <= head.length ? head.subarray(0, total) : await src.read(pos, total);
  if (buf.length < total) return null;
  return { buf, el: readElementHeader(buf, 0)! };
}

export function isMatroskaSignature(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

export async function readMkvIndex(src: ByteSource): Promise<MkvIndex> {
  const HEAD_SIZE = 256 * 1024;
  const head = await src.read(0, HEAD_SIZE);
  if (!isMatroskaSignature(head)) throw new MkvUnsupportedError('Not a Matroska/WebM file');

  const ebml = readElementHeader(head, 0);
  if (!ebml || ebml.dataSize < 0) throw new MkvUnsupportedError('Corrupt EBML header');
  const seg = readElementHeader(head, ebml.end);
  if (!seg || seg.id !== MKV.Segment) throw new MkvUnsupportedError('Segment element not found');
  const segDataStart = seg.dataStart;

  let info: { timestampScale: number; duration?: number } | null = null;
  let tracks: MkvTrack[] | null = null;
  let cues: Map<number, MkvCueRef[]> | null = null;
  const seekPositions = new Map<number, number[]>();

  const parseSeekHead = (buf: Uint8Array, el: EbmlElement) => {
    for (const s of children(buf, el.dataStart, el.end)) {
      if (s.id !== MKV.Seek) continue;
      let sid = 0;
      let spos = -1;
      for (const c of children(buf, s.dataStart, s.end)) {
        if (c.id === MKV.SeekID) sid = readUInt(buf, c.dataStart, c.dataSize);
        else if (c.id === MKV.SeekPosition) spos = readUInt(buf, c.dataStart, c.dataSize);
      }
      if (sid && spos >= 0) {
        const list = seekPositions.get(sid) || [];
        list.push(segDataStart + spos);
        seekPositions.set(sid, list);
      }
    }
  };

  // 1. Scan level-1 elements available in the head buffer
  let pos = segDataStart;
  let firstClusterPos: number | undefined;
  while (pos < head.length) {
    const el = readElementHeader(head, pos);
    if (!el) break;
    if (el.id === MKV.Cluster) {
      firstClusterPos = pos;
      break;
    }
    if (el.dataSize < 0) break;
    const complete = el.end <= head.length;
    if (complete) {
      if (el.id === MKV.SeekHead) parseSeekHead(head, el);
      else if (el.id === MKV.Info) info = parseInfo(head, el);
      else if (el.id === MKV.Tracks) tracks = parseTracks(head, el);
      else if (el.id === MKV.Cues) cues = parseCues(head, el);
    } else {
      const list = seekPositions.get(el.id) || [];
      if (!list.includes(pos)) list.push(pos);
      seekPositions.set(el.id, list);
    }
    if (!TOP_LEVEL_IDS.has(el.id) && el.id !== MKV.Chapters) break;
    pos = el.end;
  }

  // 2. Follow secondary SeekHeads (commonly written at the end of the file)
  const visitedSeekHeads = new Set<number>();
  for (const shPos of [...(seekPositions.get(MKV.SeekHead) || [])]) {
    if (visitedSeekHeads.has(shPos) || shPos < head.length) continue;
    visitedSeekHeads.add(shPos);
    const res = await readWholeElement(src, shPos, 4 * 1024 * 1024);
    if (res && res.el.id === MKV.SeekHead) parseSeekHead(res.buf, res.el);
  }

  const loadFromSeek = async <T>(id: number, parser: (b: Uint8Array, e: EbmlElement) => T, maxSize?: number): Promise<T | null> => {
    for (const p of seekPositions.get(id) || []) {
      const res = await readWholeElement(src, p, maxSize);
      if (res && res.el.id === id) return parser(res.buf, res.el);
    }
    return null;
  };

  if (!info) info = await loadFromSeek(MKV.Info, parseInfo);
  if (!tracks) tracks = await loadFromSeek(MKV.Tracks, parseTracks, 32 * 1024 * 1024);
  if (!cues) cues = await loadFromSeek(MKV.Cues, parseCues, 64 * 1024 * 1024);

  if (!tracks) throw new MkvUnsupportedError('Tracks element not found');
  const timestampScale = info?.timestampScale || 1000000;

  return {
    segmentDataStart: segDataStart,
    timestampScale,
    durationMs: info?.duration !== undefined ? (info.duration * timestampScale) / 1e6 : undefined,
    tracks,
    cuesByTrack: cues || new Map(),
    hasCues: !!cues,
    firstClusterPos
  };
}

// ---------------------------------------------------------------------------
// Content encoding (compression) handling
// ---------------------------------------------------------------------------

export function checkEncodingsSupported(track: MkvTrack): string | null {
  for (const e of track.encodings) {
    if (e.type !== 0) return 'encrypted track';
    if (!(e.scope & 1)) continue;
    if (e.compAlgo !== 0 && e.compAlgo !== 3) return `unsupported compression algorithm ${e.compAlgo}`;
  }
  return null;
}

export function decodeFrame(track: MkvTrack, frame: Uint8Array): Uint8Array {
  let data = frame;
  for (const e of track.encodings) {
    if (!(e.scope & 1)) continue;
    if (e.compAlgo === 0) {
      data = new Uint8Array(zlib.inflateSync(data));
    } else if (e.compAlgo === 3 && e.compSettings) {
      const out = new Uint8Array(e.compSettings.length + data.length);
      out.set(e.compSettings, 0);
      out.set(data, e.compSettings.length);
      data = out;
    }
  }
  return data;
}

/** CodecPrivate may itself be compressed when ContentEncodingScope has bit 2 set. */
export function decodeCodecPrivate(track: MkvTrack): Uint8Array | undefined {
  if (!track.codecPrivate) return undefined;
  let data = track.codecPrivate;
  for (const e of track.encodings) {
    if (!(e.scope & 2)) continue;
    if (e.compAlgo === 0) {
      try { data = new Uint8Array(zlib.inflateSync(data)); } catch { /* keep raw */ }
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Fast extraction via the Cues index
// ---------------------------------------------------------------------------

export interface CueExtractionOptions {
  /** Media time to fetch first so subtitles around the playhead appear immediately. */
  priorityTimeMs?: number;
  /** Live playhead (re-read for every fetch so seeks redirect the queue). */
  getPriorityMs?: () => number;
  /** Parallel requests for blocks near the playhead. */
  concurrency?: number;
  /** Parallel requests for the rest of the track (kept low so video playback keeps its bandwidth). */
  backgroundConcurrency?: number;
  onPackets?: (batch: RawSubtitlePacket[], completed: number, total: number) => void;
  shouldStop?: () => boolean;
}

export interface CueExtractionResult {
  packets: RawSubtitlePacket[];
  total: number;
  failed: number;
}

export function cueCoverage(index: MkvIndex, trackNumber: number): { count: number; withRelative: number } {
  const cues = index.cuesByTrack.get(trackNumber) || [];
  return { count: cues.length, withRelative: cues.filter(c => c.relativePosition !== undefined).length };
}

export async function extractTrackViaCues(
  src: ByteSource,
  index: MkvIndex,
  track: MkvTrack,
  opts: CueExtractionOptions = {}
): Promise<CueExtractionResult> {
  const cues = index.cuesByTrack.get(track.number) || [];
  if (cues.length === 0) throw new MkvUnsupportedError('No Cues entries for this subtitle track');
  const missingRel = cues.filter(c => c.relativePosition === undefined).length;
  if (missingRel > 0) throw new MkvUnsupportedError('Cues lack CueRelativePosition; block lookup would require scanning clusters');
  const encErr = checkEncodingsSupported(track);
  if (encErr) throw new MkvUnsupportedError(encErr);

  const scale = index.timestampScale;
  const ticksToMs = (t: number) => (t * scale) / 1e6;

  // Fetch order follows the playhead: cues at/after it first, then the nearest earlier ones.
  const fixedPriority = opts.priorityTimeMs ?? 0;
  const getPriority = opts.getPriorityMs || (() => fixedPriority);
  const queue = cues.map((c) => ({ c, ms: ticksToMs(c.timeTicks) }));

  const clusterCache = new Map<number, Promise<{ dataStart: number; timestamp: number }>>();
  const readClusterHeader = (clusterAbs: number, prefetched?: Buffer) => {
    let p = clusterCache.get(clusterAbs);
    if (!p) {
      p = (async () => {
        const buf = prefetched && prefetched.length >= 64 ? prefetched : await src.read(clusterAbs, 96);
        const el = readElementHeader(buf, 0);
        if (!el || el.id !== MKV.Cluster) throw new Error(`No Cluster at ${clusterAbs}`);
        let timestamp = 0;
        let found = false;
        let p2 = el.dataStart;
        while (p2 < buf.length && !found) {
          const c = readElementHeader(buf, p2);
          if (!c || c.dataSize < 0 || c.end > buf.length) break;
          if (c.id === MKV.Timestamp) {
            timestamp = readUInt(buf, c.dataStart, c.dataSize);
            found = true;
          }
          p2 = c.end;
        }
        if (!found) {
          // Rare: large element before Timestamp; read a bigger window
          const big = await src.read(clusterAbs, 8192);
          for (const c of children(big, el.dataStart, big.length)) {
            if (c.id === MKV.Timestamp) {
              timestamp = readUInt(big, c.dataStart, c.dataSize);
              found = true;
              break;
            }
          }
        }
        if (!found) throw new Error(`Cluster at ${clusterAbs} has no Timestamp`);
        return { dataStart: clusterAbs + el.headerLength, timestamp };
      })();
      clusterCache.set(clusterAbs, p);
    }
    return p;
  };

  const packets: RawSubtitlePacket[] = [];
  let pending: RawSubtitlePacket[] = [];
  let completed = 0;
  let failed = 0;
  let lastFlush = Date.now();
  const flush = (force = false) => {
    if (!opts.onPackets) return;
    if (pending.length === 0) return;
    if (!force && pending.length < 40 && Date.now() - lastFlush < 120) return;
    const batch = pending;
    pending = [];
    lastFlush = Date.now();
    opts.onPackets(batch, completed, queue.length);
  };

  // Most text blocks and PGS "clear" sets fit in 2 KB; larger bitmaps fetch only their remainder
  const BLOCK_WINDOW = 2048;

  /** Validates that a SimpleBlock/BlockGroup for our track starts at `off` inside `buf`. */
  const blockAt = (buf: Uint8Array, off: number): EbmlElement | null => {
    const el = readElementHeader(buf, off);
    if (!el || el.dataSize <= 3 || (el.id !== MKV.SimpleBlock && el.id !== MKV.BlockGroup)) return null;
    let payloadStart = el.dataStart;
    if (el.id === MKV.BlockGroup) {
      // Block is practically always the first child; anything else goes through the slow path
      const inner = readElementHeader(buf, el.dataStart);
      if (!inner || inner.id !== MKV.Block) return null;
      payloadStart = inner.dataStart;
    }
    const tn = readVint(buf, payloadStart);
    if (!tn || tn.value !== track.number) return null;
    return el;
  };

  // Cluster header size varies per muxer (and per cluster for ffmpeg), so the block offset is
  // cluster + 4-byte ID + size-length(1..8) + rel. Reading a window that covers all candidates
  // and validating the block avoids a separate request for every cluster header.
  let preferredSizeLen = 0;

  const fetchBlock = async (c: MkvCueRef): Promise<{ buf: Uint8Array; el: EbmlElement; clusterTs?: number }> => {
    const clusterAbs = index.segmentDataStart + c.clusterPosition;
    const rel = c.relativePosition!;
    const base = clusterAbs + 5 + rel; // size length 1
    const window = await src.read(base, 7 + BLOCK_WINDOW);
    const order = preferredSizeLen ? [preferredSizeLen, 1, 2, 3, 4, 5, 6, 7, 8].filter((v, i, a) => a.indexOf(v) === i) : [8, 4, 3, 2, 1, 5, 6, 7];
    const matches: number[] = [];
    for (const len of order) {
      const off = len - 1;
      if (blockAt(window, off)) matches.push(len);
    }
    let buf: Uint8Array;
    let el: EbmlElement;
    let clusterTs: number | undefined;
    if (matches.length === 1 || (matches.length > 1 && matches[0] === preferredSizeLen)) {
      const len = matches[0];
      preferredSizeLen = len;
      buf = window.subarray(len - 1);
      el = readElementHeader(buf, 0)!;
    } else {
      // Ambiguous or not found: read the real cluster header
      const header = await readClusterHeader(clusterAbs);
      clusterTs = header.timestamp;
      const blockAbs = header.dataStart + rel;
      preferredSizeLen = header.dataStart - clusterAbs - 4;
      buf = await src.read(blockAbs, BLOCK_WINDOW);
      const e = readElementHeader(buf, 0);
      if (!e || e.dataSize < 0 || (e.id !== MKV.SimpleBlock && e.id !== MKV.BlockGroup)) throw new Error(`No block at ${blockAbs}`);
      el = e;
    }
    const total = el.headerLength + el.dataSize;
    if (buf.length < total) {
      const blockAbs = clusterAbs + 4 + preferredSizeLen + rel;
      const have = buf.length;
      const rest = await src.read(blockAbs + have, total - have);
      const full = new Uint8Array(total);
      full.set(buf.subarray(0, have), 0);
      full.set(rest, have);
      buf = full;
      el = readElementHeader(buf, 0)!;
    }
    return { buf, el, clusterTs };
  };

  // Many small random reads compete with the video's own sequential download on busy servers:
  // go wide only for the ~10 minutes around the playhead, then trickle the rest.
  const near = opts.concurrency ?? 4;
  const background = Math.min(near, opts.backgroundConcurrency ?? 2);
  const concurrencyFor = (nextMs: number, priorityMs: number) =>
    nextMs >= priorityMs - 60000 && nextMs <= priorityMs + 10 * 60000 ? near : background;

  await runPrioritized(queue, (q) => q.ms, concurrencyFor, getPriority, async ({ c }) => {
    try {
      const { buf: blockBuf, el, clusterTs } = await fetchBlock(c);

      let payload: Uint8Array | null = null;
      let durationTicks: number | undefined = c.durationTicks;
      if (el.id === MKV.SimpleBlock) {
        payload = blockBuf.subarray(el.dataStart, el.dataStart + el.dataSize);
      } else {
        for (const ch of children(blockBuf, el.dataStart, el.end)) {
          if (ch.id === MKV.Block) payload = blockBuf.subarray(ch.dataStart, ch.end);
          else if (ch.id === MKV.BlockDuration) durationTicks = readUInt(blockBuf, ch.dataStart, ch.dataSize);
        }
      }
      if (!payload) throw new Error('BlockGroup without Block');
      const block = parseBlockPayload(payload);
      if (!block || block.trackNumber !== track.number) throw new Error('Block belongs to a different track');

      // CueTime is the block's absolute timestamp; the cluster timestamp is only known on the slow path
      const startMs = clusterTs !== undefined ? ticksToMs(clusterTs + block.relativeTimecode) : ticksToMs(c.timeTicks);
      for (const frame of block.frames) {
        const pkt: RawSubtitlePacket = {
          startMs,
          durationMs: durationTicks !== undefined ? ticksToMs(durationTicks) : undefined,
          data: decodeFrame(track, frame)
        };
        packets.push(pkt);
        pending.push(pkt);
      }
    } catch (err) {
      if (opts.shouldStop?.()) return;
      failed++;
      if (failed > 20 && failed > queue.length * 0.05) throw err;
    } finally {
      completed++;
      flush();
    }
  }, opts.shouldStop);

  flush(true);
  packets.sort((a, b) => a.startMs - b.startMs);
  return { packets, total: queue.length, failed };
}

// ---------------------------------------------------------------------------
// Streaming parser for Matroska produced by ffmpeg on a pipe
// ---------------------------------------------------------------------------

export interface StreamBlock {
  trackNumber: number;
  startMs: number;
  durationMs?: number;
  frames: Uint8Array[];
}

export class MkvStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'ebml' | 'segment' | 'body' = 'ebml';
  private timestampScale = 1000000;
  private inUnknownCluster = false;
  private clusterTimestamp = 0;
  tracks: MkvTrack[] = [];

  constructor(
    private readonly onTracks: (tracks: MkvTrack[]) => void,
    private readonly onBlock: (block: StreamBlock) => void
  ) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let consumed = 0;
    for (;;) {
      const n = this.step(consumed);
      if (n <= 0) break;
      consumed += n;
    }
    if (consumed > 0) this.buf = this.buf.subarray(consumed);
  }

  /** Returns bytes consumed at offset, or 0 when more data is needed. */
  private step(offset: number): number {
    const buf = this.buf;
    const el = readElementHeader(buf, offset);
    if (!el) return 0;
    const rel = (x: number) => x - offset;

    if (this.state === 'ebml') {
      if (el.id !== MKV.EBML || el.dataSize < 0) throw new Error('Unexpected data before EBML header');
      if (el.end > buf.length) return 0;
      this.state = 'segment';
      return rel(el.end);
    }
    if (this.state === 'segment') {
      if (el.id !== MKV.Segment) throw new Error('Expected Segment');
      this.state = 'body';
      return el.headerLength;
    }

    // Inside an unknown-size cluster, children follow until the next level-1 element
    if (this.inUnknownCluster && !TOP_LEVEL_IDS.has(el.id)) {
      if (el.dataSize < 0 || el.end > buf.length) return el.dataSize < 0 ? rel(el.dataStart) : 0;
      this.handleClusterChild(buf, el);
      return rel(el.end);
    }
    this.inUnknownCluster = false;

    if (el.id === MKV.Cluster) {
      if (el.dataSize < 0) {
        this.inUnknownCluster = true;
        return el.headerLength;
      }
      if (el.end > buf.length) return 0;
      for (const c of children(buf, el.dataStart, el.end)) this.handleClusterChild(buf, c);
      return rel(el.end);
    }

    if (el.dataSize < 0) return el.headerLength; // unknown-size non-cluster: descend
    if (el.end > buf.length) return 0;
    if (el.id === MKV.Info) {
      this.timestampScale = parseInfo(buf, el).timestampScale;
    } else if (el.id === MKV.Tracks) {
      this.tracks = parseTracks(buf, el);
      this.onTracks(this.tracks);
    }
    return rel(el.end);
  }

  private handleClusterChild(buf: Uint8Array, c: EbmlElement) {
    const toMs = (t: number) => (t * this.timestampScale) / 1e6;
    if (c.id === MKV.Timestamp) {
      this.clusterTimestamp = readUInt(buf, c.dataStart, c.dataSize);
    } else if (c.id === MKV.SimpleBlock) {
      const b = parseBlockPayload(buf.subarray(c.dataStart, c.end));
      if (b) this.emit(b.trackNumber, toMs(this.clusterTimestamp + b.relativeTimecode), undefined, b.frames);
    } else if (c.id === MKV.BlockGroup) {
      let payload: Uint8Array | null = null;
      let dur: number | undefined;
      for (const g of children(buf, c.dataStart, c.end)) {
        if (g.id === MKV.Block) payload = buf.subarray(g.dataStart, g.end);
        else if (g.id === MKV.BlockDuration) dur = readUInt(buf, g.dataStart, g.dataSize);
      }
      if (payload) {
        const b = parseBlockPayload(payload);
        if (b) this.emit(b.trackNumber, toMs(this.clusterTimestamp + b.relativeTimecode), dur !== undefined ? toMs(dur) : undefined, b.frames);
      }
    }
  }

  private emit(trackNumber: number, startMs: number, durationMs: number | undefined, frames: Uint8Array[]) {
    const track = this.tracks.find(t => t.number === trackNumber);
    const decoded = track ? frames.map(f => decodeFrame(track, f)) : frames;
    // Copy out of the rolling buffer so data stays valid after trimming
    this.onBlock({ trackNumber, startMs, durationMs, frames: decoded.map(f => new Uint8Array(f)) });
  }
}

// Re-export for callers that need raw access
export { readId, readVint };
