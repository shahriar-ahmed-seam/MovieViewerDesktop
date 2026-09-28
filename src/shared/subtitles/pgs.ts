/**
 * HDMV Presentation Graphic Stream (Blu-ray "PGS" / .sup) decoder.
 *
 * A packet is one display set: PCS (composition), WDS (windows), PDS (palettes), ODS (RLE objects), END.
 * Display sets with zero composition objects clear the screen.
 */

const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;
const SEG_WDS = 0x17;
const SEG_END = 0x80;

export interface PgsCompositionObject {
  objectId: number;
  windowId: number;
  x: number;
  y: number;
  crop?: { x: number; y: number; width: number; height: number };
}

export interface PgsObjectData {
  width: number;
  height: number;
  rle: Uint8Array;
}

export interface PgsDisplaySet {
  width: number;
  height: number;
  compositionNumber: number;
  /** 0x00 normal, 0x40 acquisition point, 0x80 epoch start */
  compositionState: number;
  paletteUpdateOnly: boolean;
  paletteId: number;
  objects: PgsCompositionObject[];
  /** Palettes defined in this display set: id -> RGBA (256 * 4 bytes). */
  palettes: Map<number, Uint8ClampedArray>;
  /** Objects defined in this display set. */
  objectData: Map<number, PgsObjectData>;
}

