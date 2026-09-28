import { ByteSource, runWithConcurrency } from './byte-source';
import type { SubtitleCue } from '../../shared/subtitles/types';
import { sanitizeSubtitleText } from '../../shared/subtitles/text';

/**
 * MP4 / MOV text subtitle extractor (tx3g / mov_text, 'text', 'wvtt').
 * Reads the moov sample tables and fetches only the subtitle samples.
 */

export class Mp4UnsupportedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Mp4UnsupportedError';
  }
}

interface Box {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

function readBoxHeader(buf: Uint8Array, pos: number, fileSize?: number): Box | null {
  if (pos + 8 > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = view.getUint32(pos);
  const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (pos + 16 > buf.length) return null;
    size = Number(view.getBigUint64(pos + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = fileSize !== undefined ? fileSize - pos : buf.length - pos;
  }
  if (size < headerSize) return null;
  return { type, start: pos, headerSize, size };
}

function* boxes(buf: Uint8Array, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const b = readBoxHeader(buf, pos);
    if (!b || pos + b.size > end) return;
    yield b;
    pos += b.size;
  }
}

function findChild(buf: Uint8Array, parent: Box, type: string, skip = 0): Box | null {
  for (const b of boxes(buf, parent.start + parent.headerSize + skip, parent.start + parent.size)) {
    if (b.type === type) return b;
  }
  return null;
}

export interface Mp4Track {
  index: number;
  trackId: number;
  handler: string;
  sampleEntry: string;
  timescale: number;
  /** Presentation offset (ms) derived from the edit list. */
  offsetMs: number;
  samples: { offset: number; size: number; startTicks: number; durationTicks: number }[];
}

export interface Mp4Info {
  movieTimescale: number;
  tracks: Mp4Track[];
}

export function isMp4Signature(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const t = String.fromCharCode(head[4], head[5], head[6], head[7]);
  return t === 'ftyp' || t === 'moov' || t === 'mdat' || t === 'wide' || t === 'free' || t === 'skip';
}

async function locateMoov(src: ByteSource): Promise<Uint8Array> {
  let pos = 0;
  for (let guard = 0; guard < 64; guard++) {
    const head = await src.read(pos, 16);
    if (head.length < 8) break;
    const box = readBoxHeader(head, 0, src.size !== null ? src.size - pos : undefined);
    if (!box) break;
    if (box.type === 'moov') {
      if (box.size > 256 * 1024 * 1024) throw new Mp4UnsupportedError('moov box too large');
      return src.read(pos, box.size);
    }
    if (box.type === 'moof') throw new Mp4UnsupportedError('Fragmented MP4');
    pos += box.size;
    if (src.size !== null && pos >= src.size) break;
  }
  throw new Mp4UnsupportedError('moov box not found');
}

function parseTrak(buf: Uint8Array, trak: Box, index: number, movieTimescale: number): Mp4Track | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tkhd = findChild(buf, trak, 'tkhd');
  const mdia = findChild(buf, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const tkVersion = buf[tkhd.start + tkhd.headerSize];
  const trackId = view.getUint32(tkhd.start + tkhd.headerSize + (tkVersion === 1 ? 20 : 12));

  const mdhd = findChild(buf, mdia, 'mdhd');
  const hdlr = findChild(buf, mdia, 'hdlr');
  const minf = findChild(buf, mdia, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const mdVersion = buf[mdhd.start + mdhd.headerSize];
  const timescale = view.getUint32(mdhd.start + mdhd.headerSize + (mdVersion === 1 ? 20 : 12)) || 1000;
  const h = hdlr.start + hdlr.headerSize + 8;
  const handler = String.fromCharCode(buf[h], buf[h + 1], buf[h + 2], buf[h + 3]);

  const stbl = findChild(buf, minf, 'stbl');
  if (!stbl) return null;
  const stsd = findChild(buf, stbl, 'stsd');
  let sampleEntry = '';
  if (stsd) {
    const e = stsd.start + stsd.headerSize + 8;
    if (e + 8 <= buf.length) sampleEntry = String.fromCharCode(buf[e + 4], buf[e + 5], buf[e + 6], buf[e + 7]);
  }

  // Edit list offset
  let offsetMs = 0;
  const edts = findChild(buf, trak, 'edts');
  const elst = edts ? findChild(buf, edts, 'elst') : null;
  if (elst) {
    const base = elst.start + elst.headerSize;
    const version = buf[base];
    const count = view.getUint32(base + 4);
    let p = base + 8;
    let emptyMs = 0;
    for (let i = 0; i < count; i++) {
      const segDur = version === 1 ? Number(view.getBigUint64(p)) : view.getUint32(p);
      const mediaTime = version === 1 ? Number(view.getBigInt64(p + 8)) : view.getInt32(p + 4);
      p += version === 1 ? 20 : 12;
      if (mediaTime === -1) {
        emptyMs += (segDur / (movieTimescale || 1000)) * 1000;
        continue;
      }
      offsetMs = emptyMs - (mediaTime / timescale) * 1000;
      break;
    }
  }

  const readTable = (type: string) => findChild(buf, stbl, type);
  const stts = readTable('stts');
  const stsz = readTable('stsz') || readTable('stz2');
  const stsc = readTable('stsc');
  const stco = readTable('stco');
  const co64 = readTable('co64');
  if (!stts || !stsz || !stsc || (!stco && !co64)) {
    return { index, trackId, handler, sampleEntry, timescale, offsetMs, samples: [] };
  }

  // Sample sizes
  const sizes: number[] = [];
  {
    const b = stsz.start + stsz.headerSize;
    if (stsz.type === 'stsz') {
      const fixed = view.getUint32(b + 4);
      const count = view.getUint32(b + 8);
      for (let i = 0; i < count; i++) sizes.push(fixed !== 0 ? fixed : view.getUint32(b + 12 + i * 4));
    } else {
      const fieldSize = buf[b + 7];
      const count = view.getUint32(b + 8);
      for (let i = 0; i < count; i++) {
        if (fieldSize === 16) sizes.push(view.getUint16(b + 12 + i * 2));
        else if (fieldSize === 8) sizes.push(buf[b + 12 + i]);
        else {
          const byte = buf[b + 12 + (i >> 1)];
          sizes.push(i & 1 ? byte & 0x0f : byte >> 4);
        }
      }
    }
  }
  const sampleCount = sizes.length;

  // Chunk offsets
  const chunkOffsets: number[] = [];
  if (co64) {
    const b = co64.start + co64.headerSize;
    const n = view.getUint32(b + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(Number(view.getBigUint64(b + 8 + i * 8)));
  } else if (stco) {
    const b = stco.start + stco.headerSize;
    const n = view.getUint32(b + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(view.getUint32(b + 8 + i * 4));
  }

  // Sample-to-chunk runs
  const runs: { firstChunk: number; perChunk: number }[] = [];
  {
    const b = stsc.start + stsc.headerSize;
    const n = view.getUint32(b + 4);
    for (let i = 0; i < n; i++) runs.push({ firstChunk: view.getUint32(b + 8 + i * 12), perChunk: view.getUint32(b + 12 + i * 12) });
  }

  // Time-to-sample
  const durations: number[] = [];
  {
    const b = stts.start + stts.headerSize;
    const n = view.getUint32(b + 4);
    for (let i = 0; i < n && durations.length < sampleCount; i++) {
      const count = view.getUint32(b + 8 + i * 8);
      const delta = view.getUint32(b + 12 + i * 8);
      for (let k = 0; k < count && durations.length < sampleCount; k++) durations.push(delta);
    }
  }

  const samples: Mp4Track['samples'] = [];
  let sampleIdx = 0;
  let ticks = 0;
  for (let r = 0; r < runs.length && sampleIdx < sampleCount; r++) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1].firstChunk - 1 : chunkOffsets.length;
    for (let chunk = runs[r].firstChunk; chunk <= lastChunk && sampleIdx < sampleCount; chunk++) {
      let offset = chunkOffsets[chunk - 1];
      if (offset === undefined) break;
      for (let s = 0; s < runs[r].perChunk && sampleIdx < sampleCount; s++) {
        const size = sizes[sampleIdx];
        const dur = durations[sampleIdx] ?? 0;
        samples.push({ offset, size, startTicks: ticks, durationTicks: dur });
        offset += size;
        ticks += dur;
        sampleIdx++;
      }
    }
  }
  return { index, trackId, handler, sampleEntry, timescale, offsetMs, samples };
}

export async function readMp4Info(src: ByteSource): Promise<Mp4Info> {
  const moov = await locateMoov(src);
  const root = readBoxHeader(moov, 0);
  if (!root || root.type !== 'moov') throw new Mp4UnsupportedError('Invalid moov');
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let movieTimescale = 1000;
  const mvhd = findChild(moov, root, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.start + mvhd.headerSize];
    movieTimescale = view.getUint32(mvhd.start + mvhd.headerSize + (v === 1 ? 20 : 12)) || 1000;
  }
  const tracks: Mp4Track[] = [];
  let index = 0;
  for (const b of boxes(moov, root.headerSize, root.size)) {
    if (b.type !== 'trak') continue;
    const t = parseTrak(moov, b, index, movieTimescale);
    if (t) tracks.push(t);
    index++;
  }
  return { movieTimescale, tracks };
}

function decodeTx3gSample(data: Uint8Array): string {
  if (data.length < 2) return '';
  const len = (data[0] << 8) | data[1];
  if (len === 0) return '';
  const body = data.subarray(2, 2 + len);
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2));
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le').decode(body.subarray(2));
  return new TextDecoder('utf-8').decode(body);
}

