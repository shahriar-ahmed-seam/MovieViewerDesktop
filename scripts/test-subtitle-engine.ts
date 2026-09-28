/**
 * Offline tests for the subtitle engine: parsers, charset detection, bitmap decoders,
 * auto-selection, the renderer track store, and the extraction tiers against locally
 * generated MKV / MP4 files (requires ffmpeg on PATH for the container tests).
 *
 * Run: npm run test:subtitles
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  parseSmi, parseMicroDvd, parseSubViewer, parseMpl2, parseSubtitleToCues, parseVtt,
  decodeSubtitleBytes, createMkvTextContext, textFromMkvFrame, sanitizeSubtitleText
} from '../src/shared/subtitles/text';
import { parsePgsDisplaySet, renderPgsComposition, decodePgsRle, groupPgsSegmentPackets } from '../src/shared/subtitles/pgs';
import { parseVobSubIdx, decodeVobSubPacket, readVobSubTiming } from '../src/shared/subtitles/vobsub';
import { rankSubtitles, sidecarMatchScore, languageOf, SelectableSubtitle } from '../src/renderer/subtitles/selection';
import { SubtitleTrackStore } from '../src/renderer/subtitles/SubtitleTrackStore';
import { SubtitleService } from '../src/main/subtitles/service';
import { MediaInspector } from '../src/main/media-inspector';
import type { SubtitleSessionEvent } from '../src/shared/subtitles/types';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`✅ PASS: ${name}`);
  } else {
    failed++;
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Text formats
// ---------------------------------------------------------------------------
function testTextFormats() {
  console.log('\n--- 1. Text formats ---');
  const smi = `<SAMI><HEAD><STYLE><!-- .KRCC {Name:Korean; lang:ko-KR;} .ENCC {Name:English; lang:en-US;} --></STYLE></HEAD><BODY>
<SYNC Start=1000><P Class=KRCC>안녕하세요<br>반갑습니다
<SYNC Start=1000><P Class=ENCC>Hello<br>Nice to meet you
<SYNC Start=3500><P Class=KRCC>&nbsp;
<SYNC Start=3500><P Class=ENCC>&nbsp;
<SYNC Start=5000><P Class=KRCC>두 번째
<SYNC Start=5000><P Class=ENCC>Second line
<SYNC Start=7000><P Class=ENCC>&nbsp;
</BODY></SAMI>`;
  const en = parseSmi(smi, 'en');
  assert(en.length === 2 && en[0].text === 'Hello\nNice to meet you' && en[0].startMs === 1000 && en[0].endMs === 3500, 'SAMI picks the English class and ends cues at &nbsp;', en);
  const ko = parseSmi(smi, 'ko');
  assert(ko.length === 2 && ko[0].text === '안녕하세요\n반갑습니다', 'SAMI Korean class preserved', ko[0]);
  assert(parseSubtitleToCues(smi, 'smi', 'en').length === 2, 'Auto-detects SAMI content');

  const mdvd = '{1}{1}25\n{25}{75}First|Second line\n{100}{150}{y:i}Italic';
  const md = parseMicroDvd(mdvd);
  assert(md.length === 2 && md[0].startMs === 1000 && md[0].endMs === 3000 && md[0].text === 'First\nSecond line', 'MicroDVD uses the fps header line', md);

  const subv = '[INFORMATION]\n[TITLE]x\n00:00:01.00,00:00:03.50\nHello[br]World\n\n00:00:04.00,00:00:05.00\nBye';
  const sv = parseSubViewer(subv);
  assert(sv.length === 2 && sv[0].text === 'Hello\nWorld' && sv[0].endMs === 3500, 'SubViewer parsed', sv);
  assert(parseSubtitleToCues(subv).length === 2, 'Auto-detects SubViewer');

  const mpl = '[10][35]Line one|/Line two\n[40][60]Next';
  const mp = parseMpl2(mpl);
  assert(mp.length === 2 && mp[0].startMs === 1000 && mp[0].endMs === 3500 && mp[0].text === 'Line one\nLine two', 'MPL2 parsed', mp);

  const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000 line:10%\nTop line\n\n00:04.000 --> 00:05.000\nNOTE this is dialogue, not a note block\n';
  const vc = parseVtt(vtt);
  assert(vc.length === 2 && vc[0].align === 'top', 'WebVTT line:10% maps to top placement', vc);
  assert(vc[1]?.text === 'NOTE this is dialogue, not a note block', 'Cue text starting with NOTE is kept', vc[1]);

  const srtNoBlank = '1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n';
  const sn = parseSubtitleToCues(srtNoBlank, 'srt');
  assert(sn.length === 2 && sn[0].text === 'A' && sn[1].text === 'B', 'SRT without blank separators', sn);

  const srtAn8 = '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Sign text\n';
  assert(parseSubtitleToCues(srtAn8)[0]?.align === 'top', 'SRT {\\an8} is placed at the top');

  assert(sanitizeSubtitleText('{\\p1}m 0 0 l 100 0 100 100') === '', 'Unterminated ASS drawing is removed');
  assert(sanitizeSubtitleText('Tom &amp; Jerry &#x1F600; &lt;3') === 'Tom & Jerry 😀 <3', 'Entities decoded once');
}

// ---------------------------------------------------------------------------
// 2. Charset detection
// ---------------------------------------------------------------------------
function testCharsets() {
  console.log('\n--- 2. Charset detection ---');
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n';
  const utf8 = new TextEncoder().encode(srt + 'বাংলা সাবটাইটেল\n');
  assert(decodeSubtitleBytes(utf8).includes('বাংলা'), 'UTF-8 Bengali');

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Hi')]);
  assert(decodeSubtitleBytes(bom) === 'Hi', 'UTF-8 BOM stripped');

  const u16 = Buffer.from('\ufeff' + srt + 'Hello', 'utf16le');
  assert(decodeSubtitleBytes(new Uint8Array(u16)).includes('Hello'), 'UTF-16LE with BOM');
  const u16nobom = Buffer.from(srt + 'Hello there', 'utf16le');
  assert(decodeSubtitleBytes(new Uint8Array(u16nobom)).includes('Hello there'), 'UTF-16LE without BOM');

  // "안녕하세요" in EUC-KR
  const eucKr = new Uint8Array([...Buffer.from(srt, 'ascii'), 0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x0a]);
  assert(decodeSubtitleBytes(eucKr, 'Show.S01E01.kor.srt').includes('안녕하세요'), 'EUC-KR via filename hint');
  assert(decodeSubtitleBytes(eucKr, 'Show.S01E01.srt').includes('안녕하세요'), 'EUC-KR via byte statistics');

  const latin = new Uint8Array([...Buffer.from(srt, 'ascii'), 0x63, 0x61, 0x66, 0xe9, 0x0a]); // café
  assert(decodeSubtitleBytes(latin, 'movie.srt').includes('café'), 'Windows-1252 fallback');
}

// ---------------------------------------------------------------------------
// 3. Matroska text frames
// ---------------------------------------------------------------------------
function testMkvFrames() {
  console.log('\n--- 3. Matroska text frames ---');
  const header = `[Script Info]\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\nStyle: Sign,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const ctx = createMkvTextContext('S_TEXT/ASS', new TextEncoder().encode(header));
  const enc = (s: string) => new TextEncoder().encode(s);
  const a = textFromMkvFrame(ctx, enc('12,0,Default,,0,0,0,,Hello, world\\Nsecond'));
  assert(a?.text === 'Hello, world\nsecond' && !a?.align, 'ASS block text keeps commas', a);
  const b = textFromMkvFrame(ctx, enc('13,0,Sign,,0,0,0,,Top sign'));
  assert(b?.align === 'top', 'ASS style Alignment=8 -> top', b);
  const c = textFromMkvFrame(ctx, enc('14,0,Default,,0,0,0,,{\\pos(640,60)}Positioned'));
  assert(c?.align === 'top', 'ASS \\pos near top -> top', c);
  const d = textFromMkvFrame(ctx, enc('15,0,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}'));
  assert(d === null, 'Drawing-only ASS event skipped');
  const srtCtx = createMkvTextContext('S_TEXT/UTF8');
  assert(textFromMkvFrame(srtCtx, enc('<i>Italic</i> line'))?.text === 'Italic line', 'S_TEXT/UTF8 tags stripped');
}

// ---------------------------------------------------------------------------
// 4. PGS
// ---------------------------------------------------------------------------
function seg(type: number, body: number[]): number[] {
  return [type, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
}
function u16(v: number) {
  return [(v >> 8) & 0xff, v & 0xff];
}
function pgsRle(rows: number[][]): number[] {
  const out: number[] = [];
  for (const row of rows) {
    let i = 0;
    while (i < row.length) {
      const color = row[i];
      let run = 1;
      while (i + run < row.length && row[i + run] === color) run++;
      if (color === 0) out.push(0, ...(run < 64 ? [run] : [0x40 | (run >> 8), run & 0xff]));
      else if (run === 1) out.push(color);
      else out.push(0, ...(run < 64 ? [0x80 | run, color] : [0xc0 | (run >> 8), run & 0xff, color]));
      i += run;
    }
    out.push(0, 0);
  }
  return out;
}
function pgsDisplaySet(opts: { objects: { id: number; x: number; y: number }[]; state: number; paletteOnly?: boolean; withData?: boolean; paletteY?: number }) {
  const pcs = [...u16(1920), ...u16(1080), 0x10, ...u16(1), opts.state, opts.paletteOnly ? 0x80 : 0, 0, opts.objects.length];
  for (const o of opts.objects) pcs.push(...u16(o.id), 0, 0, ...u16(o.x), ...u16(o.y));
  const bytes = [...seg(0x16, pcs)];
  if (opts.objects.length) {
    bytes.push(...seg(0x17, [1, 0, ...u16(0), ...u16(0), ...u16(1920), ...u16(1080)]));
    bytes.push(...seg(0x14, [0, 0, 1, opts.paletteY ?? 235, 128, 128, 255, 2, 16, 128, 128, 255]));
    if (opts.withData !== false) {
      const rle = pgsRle([[1, 1, 1, 2, 2, 0, 0, 0], [0, 0, 1, 1, 1, 1, 1, 1]]);
      bytes.push(...seg(0x15, [...u16(opts.objects[0].id), 0, 0xc0, 0, ((rle.length + 4) >> 8) & 0xff, (rle.length + 4) & 0xff, ...u16(8), ...u16(2), ...rle]));
    }
  }
  bytes.push(...seg(0x80, []));
  return new Uint8Array(bytes);
}

function testPgs() {
  console.log('\n--- 4. PGS decoder ---');
  const long = new Array(200).fill(1).concat(new Array(100).fill(0));
  const dec = decodePgsRle(new Uint8Array(pgsRle([long])), 300, 1);
  assert(dec[0] === 1 && dec[199] === 1 && dec[200] === 0 && dec[299] === 0, 'Long RLE runs (14-bit lengths)');

  const show = pgsDisplaySet({ objects: [{ id: 0, x: 100, y: 900 }], state: 0x80 });
  const clear = pgsDisplaySet({ objects: [], state: 0 });
  const fade = pgsDisplaySet({ objects: [{ id: 0, x: 100, y: 900 }], state: 0, paletteOnly: true, withData: false, paletteY: 126 });
  const sets = [parsePgsDisplaySet(show), parsePgsDisplaySet(fade), parsePgsDisplaySet(clear)];
  assert(sets[0]?.width === 1920 && sets[0]?.objects.length === 1, 'PCS parsed', sets[0]);
  const comp = renderPgsComposition(sets, 0);
  const bmp = comp?.bitmaps[0];
  assert(!!bmp && bmp.x === 100 && bmp.y === 900 && bmp.width === 8 && bmp.height === 2, 'Object placed at PCS position', bmp && { x: bmp.x, y: bmp.y, w: bmp.width, h: bmp.height });
  assert(!!bmp && bmp.rgba[0] === 255 && bmp.rgba[1] === 255 && bmp.rgba[2] === 255 && bmp.rgba[3] === 255, 'White pixel from BT.709 palette', bmp && Array.from(bmp.rgba.slice(0, 4)));
  assert(!!bmp && bmp.rgba[5 * 4 + 3] === 0, 'Palette index 0 is transparent');
  const fadeComp = renderPgsComposition(sets, 1);
  assert(!!fadeComp && fadeComp.bitmaps[0].rgba[0] < 140, 'Palette-only update reuses the earlier object', fadeComp && Array.from(fadeComp.bitmaps[0].rgba.slice(0, 4)));
  assert(renderPgsComposition(sets, 2) === null, 'Clear display set renders nothing');

  // One segment per packet (some muxers / M2TS sources)
  const segs: { startMs: number; data: Uint8Array }[] = [];
  let p = 0;
  while (p < show.length) {
    const size = (show[p + 1] << 8) | show[p + 2];
    segs.push({ startMs: 1000, data: show.slice(p, p + 3 + size) });
    p += 3 + size;
  }
  const grouped = groupPgsSegmentPackets(segs);
  assert(grouped.length === 1 && grouped[0].data.length === show.length, 'Segment-per-packet PGS regrouped into one display set');
}

// ---------------------------------------------------------------------------
// 5. VobSub
// ---------------------------------------------------------------------------
function testVobSub() {
  console.log('\n--- 5. VobSub decoder ---');
  const seq1At = 6;
  const seq1 = [0, 0, 0, 0 /* next placeholder */, 0x03, 0x32, 0x10, 0x04, 0xff, 0xf0,
    0x05, 10 >> 4, ((10 & 0xf) << 4) | (13 >> 8), 13 & 0xff, 20 >> 4, ((20 & 0xf) << 4) | (21 >> 8), 21 & 0xff,
    0x06, 0, 4, 0, 5, 0x01, 0xff];
  const seq2At = seq1At + seq1.length;
  seq1[2] = seq2At >> 8;
  seq1[3] = seq2At & 0xff;
  const seq2 = [0, 100, seq2At >> 8, seq2At & 0xff, 0x02, 0xff];
  const body = [0x9a, 0x13, ...seq1, ...seq2];
  const total = 4 + body.length;
  const spu = new Uint8Array([total >> 8, total & 0xff, 0, seq1At, ...body]);
  const idx = parseVobSubIdx('# VobSub index file, v7\nsize: 720x480\npalette: 000000, ffffff, ff0000, 00ff00, 0000ff, 111111, 222222, 333333, 444444, 555555, 666666, 777777, 888888, 999999, aaaaaa, bbbbbb\n');
  assert(idx.width === 720 && idx.height === 480 && idx.palette[2][0] === 255, 'idx size + palette parsed');
  const timing = readVobSubTiming(spu);
  assert(!!timing && timing.startDelayMs === 0 && Math.abs((timing.stopDelayMs || 0) - 1137.78) < 1, 'SPU start/stop delays', timing);
  const comp = decodeVobSubPacket(spu, idx);
  const b = comp?.bitmaps[0];
  assert(!!b && b.x === 10 && b.y === 20 && b.width === 4 && b.height === 2, 'SPU display area', b && { x: b.x, y: b.y, w: b.width, h: b.height });
  const px = (x: number, y: number) => b ? Array.from(b.rgba.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)) : [];
  assert(JSON.stringify(px(0, 0)) === '[255,255,255,255]' && JSON.stringify(px(2, 0)) === '[255,0,0,255]' && JSON.stringify(px(1, 1)) === '[0,255,0,255]', 'Interlaced fields + colors decoded', [px(0, 0), px(2, 0), px(1, 1)]);
}

