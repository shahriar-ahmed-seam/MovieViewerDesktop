/**
 * Minimal EBML (Matroska / WebM) primitives shared by the random-access index reader
 * and the streaming parser used for ffmpeg's piped output.
 */

export const MKV = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagHearingImpaired: 0x55ab,
  FlagCommentary: 0x55af,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingOrder: 0x5031,
  ContentEncodingScope: 0x5032,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
  CueDuration: 0xb2,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf
} as const;

/** Level-1 children of Segment. Used to resync the streaming parser. */
export const TOP_LEVEL_IDS = new Set<number>([
  MKV.SeekHead, MKV.Info, MKV.Tracks, MKV.Cues, MKV.Cluster, MKV.Tags, MKV.Chapters, MKV.Attachments, MKV.Void, MKV.CRC32
]);

export interface Vint {
  value: number;
  length: number;
  /** All value bits set: "unknown size" in EBML. */
  unknown: boolean;
}

/** Reads an element ID (marker bit kept). Returns null if the buffer is too short or the byte is invalid. */
export function readId(buf: Uint8Array, pos: number): { id: number; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

/** Reads an EBML variable-size integer (marker bit removed). */
export function readVint(buf: Uint8Array, pos: number): Vint | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

export function readUInt(buf: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

export function readFloat(buf: Uint8Array, pos: number, len: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + pos, len);
  if (len === 4) return view.getFloat32(0);
  if (len === 8) return view.getFloat64(0);
  return 0;
}

export function readString(buf: Uint8Array, pos: number, len: number): string {
  let end = pos + len;
  // Strings may be zero-padded
  while (end > pos && buf[end - 1] === 0) end--;
  return new TextDecoder('utf-8').decode(buf.subarray(pos, end));
}

export interface EbmlElement {
  id: number;
  /** Offset of the element's first ID byte. */
  start: number;
  headerLength: number;
  dataStart: number;
  /** -1 for unknown-size elements. */
  dataSize: number;
  /** Offset just past the element (dataStart + dataSize). Infinity when size is unknown. */
  end: number;
}

/** Parses an element header at `pos`. Returns null if incomplete. */
export function readElementHeader(buf: Uint8Array, pos: number): EbmlElement | null {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readVint(buf, pos + id.length);
  if (!size) return null;
  const headerLength = id.length + size.length;
  const dataStart = pos + headerLength;
  const dataSize = size.unknown ? -1 : size.value;
  return {
    id: id.id,
    start: pos,
    headerLength,
    dataStart,
    dataSize,
    end: size.unknown ? Infinity : dataStart + dataSize
  };
}

/** Iterates the children of a fully-buffered element range. Stops at the first incomplete header. */
export function* children(buf: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  let pos = start;
  const limit = Math.min(end, buf.length);
  while (pos < limit) {
    const el = readElementHeader(buf, pos);
    if (!el) return;
    yield el;
    if (el.dataSize < 0) return;
    pos = el.end;
  }
}

export interface ParsedBlock {
  trackNumber: number;
  /** Signed timecode relative to the cluster timestamp. */
  relativeTimecode: number;
  flags: number;
  /** Frame payload(s). Subtitles are practically never laced; lacing is still handled. */
  frames: Uint8Array[];
}

/** Parses the payload of a SimpleBlock or Block element. */
export function parseBlockPayload(data: Uint8Array): ParsedBlock | null {
  const track = readVint(data, 0);
  if (!track || data.length < track.length + 3) return null;
  let pos = track.length;
  const rel = (data[pos] << 8) | data[pos + 1];
  const relativeTimecode = rel & 0x8000 ? rel - 0x10000 : rel;
  pos += 2;
  const flags = data[pos++];
  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) {
    return { trackNumber: track.value, relativeTimecode, flags, frames: [data.subarray(pos)] };
  }

  const frameCount = data[pos++] + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph lacing
    for (let i = 0; i < frameCount - 1; i++) {
      let s = 0;
      let b: number;
      do {
        b = data[pos++];
        s += b;
      } while (b === 0xff && pos < data.length);
      sizes.push(s);
    }
  } else if (lacing === 3) {
    // EBML lacing
    const first = readVint(data, pos);
    if (!first) return null;
    pos += first.length;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const v = readVint(data, pos);
      if (!v) return null;
      pos += v.length;
      const bias = Math.pow(2, 7 * v.length - 1) - 1;
      sizes.push(sizes[i - 1] + (v.value - bias));
    }
  } else {
    // Fixed-size lacing
    const each = Math.floor((data.length - pos) / frameCount);
    for (let i = 0; i < frameCount - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(data.length - pos - used);
  const frames: Uint8Array[] = [];
  for (const s of sizes) {
    if (s < 0 || pos + s > data.length) return null;
    frames.push(data.subarray(pos, pos + s));
    pos += s;
  }
  return { trackNumber: track.value, relativeTimecode, flags, frames };
}
