/**
 * DVD subtitle (VobSub / dvd_subtitle / S_VOBSUB) decoder.
 * Each packet is an SPU: RLE-coded interlaced 2-bit bitmap + control sequences.
 */
import type { DecodedComposition } from './pgs';

export interface VobSubIdx {
  width: number;
  height: number;
  /** 16 RGB colors. */
  palette: [number, number, number][];
}

const DEFAULT_PALETTE: [number, number, number][] = [
  [0, 0, 0], [240, 240, 240], [204, 204, 204], [153, 153, 153], [51, 51, 250], [17, 17, 187], [250, 51, 51], [187, 17, 17],
  [51, 250, 51], [17, 187, 17], [250, 250, 51], [187, 187, 17], [250, 51, 250], [187, 17, 187], [51, 250, 250], [17, 187, 187]
];

export function parseVobSubIdx(text: string | undefined): VobSubIdx {
  const idx: VobSubIdx = { width: 720, height: 576, palette: DEFAULT_PALETTE.map(c => [...c] as [number, number, number]) };
  if (!text) return idx;
  const size = text.match(/^\s*size:\s*(\d+)\s*x\s*(\d+)/im);
  if (size) {
    idx.width = Number(size[1]) || 720;
    idx.height = Number(size[2]) || 576;
  }
  const pal = text.match(/^\s*palette:\s*(.+)$/im);
  if (pal) {
    const colors = pal[1].split(',').map(s => s.trim()).filter(Boolean);
    colors.slice(0, 16).forEach((hex, i) => {
      const v = parseInt(hex, 16);
      if (Number.isFinite(v)) idx.palette[i] = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    });
  }
  return idx;
}

interface SpuControl {
  startDelayMs: number;
  stopDelayMs?: number;
  forced: boolean;
  colors: [number, number, number, number];
  alphas: [number, number, number, number];
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  topOffset: number;
  bottomOffset: number;
}

/** SPU date units are 1024 / 90000 seconds. */
const SPU_DATE_MS = 1024 / 90;

function parseControl(data: Uint8Array): SpuControl | null {
  if (data.length < 4) return null;
  const ctrlStart = (data[2] << 8) | data[3];
  if (ctrlStart >= data.length) return null;
  const c: SpuControl = {
    startDelayMs: 0, forced: false,
    colors: [0, 1, 2, 3], alphas: [0, 15, 15, 15],
    x1: 0, x2: -1, y1: 0, y2: -1, topOffset: -1, bottomOffset: -1
  };
  let startSeen = false;
  let seq = ctrlStart;
  const visited = new Set<number>();
  while (seq + 4 <= data.length && !visited.has(seq)) {
    visited.add(seq);
    const date = ((data[seq] << 8) | data[seq + 1]) * SPU_DATE_MS;
    const next = (data[seq + 2] << 8) | data[seq + 3];
    let p = seq + 4;
    let done = false;
    while (p < data.length && !done) {
      const cmd = data[p++];
      switch (cmd) {
        case 0x00: c.forced = true; if (!startSeen) { c.startDelayMs = date; startSeen = true; } break;
        case 0x01: if (!startSeen) { c.startDelayMs = date; startSeen = true; } break;
        case 0x02: c.stopDelayMs = date; break;
        case 0x03:
          if (p + 2 > data.length) { done = true; break; }
          c.colors = [data[p + 1] & 0x0f, data[p + 1] >> 4, data[p] & 0x0f, data[p] >> 4];
          p += 2;
          break;
        case 0x04:
          if (p + 2 > data.length) { done = true; break; }
          c.alphas = [data[p + 1] & 0x0f, data[p + 1] >> 4, data[p] & 0x0f, data[p] >> 4];
          p += 2;
          break;
        case 0x05:
          if (p + 6 > data.length) { done = true; break; }
          c.x1 = (data[p] << 4) | (data[p + 1] >> 4);
          c.x2 = ((data[p + 1] & 0x0f) << 8) | data[p + 2];
          c.y1 = (data[p + 3] << 4) | (data[p + 4] >> 4);
          c.y2 = ((data[p + 4] & 0x0f) << 8) | data[p + 5];
          p += 6;
          break;
        case 0x06:
          if (p + 4 > data.length) { done = true; break; }
          c.topOffset = (data[p] << 8) | data[p + 1];
          c.bottomOffset = (data[p + 2] << 8) | data[p + 3];
          p += 4;
          break;
        case 0x07: {
          if (p + 2 > data.length) { done = true; break; }
          const len = (data[p] << 8) | data[p + 1];
          p += Math.max(2, len);
          break;
        }
        case 0xff:
        default:
          done = true;
          break;
      }
    }
    if (next === seq || next < 4) break;
    seq = next;
  }
  return c;
}

/** Start/stop offsets relative to the packet timestamp. */
export function readVobSubTiming(data: Uint8Array): { startDelayMs: number; stopDelayMs?: number; forced: boolean } | null {
  const c = parseControl(data);
  if (!c) return null;
  return { startDelayMs: c.startDelayMs, stopDelayMs: c.stopDelayMs, forced: c.forced };
}

function decodeField(data: Uint8Array, offset: number, width: number, rows: number[], out: Uint8Array) {
  let nib = offset * 2;
  const maxNib = data.length * 2;
  const getNibble = () => {
    if (nib >= maxNib) return 0;
    const b = data[nib >> 1];
    const n = nib & 1 ? b & 0x0f : b >> 4;
    nib++;
    return n;
  };
  for (const row of rows) {
    let x = 0;
    while (x < width && nib < maxNib) {
      let code = getNibble();
      if (code < 0x4) {
        code = (code << 4) | getNibble();
        if (code < 0x10) {
          code = (code << 4) | getNibble();
          if (code < 0x40) code = (code << 4) | getNibble();
        }
      }
      const color = code & 0x3;
      let run = code >> 2;
      if (run === 0) run = width - x;
      const end = Math.min(x + run, width);
      if (color !== 0) out.fill(color, row * width + x, row * width + end);
      x = end;
    }
    if (nib & 1) nib++; // lines are byte aligned
  }
}