// ---------------------------------------------------------------------------
// 6. Auto-selection and sidecar matching
// ---------------------------------------------------------------------------
function testSelection() {
  console.log('\n--- 6. Auto-selection ---');
  const t = (o: Partial<SelectableSubtitle> & { id: string }): SelectableSubtitle => ({ label: o.id, isExternal: false, isEmbedded: true, ...o });
  const snatch = [t({ id: 'forced', language: 'eng', title: 'Forced' }), t({ id: 'full', language: 'eng', isDefault: true })];
  assert(rankSubtitles(snatch, 'eng')[0].id === 'full', 'Skips the leading "Forced" English track (Snatch-style release)');

  const abyss = [t({ id: 'signs', language: 'eng', title: 'Signs & Songs', isDefault: true }), t({ id: 'dialogue', language: 'eng', title: 'Dialogue' })];
  assert(rankSubtitles(abyss, 'eng')[0].id === 'dialogue', 'Prefers Dialogue over default "Signs & Songs"');

  const sam = [t({ id: 'comm', language: 'eng', title: 'Commentary by X', isBitmap: true }), t({ id: 'pgs', language: 'eng', isBitmap: true }), t({ id: 'fre', language: 'fre', isBitmap: true })];
  assert(rankSubtitles(sam, 'eng')[0].id === 'pgs', 'Commentary PGS ranked below the main PGS track');

  const multi = [t({ id: 'e', language: 'eng' }), t({ id: 'b', language: 'ben' })];
  assert(rankSubtitles(multi, 'ben')[0].id === 'b', 'Preferred language wins');
  assert(rankSubtitles([t({ id: 'k', language: 'kor' }), t({ id: 'u', language: 'und', title: 'English' })], 'eng')[0].id === 'u', 'Undetermined language titled "English" detected');
  assert(languageOf({ id: 'x', label: 'Movie.2012.en.srt', isExternal: true }) === 'eng', 'Language from sidecar file name');
  assert(languageOf({ id: 'x', label: 'Take It Easy.srt', isExternal: true }) === 'und', 'No false positive from "It"');
  assert(rankSubtitles([t({ id: 'dvb', codecName: 'dvb_subtitle' })], 'eng').length === 0, 'Unsupported DVB tracks are never auto-selected');

  assert(sidecarMatchScore('Show.S01E03.720p.mkv', 'Show.S01E02.720p.srt', 12) < 0, 'Other episode sidecar rejected');
  assert(sidecarMatchScore('Show.S01E03.720p.mkv', 'Show.S01E03.720p.eng.srt', 12) > 90, 'Same episode sidecar accepted');
  assert(sidecarMatchScore('Routine Love Story (2012) BDrip.avi', 'Routine Love Story (2012) BDrip.srt', 1) >= 100, 'Single movie sidecar matched');
  assert(sidecarMatchScore('Movie A.mkv', 'Completely different.srt', 5) < 0, 'Unrelated sidecar rejected in multi-video folder');
}