export interface DecodedBitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface DecodedComposition {
  frameWidth: number;
  frameHeight: number;
  bitmaps: DecodedBitmap[];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function ycbcrToRgba(y: number, cr: number, cb: number, a: number, bt709: boolean, out: Uint8ClampedArray, o: number) {
  const yy = 1.164383 * (y - 16);
  const cbb = cb - 128;
  const crr = cr - 128;
  let r: number;
  let g: number;
  let b: number;
  if (bt709) {
    r = yy + 1.792741 * crr;
    g = yy - 0.213249 * cbb - 0.532909 * crr;
    b = yy + 2.112402 * cbb;
  } else {
    r = yy + 1.596027 * crr;
    g = yy - 0.391762 * cbb - 0.812968 * crr;
    b = yy + 2.017232 * cbb;
  }
  out[o] = clamp255(r);
  out[o + 1] = clamp255(g);
  out[o + 2] = clamp255(b);
  out[o + 3] = a;
}

/** Iterates segments, supporting both raw Matroska payloads and .sup files ("PG" + PTS + DTS headers). */
function* segments(data: Uint8Array): Generator<{ type: number; body: Uint8Array }> {
  let pos = 0;
  while (pos + 3 <= data.length) {
    if (data[pos] === 0x50 && data[pos + 1] === 0x47) {
      pos += 10; // "PG" + PTS(4) + DTS(4)
      if (pos + 3 > data.length) return;
    }
    const type = data[pos];
    const size = (data[pos + 1] << 8) | data[pos + 2];
    const start = pos + 3;
    if (start + size > data.length) return;
    yield { type, body: data.subarray(start, start + size) };
    pos = start + size;
  }
}

export function pgsPacketHasComposition(data: Uint8Array): boolean {
  for (const s of segments(data)) if (s.type === SEG_PCS) return true;
  return false;
}

export function pgsPacketEndsDisplaySet(data: Uint8Array): boolean {
  let last = -1;
  for (const s of segments(data)) last = s.type;
  return last === SEG_END;
}

export function parsePgsDisplaySet(data: Uint8Array): PgsDisplaySet | null {
  let ds: PgsDisplaySet | null = null;
  const partialObjects = new Map<number, { width: number; height: number; chunks: Uint8Array[] }>();
  const pendingPalettes: { id: number; body: Uint8Array }[] = [];

  for (const { type, body } of segments(data)) {
    if (type === SEG_PCS && body.length >= 11) {
      const count = body[10];
      const objects: PgsCompositionObject[] = [];
      let p = 11;
      for (let i = 0; i < count && p + 8 <= body.length; i++) {
        const objectId = (body[p] << 8) | body[p + 1];
        const windowId = body[p + 2];
        const cropFlag = body[p + 3];
        const x = (body[p + 4] << 8) | body[p + 5];
        const y = (body[p + 6] << 8) | body[p + 7];
        p += 8;
        const obj: PgsCompositionObject = { objectId, windowId, x, y };
        if (cropFlag & 0x80 && p + 8 <= body.length) {
          obj.crop = {
            x: (body[p] << 8) | body[p + 1],
            y: (body[p + 2] << 8) | body[p + 3],
            width: (body[p + 4] << 8) | body[p + 5],
            height: (body[p + 6] << 8) | body[p + 7]
          };
          p += 8;
        }
        objects.push(obj);
      }
      ds = {
        width: (body[0] << 8) | body[1],
        height: (body[2] << 8) | body[3],
        compositionNumber: (body[5] << 8) | body[6],
        compositionState: body[7],
        paletteUpdateOnly: (body[8] & 0x80) !== 0,
        paletteId: body[9],
        objects,
        palettes: new Map(),
        objectData: new Map()
      };
    } else if (type === SEG_PDS && body.length >= 2) {
      pendingPalettes.push({ id: body[0], body });
    } else if (type === SEG_ODS && body.length >= 4) {
      const id = (body[0] << 8) | body[1];
      const seq = body[3];
      if (seq & 0x80) {
        if (body.length < 11) continue;
        const width = (body[7] << 8) | body[8];
        const height = (body[9] << 8) | body[10];
        partialObjects.set(id, { width, height, chunks: [body.subarray(11)] });
      } else {
        partialObjects.get(id)?.chunks.push(body.subarray(4));
      }
    } else if (type === SEG_WDS || type === SEG_END) {
      // Window definitions are not needed for rendering; END terminates the set.
    }
  }

  if (!ds) return null;
  const bt709 = ds.height > 576 || ds.height <= 0;
  for (const { id, body } of pendingPalettes) {
    const rgba = new Uint8ClampedArray(256 * 4); // entries default to fully transparent
    for (let p = 2; p + 5 <= body.length; p += 5) {
      ycbcrToRgba(body[p + 1], body[p + 2], body[p + 3], body[p + 4], bt709, rgba, body[p] * 4);
    }
    ds.palettes.set(id, rgba);
  }
  for (const [id, obj] of partialObjects) {
    const total = obj.chunks.reduce((a, c) => a + c.length, 0);
    const rle = new Uint8Array(total);
    let off = 0;
    for (const c of obj.chunks) {
      rle.set(c, off);
      off += c.length;
    }
    ds.objectData.set(id, { width: obj.width, height: obj.height, rle });
  }
  return ds;
}

/** Decodes PGS run-length data into palette indices. */
export function decodePgsRle(rle: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  let p = 0;
  while (p < rle.length && y < height) {
    let color = rle[p++];
    let run = 1;
    if (color === 0) {
      if (p >= rle.length) break;
      const flags = rle[p++];
      if (flags === 0) {
        // End of line
        x = 0;
        y++;
        continue;
      }
      run = flags & 0x3f;
      if (flags & 0x40) {
        if (p >= rle.length) break;
        run = (run << 8) | rle[p++];
      }
      if (flags & 0x80) {
        if (p >= rle.length) break;
        color = rle[p++];
      } else {
        color = 0;
      }
    }
    if (y < height) {
      const end = Math.min(x + run, width);
      if (color !== 0) out.fill(color, y * width + x, y * width + end);
      x += run;
    }
  }
  return out;
}

/**
 * Renders display set `index` into bitmaps. Objects and palettes that are not
 * defined in the set itself (palette-only updates, refreshes) are looked up in earlier sets.
 */
export function renderPgsComposition(sets: (PgsDisplaySet | null)[], index: number): DecodedComposition | null {
  const ds = sets[index];
  if (!ds || ds.objects.length === 0) return null;

  const findPalette = (id: number): Uint8ClampedArray | undefined => {
    for (let i = index; i >= 0 && i >= index - 64; i--) {
      const s = sets[i];
      if (!s) continue;
      const pal = s.palettes.get(id);
      if (pal) return pal;
      if (i < index && s.compositionState === 0x80) break;
    }
    return undefined;
  };
  const findObject = (id: number): PgsObjectData | undefined => {
    for (let i = index; i >= 0 && i >= index - 64; i--) {
      const s = sets[i];
      if (!s) continue;
      const obj = s.objectData.get(id);
      if (obj) return obj;
      if (i < index && s.compositionState === 0x80) break;
    }
    return undefined;
  };

  const palette = findPalette(ds.paletteId);
  if (!palette) return null;

  const bitmaps: DecodedBitmap[] = [];
  for (const ref of ds.objects) {
    const obj = findObject(ref.objectId);
    if (!obj || obj.width === 0 || obj.height === 0) continue;
    const indices = decodePgsRle(obj.rle, obj.width, obj.height);
    let sx = 0;
    let sy = 0;
    let w = obj.width;
    let h = obj.height;
    if (ref.crop) {
      sx = Math.min(ref.crop.x, obj.width);
      sy = Math.min(ref.crop.y, obj.height);
      w = Math.min(ref.crop.width, obj.width - sx);
      h = Math.min(ref.crop.height, obj.height - sy);
    }
    if (w <= 0 || h <= 0) continue;
    const rgba = new Uint8ClampedArray(w * h * 4);
    let visible = false;
    for (let row = 0; row < h; row++) {
      const srcRow = (row + sy) * obj.width + sx;
      const dstRow = row * w * 4;
      for (let col = 0; col < w; col++) {
        const ci = indices[srcRow + col] * 4;
        const d = dstRow + col * 4;
        rgba[d] = palette[ci];
        rgba[d + 1] = palette[ci + 1];
        rgba[d + 2] = palette[ci + 2];
        rgba[d + 3] = palette[ci + 3];
        if (palette[ci + 3] !== 0) visible = true;
      }
    }
    if (visible) bitmaps.push({ x: ref.x, y: ref.y, width: w, height: h, rgba });
  }
  if (bitmaps.length === 0) return null;
  return { frameWidth: ds.width || 1920, frameHeight: ds.height || 1080, bitmaps };
}

/**
 * Some muxers store one PGS segment per packet. Merges consecutive packets until an END segment
 * so each resulting packet is a complete display set.
 */
export function groupPgsSegmentPackets<T extends { startMs: number; endMs?: number; data: Uint8Array }>(sorted: T[]): T[] {
  const out: T[] = [];
  let acc: Uint8Array[] = [];
  let first: T | null = null;
  for (const p of sorted) {
    if (!first) first = p;
    acc.push(p.data);
    if (pgsPacketEndsDisplaySet(p.data)) {
      const total = acc.reduce((a, c) => a + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of acc) {
        merged.set(c, off);
        off += c.length;
      }
      out.push({ ...first, data: merged });
      acc = [];
      first = null;
    }
  }
  return out;
}

/** Parses a standalone .sup file into timed display-set packets. */
export function parseSupFile(bytes: Uint8Array): { startMs: number; data: Uint8Array }[] {
  const out: { startMs: number; data: Uint8Array }[] = [];
  let pos = 0;
  let setStart = -1;
  let setPts = 0;
  while (pos + 13 <= bytes.length) {
    if (bytes[pos] !== 0x50 || bytes[pos + 1] !== 0x47) break;
    const pts = ((bytes[pos + 2] << 24) >>> 0) + (bytes[pos + 3] << 16) + (bytes[pos + 4] << 8) + bytes[pos + 5];
    const type = bytes[pos + 10];
    const size = (bytes[pos + 11] << 8) | bytes[pos + 12];
    const end = pos + 13 + size;
    if (end > bytes.length) break;
    if (type === SEG_PCS) {
      setStart = pos;
      setPts = pts;
    }
    if (type === SEG_END && setStart >= 0) {
      out.push({ startMs: setPts / 90, data: bytes.subarray(setStart, end) });
      setStart = -1;
    }
    pos = end;
  }
  return out;
}