function decodeWvttSample(data: Uint8Array): string {
  const texts: string[] = [];
  for (const b of boxes(data, 0, data.length)) {
    if (b.type !== 'vttc') continue;
    for (const c of boxes(data, b.start + b.headerSize, b.start + b.size)) {
      if (c.type === 'payl') texts.push(new TextDecoder('utf-8').decode(data.subarray(c.start + c.headerSize, c.start + c.size)));
    }
  }
  return texts.join('\n');
}

export const MP4_TEXT_ENTRIES = new Set(['tx3g', 'text', 'wvtt']);

export async function extractMp4TextTrack(
  src: ByteSource,
  track: Mp4Track,
  opts: { priorityTimeMs?: number; onCues?: (batch: SubtitleCue[], done: number, total: number) => void; shouldStop?: () => boolean } = {}
): Promise<SubtitleCue[]> {
  if (!MP4_TEXT_ENTRIES.has(track.sampleEntry)) throw new Mp4UnsupportedError(`Unsupported MP4 subtitle sample entry '${track.sampleEntry}'`);
  const toMs = (ticks: number) => (ticks / track.timescale) * 1000 + track.offsetMs;
  const samples = track.samples.filter(s => s.size > 2);
  const p = opts.priorityTimeMs ?? 0;
  const ordered = [
    ...samples.filter(s => toMs(s.startTicks) >= p - 10000),
    ...samples.filter(s => toMs(s.startTicks) < p - 10000).reverse()
  ];
  const cues: SubtitleCue[] = [];
  let pending: SubtitleCue[] = [];
  let done = 0;
  let lastFlush = Date.now();
  // Low parallelism: random reads compete with the video's own download
  await runWithConcurrency(ordered, 3, async (s) => {
    try {
      const data = await src.read(s.offset, s.size);
      const raw = track.sampleEntry === 'wvtt' ? decodeWvttSample(data) : decodeTx3gSample(data);
      const text = sanitizeSubtitleText(raw);
      if (text) {
        const startMs = toMs(s.startTicks);
        const cue: SubtitleCue = {
          id: `mp4-${Math.round(startMs)}-${text.length}`,
          startMs,
          endMs: startMs + Math.max(200, (s.durationTicks / track.timescale) * 1000),
          text
        };
        cues.push(cue);
        pending.push(cue);
      }
    } finally {
      done++;
      if (opts.onCues && pending.length > 0 && (pending.length >= 40 || Date.now() - lastFlush > 120)) {
        opts.onCues(pending, done, ordered.length);
        pending = [];
        lastFlush = Date.now();
      }
    }
  }, opts.shouldStop);
  if (opts.onCues && pending.length > 0) opts.onCues(pending, done, ordered.length);
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