export function decodeVobSubPacket(data: Uint8Array, idx: VobSubIdx): DecodedComposition | null {
  const c = parseControl(data);
  if (!c || c.topOffset < 0 || c.bottomOffset < 0) return null;
  const width = c.x2 - c.x1 + 1;
  const height = c.y2 - c.y1 + 1;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;

  const indices = new Uint8Array(width * height);
  const top: number[] = [];
  const bottom: number[] = [];
  for (let r = 0; r < height; r++) (r % 2 === 0 ? top : bottom).push(r);
  decodeField(data, c.topOffset, width, top, indices);
  decodeField(data, c.bottomOffset, width, bottom, indices);

  const lut = new Uint8ClampedArray(16);
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = idx.palette[c.colors[i]] || [255, 255, 255];
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = c.alphas[i] * 17;
  }

  // Crop fully transparent borders so the drawn area is tight
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lut[indices[y * width + x] * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const li = indices[(y + minY) * width + (x + minX)] * 4;
      const o = (y * w + x) * 4;
      rgba[o] = lut[li];
      rgba[o + 1] = lut[li + 1];
      rgba[o + 2] = lut[li + 2];
      rgba[o + 3] = lut[li + 3];
    }
  }
  return {
    frameWidth: idx.width,
    frameHeight: idx.height,
    bitmaps: [{ x: c.x1 + minX, y: c.y1 + minY, width: w, height: h, rgba }]
  };
}

/**
 * Demuxes a VobSub .sub file (MPEG program stream) using the .idx timestamps/filepos entries.
 * Returns timed SPU packets for the first (or requested) stream id.
 */
export function parseVobSubSidecar(idxText: string, sub: Uint8Array, langIndex?: number): { startMs: number; endMs?: number; data: Uint8Array }[] {
  type Entry = { ms: number; filepos: number; stream: number };
  const entries: Entry[] = [];
  let stream = -1;
  let delayMs = 0;
  for (const line of idxText.replace(/\r/g, '').split('\n')) {
    const id = line.match(/^\s*id:\s*\w+,\s*index:\s*(\d+)/i);
    if (id) {
      stream = Number(id[1]);
      delayMs = 0;
      continue;
    }
    const delay = line.match(/^\s*delay:\s*(-?)(\d+):(\d+):(\d+)[:.,](\d+)/i);
    if (delay) {
      const v = ((Number(delay[2]) * 60 + Number(delay[3])) * 60 + Number(delay[4])) * 1000 + Number(delay[5]);
      delayMs += delay[1] === '-' ? -v : v;
      continue;
    }
    const ts = line.match(/^\s*timestamp:\s*(\d+):(\d+):(\d+):(\d+),\s*filepos:\s*([0-9a-f]+)/i);
    if (ts) {
      const ms = ((Number(ts[1]) * 60 + Number(ts[2])) * 60 + Number(ts[3])) * 1000 + Number(ts[4]) + delayMs;
      entries.push({ ms, filepos: parseInt(ts[5], 16), stream: Math.max(0, stream) });
    }
  }
  const streams = [...new Set(entries.map(e => e.stream))];
  const target = langIndex !== undefined && streams.includes(langIndex) ? langIndex : streams[0];
  const list = entries.filter(e => e.stream === target);

  const out: { startMs: number; endMs?: number; data: Uint8Array }[] = [];
  for (const e of list) {
    const spu = readSpuAt(sub, e.filepos);
    if (!spu) continue;
    const timing = readVobSubTiming(spu);
    out.push({
      startMs: e.ms + (timing?.startDelayMs || 0),
      endMs: timing?.stopDelayMs !== undefined ? e.ms + timing.stopDelayMs : undefined,
      data: spu
    });
  }
  return out;
}

/** Reassembles one SPU from consecutive MPEG-PS private-stream-1 PES packets starting at `pos`. */
function readSpuAt(buf: Uint8Array, pos: number): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let expected = -1;
  let collected = 0;
  let p = pos;
  let guard = 0;
  while (p + 6 <= buf.length && guard++ < 64) {
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) {
      p++;
      continue;
    }
    const code = buf[p + 3];
    if (code === 0xba) {
      // Pack header (MPEG-2: 14 bytes + stuffing)
      if ((buf[p + 4] & 0xc0) === 0x40) p += 14 + (buf[p + 13] & 0x07);
      else p += 12;
      continue;
    }
    const len = (buf[p + 4] << 8) | buf[p + 5];
    if (code !== 0xbd) {
      p += 6 + len;
      continue;
    }
    const hdrLen = buf[p + 8];
    const payloadStart = p + 9 + hdrLen;
    const pesEnd = p + 6 + len;
    if (payloadStart >= pesEnd || pesEnd > buf.length) return null;
    const payload = buf.subarray(payloadStart + 1, pesEnd); // skip substream id
    if (expected < 0) {
      if (payload.length < 2) return null;
      expected = (payload[0] << 8) | payload[1];
    }
    parts.push(payload);
    collected += payload.length;
    p = pesEnd;
    if (collected >= expected) break;
  }
  if (expected <= 0 || collected < expected) return null;
  const out = new Uint8Array(expected);
  let off = 0;
  for (const part of parts) {
    const take = Math.min(part.length, expected - off);
    out.set(part.subarray(0, take), off);
    off += take;
    if (off >= expected) break;
  }
  return out;
}