// ---------------------------------------------------------------------------
// 7. Track store
// ---------------------------------------------------------------------------
function testStore() {
  console.log('\n--- 7. Track store ---');
  const s = new SubtitleTrackStore('t');
  s.setHeader({ kind: 'text', codecId: 'S_TEXT/UTF8' });
  s.addCues([
    { id: 'b', startMs: 5000, endMs: 6000, text: 'B' },
    { id: 'long', startMs: 1000, endMs: 20000, text: 'Long sign' },
    { id: 'a', startMs: 2000, endMs: 3000, text: 'A' }
  ]);
  s.addCues([{ id: 'a', startMs: 2000, endMs: 3000, text: 'A' }]);
  assert(s.itemCount === 3, 'Duplicate cues ignored');
  assert(s.activeCues(2500).map(c => c.id).join(',') === 'long,a', 'Overlapping cues at 2.5s', s.activeCues(2500));
  assert(s.activeCues(5500).map(c => c.id).join(',') === 'long,b', 'Long cue still active at 5.5s');
  assert(s.activeCues(3000).map(c => c.id).join(',') === 'long', 'Cue end is exclusive');

  const p = new SubtitleTrackStore('p');
  p.setHeader({ kind: 'pgs', codecId: 'S_HDMV/PGS' });
  const show = pgsDisplaySet({ objects: [{ id: 0, x: 0, y: 0 }], state: 0x80 });
  const clear = pgsDisplaySet({ objects: [], state: 0 });
  p.addPackets([{ startMs: 1000, data: show }, { startMs: 4000, data: clear }]);
  assert(p.activeBitmap(500) === null && p.activeBitmap(2000) !== null && p.activeBitmap(4500) === null, 'PGS visible until the clearing display set');
  const dec = p.activeBitmap(2000);
  assert(!!dec && !!p.decode(dec)?.bitmaps.length, 'PGS decoded lazily from the store');
}

// ---------------------------------------------------------------------------
// 8. Extraction tiers on generated files
// ---------------------------------------------------------------------------
function runSession(service: SubtitleService, url: string, streamIndex: number, codec: string | undefined, streamTypes: string[] | undefined, startMs = 0) {
  return new Promise<{ ok: boolean; count: number; method?: string; error?: string; texts: string[] }>((resolve) => {
    const id = `t-${Math.random()}`;
    const texts: string[] = [];
    let count = 0;
    let method: string | undefined;
    const timer = setTimeout(() => resolve({ ok: false, count, method, error: 'timeout', texts }), 60000);
    service.start({ sessionId: id, videoUrl: url, streamIndex, codec, streamTypes, startTimeMs: startMs }, (e: SubtitleSessionEvent) => {
      if (e.type === 'data') {
        count += (e.cues?.length || 0) + (e.packets?.length || 0);
        texts.push(...(e.cues || []).map(c => c.text));
        method = e.method || method;
      } else if (e.type === 'complete') {
        clearTimeout(timer);
        resolve({ ok: true, count, method: e.method || method, texts });
      } else if (e.type === 'error') {
        clearTimeout(timer);
        resolve({ ok: false, count, method, error: e.error, texts });
      }
    });
  });
}

async function testContainers() {
  console.log('\n--- 8. Extraction tiers (generated media) ---');
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('ffmpeg not found; skipping container tests');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-subs-'));
  const srtPath = path.join(dir, 'in.srt');
  let srt = '';
  for (let i = 0; i < 25; i++) {
    const s = 1 + i * 2;
    const t = (v: number) => `00:00:${String(Math.floor(v)).padStart(2, '0')},${String(Math.round((v % 1) * 1000)).padStart(3, '0')}`;
    srt += `${i + 1}\n${t(s)} --> ${t(s + 1.5)}\nLine ${i + 1}, café 한국어\n\n`;
  }
  fs.writeFileSync(srtPath, srt, 'utf8');
  const common = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=55:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=duration=55', '-i', srtPath, '-map', '0', '-map', '1', '-map', '2', '-c:v', 'mpeg4', '-c:a', 'aac'];
  const mkv = path.join(dir, 'indexed.mkv');
  const mp4 = path.join(dir, 'movtext.mp4');
  const noCues = path.join(dir, 'nocues.mkv');
  const assMkv = path.join(dir, 'ass.mkv');
  execFileSync('ffmpeg', [...common, '-c:s', 'srt', mkv]);
  execFileSync('ffmpeg', [...common, '-c:s', 'mov_text', mp4]);
  execFileSync('ffmpeg', [...common, '-c:s', 'ass', assMkv]);
  // Piped Matroska output cannot contain Cues -> exercises the ffmpeg streaming fallback
  const piped = execFileSync('ffmpeg', [...common.filter(a => a !== '-y'), '-c:s', 'srt', '-f', 'matroska', 'pipe:1'], { maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(noCues, piped);

  const service = new SubtitleService();
  for (const [name, file, expectMethod] of [
    ['MKV with Cues -> index', mkv, 'mkv-index'],
    ['MKV ASS -> index', assMkv, 'mkv-index'],
    ['MP4 mov_text -> index', mp4, 'mp4-index'],
    ['MKV without Cues -> ffmpeg stream', noCues, 'ffmpeg-stream']
  ] as const) {
    const insp = await MediaInspector.inspectMedia(file);
    const sub = insp.subtitleStreams[0];
    const t0 = Date.now();
    const res = await runSession(service, file, sub.streamIndex, sub.codecName, insp.streamTypes);
    assert(res.ok && res.count === 25 && res.method === expectMethod, `${name}: 25 cues via ${expectMethod} (${Date.now() - t0}ms)`, res);
    assert(res.texts.includes('Line 7, café 한국어'), `${name}: Unicode text intact`, res.texts.slice(0, 2));
  }

  // Seek-aware fallback: starting mid-file still returns everything (forward pass + backfill)
  const insp = await MediaInspector.inspectMedia(noCues);
  const mid = await runSession(service, noCues, insp.subtitleStreams[0].streamIndex, 'subrip', insp.streamTypes, 30000);
  assert(mid.ok && mid.count === 25, 'ffmpeg fallback started at 30s backfills the beginning', mid);

  // Cached second request
  const again = await runSession(service, mkv, 2, 'subrip', ['video', 'audio', 'subtitle']);
  assert(again.ok && again.method === 'memory-cache' && again.count === 25, 'Completed tracks served from cache', again);

  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  console.log('==============================================');
  console.log('MovieViewer - Subtitle Engine Tests');
  console.log('==============================================');
  testTextFormats();
  testCharsets();
  testMkvFrames();
  testPgs();
  testVobSub();
  testSelection();
  testStore();
  await testContainers();
  console.log('\n==============================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('==============================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
