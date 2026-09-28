/**
 * Text subtitle parsing shared by the main process (embedded tracks) and renderer (sidecar / local files).
 * Supports SubRip, WebVTT, ASS/SSA, SAMI (.smi), MicroDVD, SubViewer, MPL2 and Matroska text blocks.
 */
import type { CueAlign, SubtitleCue } from './types';

export type { SubtitleCue } from './types';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Parses HH:MM:SS,mmm | H:MM:SS.mmm | MM:SS.mmm | SS.mmm (also ASS centiseconds) into milliseconds.
 */
export function parseTimeToMs(timeStr: string): number {
  if (!timeStr) return 0;
  const clean = timeStr.trim().replace(',', '.');
  const parts = clean.split(':');
  let h = 0;
  let m = 0;
  let sWithMs = '0';

  if (parts.length >= 3) {
    h = parseFloat(parts[parts.length - 3]) || 0;
    m = parseFloat(parts[parts.length - 2]) || 0;
    sWithMs = parts[parts.length - 1] || '0';
  } else if (parts.length === 2) {
    m = parseFloat(parts[0]) || 0;
    sWithMs = parts[1] || '0';
  } else {
    sWithMs = parts[0] || '0';
  }

  const sParts = sWithMs.split('.');
  const s = parseInt(sParts[0], 10) || 0;
  let ms = 0;
  if (sParts[1]) {
    ms = parseInt(sParts[1].padEnd(3, '0').slice(0, 3), 10) || 0;
  }
  return Math.max(0, Math.round((h * 3600 + m * 60 + s) * 1000 + ms));
}

export const parseVttTimeToMs = parseTimeToMs;

export function formatMsToVttTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(safeMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mill = safeMs % 1000;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${mill.toString().padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Text cleanup & positioning
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lrm;|&rlm;/gi, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&amp;/gi, '&');
}

/**
 * Removes ASS override blocks / vector drawings and HTML-ish tags, decodes entities and
 * normalizes line breaks. Unicode text (Korean, Bengali, Arabic, emoji...) is preserved.
 */
export function sanitizeSubtitleText(raw: string): string {
  if (!raw) return '';
  let text = raw;

  text = text.replace(/<br\s*\/?>/gi, '\n');

  // ASS vector drawings: {\p1}m 0 0 l 10 10{\p0}. Unterminated drawings run to the end of the line.
  text = text.replace(/\{[^}]*\\p[1-9][^}]*\}.*?(\{[^}]*\\p0[^}]*\}|$)/gis, '');
  text = text.replace(/\{[^}]*\}/g, '');

  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');

  // HTML / WebVTT tags: <i>, <font ...>, <c.yellow>, <v Speaker>, <00:01:02.000> timestamps
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  text = text.replace(/<\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}>/g, '');

  text = decodeEntities(text);

  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Maps an ASS numpad alignment (1-9) to a vertical placement. */
function alignFromNumpad(an: number): CueAlign {
  if (an >= 7) return 'top';
  if (an >= 4) return 'middle';
  return 'bottom';
}

/** Legacy SSA \a alignment: 1-3 bottom, 5-7 top, 9-11 middle. */
function alignFromLegacy(a: number): CueAlign {
  if (a >= 9) return 'middle';
  if (a >= 5) return 'top';
  return 'bottom';
}

export function detectOverrideAlign(raw: string, playResY?: number): CueAlign | undefined {
  const an = raw.match(/\\an([1-9])/);
  if (an) return alignFromNumpad(Number(an[1]));
  const a = raw.match(/\\a(\d{1,2})(?!\w)/);
  if (a) return alignFromLegacy(Number(a[1]));
  const pos = raw.match(/\\(?:pos|move)\(\s*[-\d.]+\s*,\s*([-\d.]+)/);
  if (pos && playResY && playResY > 0) {
    const y = Number(pos[1]);
    if (y < playResY * 0.35) return 'top';
    if (y < playResY * 0.65) return 'middle';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ASS header (styles, PlayResY)
// ---------------------------------------------------------------------------

export interface AssHeaderInfo {
  playResY?: number;
  styleAlign: Map<string, CueAlign>;
  /** Field order of [Events] Format line (lower-cased). */
  eventFormat?: string[];
}

export function parseAssHeader(header: string): AssHeaderInfo {
  const info: AssHeaderInfo = { styleAlign: new Map() };
  const lines = header.replace(/\r\n|\r/g, '\n').split('\n');
  let section = '';
  let styleFormat: string[] = [];
  const isV4Plus = /\[V4\+ Styles\]/i.test(header);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.toLowerCase();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (section === '[script info]' && key === 'playresy') {
      const y = Number(value);
      if (y > 0) info.playResY = y;
    } else if (section.includes('styles')) {
      if (key === 'format') styleFormat = value.split(',').map(s => s.trim().toLowerCase());
      else if (key === 'style') {
        const parts = value.split(',');
        const nameIdx = styleFormat.indexOf('name');
        const alignIdx = styleFormat.indexOf('alignment');
        if (nameIdx >= 0 && alignIdx >= 0 && parts[alignIdx] !== undefined) {
          const n = Number(parts[alignIdx].trim());
          info.styleAlign.set(parts[nameIdx].trim(), isV4Plus ? alignFromNumpad(n) : alignFromLegacy(n));
        }
      }
    } else if (section === '[events]' && key === 'format') {
      info.eventFormat = value.split(',').map(s => s.trim().toLowerCase());
    }
  }
  return info;
}

function splitFields(content: string, count: number): string[] {
  const parts: string[] = [];
  let pos = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = content.indexOf(',', pos);
    if (comma < 0) break;
    parts.push(content.slice(pos, comma));
    pos = comma + 1;
  }
  parts.push(content.slice(pos));
  return parts;
}

/** True for events that only draw vector shapes (no readable text). */
function isDrawingOnly(raw: string): boolean {
  return /\\p[1-9]/.test(raw) && sanitizeSubtitleText(raw).length === 0;
}

// ---------------------------------------------------------------------------
// Matroska text blocks
// ---------------------------------------------------------------------------

export interface MkvTextContext {
  codecId: string;
  ass?: AssHeaderInfo;
}

export function createMkvTextContext(codecId: string, codecPrivate?: Uint8Array): MkvTextContext {
  const ctx: MkvTextContext = { codecId: codecId.toUpperCase() };
  if (codecPrivate && (ctx.codecId === 'S_TEXT/ASS' || ctx.codecId === 'S_TEXT/SSA' || ctx.codecId === 'S_ASS' || ctx.codecId === 'S_SSA')) {
    ctx.ass = parseAssHeader(new TextDecoder('utf-8').decode(codecPrivate));
  }
  return ctx;
}

/**
 * Converts one Matroska subtitle frame into cue text.
 * S_TEXT/ASS frames are "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text".
 */
export function textFromMkvFrame(ctx: MkvTextContext, data: Uint8Array): { text: string; align?: CueAlign } | null {
  const raw = new TextDecoder('utf-8').decode(data).replace(/\0+$/, '');
  if (ctx.codecId === 'S_TEXT/ASS' || ctx.codecId === 'S_TEXT/SSA' || ctx.codecId === 'S_ASS' || ctx.codecId === 'S_SSA') {
    const fields = splitFields(raw, 9);
    const body = fields.length >= 9 ? fields[8] : raw;
    const style = fields.length >= 9 ? fields[2].trim() : '';
    if (isDrawingOnly(body)) return null;
    const text = sanitizeSubtitleText(body);
    if (!text) return null;
    const align = detectOverrideAlign(body, ctx.ass?.playResY) || ctx.ass?.styleAlign.get(style) ||
      ctx.ass?.styleAlign.get(style.replace(/^\*/, ''));
    return { text, align: align === 'bottom' ? undefined : align };
  }
  // S_TEXT/UTF8 (SRT markup), S_TEXT/WEBVTT, S_TEXT/ASCII, D_WEBVTT/*
  const align = detectOverrideAlign(raw);
  const text = sanitizeSubtitleText(raw);
  if (!text) return null;
  return { text, align: align === 'bottom' ? undefined : align };
}

// ---------------------------------------------------------------------------
// File format parsers
// ---------------------------------------------------------------------------

const TIME_RE = '(\\d{1,3}:\\d{1,2}:\\d{1,2}[,\\.]\\d{1,3}|\\d{1,2}:\\d{2}[,\\.]\\d{1,3}|\\d{1,3}:\\d{1,2}:\\d{1,2})';
const ARROW_RE = new RegExp(`${TIME_RE}\\s*-{1,2}>\\s*${TIME_RE}`);

function normalizeNewlines(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
}

export function parseSrt(srtContent: string): SubtitleCue[] {
  if (!srtContent) return [];
  const lines = normalizeNewlines(srtContent).split('\n');
  const cues: SubtitleCue[] = [];
  let i = 0;
  let counter = 0;
  while (i < lines.length) {
    const match = lines[i].match(ARROW_RE);
    if (!match) {
      i++;
      continue;
    }
    const startMs = parseTimeToMs(match[1]);
    let endMs = parseTimeToMs(match[2]);
    if (endMs < startMs) endMs = startMs + 3000;
    const raw: string[] = [];
    i++;
    // A blank line ends the cue; a timing line also ends it (files missing blank separators)
    while (i < lines.length && lines[i].trim() !== '' && !ARROW_RE.test(lines[i])) {
      raw.push(lines[i]);
      i++;
    }
    // Drop a trailing numeric index that belongs to the next cue
    if (i < lines.length && ARROW_RE.test(lines[i]) && raw.length > 0 && /^\s*\d+\s*$/.test(raw[raw.length - 1])) raw.pop();
    const rawText = raw.join('\n');
    const text = sanitizeSubtitleText(rawText);
    counter++;
    if (text) {
      const align = detectOverrideAlign(rawText);
      cues.push({ id: `srt-${counter}-${startMs}`, startMs, endMs, text, ...(align && align !== 'bottom' ? { align } : {}) });
    }
  }
  return cues;
}

function vttAlign(settings: string): CueAlign | undefined {
  const m = settings.match(/line:\s*(-?[\d.]+)(%?)/);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (m[2] === '%') {
    if (v < 35) return 'top';
    if (v < 65) return 'middle';
    return undefined;
  }
  // Line numbers: non-negative counts from the top
  return v >= 0 && v < 4 ? 'top' : undefined;
}

export function parseVtt(vttContent: string): SubtitleCue[] {
  if (!vttContent) return [];
  const lines = normalizeNewlines(vttContent).split('\n');
  const cues: SubtitleCue[] = [];
  let counter = 0;
  let i = 0;
  let atBlockStart = true;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      atBlockStart = true;
      i++;
      continue;
    }
    // NOTE / STYLE / REGION blocks (only when they start a block) are skipped up to the next blank line
    if (atBlockStart && /^(NOTE|STYLE|REGION)(\s|$)/.test(trimmed) && !ARROW_RE.test(line)) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }
    atBlockStart = false;
    const match = line.match(ARROW_RE);
    if (!match) {
      i++; // header text or cue identifier
      continue;
    }
    const startMs = parseTimeToMs(match[1]);
    let endMs = parseTimeToMs(match[2]);
    if (endMs < startMs) endMs = startMs + 3000;
    const settings = line.slice(line.indexOf(match[0]) + match[0].length);
    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !ARROW_RE.test(lines[i])) {
      textLines.push(lines[i]);
      i++;
    }
    const rawText = textLines.join('\n');
    const text = sanitizeSubtitleText(rawText);
    counter++;
    if (text) {
      const align = vttAlign(settings) || detectOverrideAlign(rawText);
      cues.push({ id: `vtt-${counter}-${startMs}`, startMs, endMs, text, ...(align && align !== 'bottom' ? { align } : {}) });
    }
  }
  return cues;
}

export function parseAss(assContent: string): SubtitleCue[] {
  if (!assContent) return [];
  const normalized = normalizeNewlines(assContent);
  const header = parseAssHeader(normalized);
  const format = header.eventFormat && header.eventFormat.length > 0
    ? header.eventFormat
    : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const textIdx = format.indexOf('text') >= 0 ? format.indexOf('text') : format.length - 1;
  const startIdx = format.indexOf('start');
  const endIdx = format.indexOf('end');
  const styleIdx = format.indexOf('style');

  const cues: SubtitleCue[] = [];
  const seen = new Set<string>();
  let counter = 0;
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('Dialogue:')) continue;
    const parts = splitFields(line.slice(9).trim(), textIdx + 1);
    const rawStart = parts[startIdx >= 0 ? startIdx : 1]?.trim();
    const rawEnd = parts[endIdx >= 0 ? endIdx : 2]?.trim();
    const rawText = parts[textIdx] ?? '';
    if (!rawStart || !rawEnd || isDrawingOnly(rawText)) continue;
    const text = sanitizeSubtitleText(rawText);
    if (!text) continue;
    const startMs = parseTimeToMs(rawStart);
    let endMs = parseTimeToMs(rawEnd);
    if (endMs < startMs) endMs = startMs + 3000;
    const key = `${startMs}|${endMs}|${text}`;
    if (seen.has(key)) continue; // layered duplicates (outline/shadow copies)
    seen.add(key);
    counter++;
    const style = styleIdx >= 0 ? (parts[styleIdx] || '').trim() : '';
    const align = detectOverrideAlign(rawText, header.playResY) || header.styleAlign.get(style);
    cues.push({ id: `ass-${counter}-${startMs}`, startMs, endMs, text, ...(align && align !== 'bottom' ? { align } : {}) });
  }
  return cues;
}

/** SAMI (.smi) — common for Korean subtitles. Picks the preferred language class when several exist. */
export function parseSmi(content: string, preferredLang = 'en'): SubtitleCue[] {
  const text = normalizeNewlines(content);
  const syncRe = /<sync\s+start\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\s|<\/body|<\/sami|$)/gi;
  type Entry = { start: number; cls: string; html: string };
  const entries: Entry[] = [];
  let m: RegExpExecArray | null;
  while ((m = syncRe.exec(text)) !== null) {
    const start = Number(m[1]);
    const body = m[2];
    const pRe = /<p(?:\s+class\s*=\s*["']?([\w-]+)["']?)?[^>]*>([\s\S]*?)(?=<p[\s>]|$)/gi;
    let pm: RegExpExecArray | null;
    let found = false;
    while ((pm = pRe.exec(body)) !== null) {
      found = true;
      entries.push({ start, cls: (pm[1] || 'default').toLowerCase(), html: pm[2] });
    }
    if (!found) entries.push({ start, cls: 'default', html: body });
  }
  if (entries.length === 0) return [];

  const classes = [...new Set(entries.map(e => e.cls))];
  const pref = preferredLang.toLowerCase().slice(0, 2);
  const chosen = classes.find(c => c.startsWith(pref)) || classes.find(c => c.includes(pref)) || classes[0];
  const list = entries.filter(e => e.cls === chosen).sort((a, b) => a.start - b.start);

  const cues: SubtitleCue[] = [];
  for (let i = 0; i < list.length; i++) {
    const cleaned = sanitizeSubtitleText(list[i].html.replace(/\n/g, ' '));
    if (!cleaned) continue;
    const next = list[i + 1];
    const endMs = next ? next.start : list[i].start + 4000;
    if (endMs <= list[i].start) continue;
    cues.push({ id: `smi-${i}-${list[i].start}`, startMs: list[i].start, endMs, text: cleaned });
  }
  return cues;
}

/** MicroDVD: {startFrame}{endFrame}Text|Second line */
export function parseMicroDvd(content: string, defaultFps = 23.976): SubtitleCue[] {
  const lines = normalizeNewlines(content).split('\n');
  let fps = defaultFps;
  const cues: SubtitleCue[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^\{(\d+)\}\{(\d*)\}(.*)$/);
    if (!m) return;
    const body = m[3];
    if (idx < 3 && /^\d+(\.\d+)?$/.test(body.trim()) && Number(m[1]) <= 1) {
      const f = Number(body.trim());
      if (f > 5 && f < 121) fps = f;
      return;
    }
    const startMs = Math.round((Number(m[1]) / fps) * 1000);
    const endMs = m[2] ? Math.round((Number(m[2]) / fps) * 1000) : startMs + 3000;
    const text = sanitizeSubtitleText(body.replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n'));
    if (text && endMs > startMs) cues.push({ id: `mdvd-${idx}-${startMs}`, startMs, endMs, text });
  });
  return cues;
}

/** SubViewer 1/2: "00:00:01.00,00:00:03.00" followed by text using [br] */
export function parseSubViewer(content: string): SubtitleCue[] {
  const lines = normalizeNewlines(content).split('\n');
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}),(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})$/);
    if (!m) continue;
    const startMs = parseTimeToMs(m[1]);
    const endMs = parseTimeToMs(m[2]);
    const body: string[] = [];
    while (i + 1 < lines.length && lines[i + 1].trim() !== '') body.push(lines[++i]);
    const text = sanitizeSubtitleText(body.join('\n').replace(/\[br\]/gi, '\n'));
    if (text && endMs > startMs) cues.push({ id: `subv-${i}-${startMs}`, startMs, endMs, text });
  }
  return cues;
}

/** MPL2: [startDeciseconds][endDeciseconds]Text|Line two */
export function parseMpl2(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  normalizeNewlines(content).split('\n').forEach((line, idx) => {
    const m = line.match(/^\[(\d+)\]\[(\d*)\](.*)$/);
    if (!m) return;
    const startMs = Number(m[1]) * 100;
    const endMs = m[2] ? Number(m[2]) * 100 : startMs + 3000;
    const text = sanitizeSubtitleText(m[3].replace(/^\//, '').replace(/\|\/?/g, '\n'));
    if (text && endMs > startMs) cues.push({ id: `mpl2-${idx}-${startMs}`, startMs, endMs, text });
  });
  return cues;
}

export type TextSubtitleFormat = 'srt' | 'vtt' | 'ass' | 'smi' | 'microdvd' | 'subviewer' | 'mpl2';

export function detectTextSubtitleFormat(content: string, hint?: string): TextSubtitleFormat {
  const text = content.replace(/^\uFEFF/, '').trimStart();
  const head = text.slice(0, 4096);
  if (/^WEBVTT/.test(text)) return 'vtt';
  if (/<sami[\s>]/i.test(head) || /<sync\s+start/i.test(head)) return 'smi';
  if (/^\[Script Info\]/im.test(head) || /^Dialogue:/m.test(text.slice(0, 200000))) return 'ass';
  if (/^\{\d+\}\{\d*\}/m.test(head)) return 'microdvd';
  if (/^\[\d+\]\[\d*\]/m.test(head)) return 'mpl2';
  if (/^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*$/m.test(head)) return 'subviewer';
  const h = (hint || '').toLowerCase();
  if (h === 'vtt' || h === 'webvtt') return 'vtt';
  if (h === 'ass' || h === 'ssa') return 'ass';
  if (h === 'smi' || h === 'sami') return 'smi';
  return 'srt';
}

/**
 * Parses any supported text subtitle file. Content-based detection wins over the extension hint.
 * Returns chronologically sorted cues.
 */
export function parseSubtitleToCues(content: string, formatHint?: string, preferredLang?: string): SubtitleCue[] {
  if (!content) return [];
  const text = content.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let cues: SubtitleCue[];
  switch (detectTextSubtitleFormat(text, formatHint)) {
    case 'vtt': cues = parseVtt(text); break;
    case 'ass': cues = parseAss(text); break;
    case 'smi': cues = parseSmi(text, preferredLang); break;
    case 'microdvd': cues = parseMicroDvd(text); break;
    case 'mpl2': cues = parseMpl2(text); break;
    case 'subviewer': cues = parseSubViewer(text); break;
    default:
      cues = parseSrt(text);
      if (cues.length === 0 && text.includes('-->')) cues = parseVtt(text);
  }
  cues.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
  return cues;
}

// ---------------------------------------------------------------------------
// Cue lookup helpers
// ---------------------------------------------------------------------------

export function findCuesAtTime(cues: SubtitleCue[], timeMs: number): SubtitleCue[] {
  if (!cues || cues.length === 0) return [];
  const active: SubtitleCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (timeMs >= c.startMs && timeMs <= c.endMs) active.push(c);
  }
  return active;
}

export function findCueAtTime(cues: SubtitleCue[], timeMs: number): SubtitleCue | null {
  const active = findCuesAtTime(cues, timeMs);
  return active.length > 0 ? active[0] : null;
}

export function applySubtitleDelay(cues: SubtitleCue[], delayMs: number): SubtitleCue[] {
  if (!cues || cues.length === 0 || delayMs === 0) return cues;
  return cues.map(c => ({
    ...c,
    startMs: Math.max(0, c.startMs + delayMs),
    endMs: Math.max(0, c.endMs + delayMs)
  }));
}

// ---------------------------------------------------------------------------
// Charset detection for sidecar / local files
// ---------------------------------------------------------------------------

const LANGUAGE_CHARSETS: [RegExp, string][] = [
  [/\b(kor|ko|korean|kr)\b/i, 'euc-kr'],
  [/\b(jpn|ja|jp|japanese)\b/i, 'shift_jis'],
  [/\b(cht|big5|zh-tw|zh-hant|traditional)\b/i, 'big5'],
  [/\b(chi|zho|chs|zh|zh-cn|zh-hans|chinese|simplified)\b/i, 'gb18030'],
  [/\b(ara|ar|arabic|per|fas|fa|persian|farsi|urd|ur)\b/i, 'windows-1256'],
  [/\b(rus|ru|russian|ukr|uk|bul|bg|srp|sr|mac|bel)\b/i, 'windows-1251'],
  [/\b(gre|ell|el|greek)\b/i, 'windows-1253'],
  [/\b(heb|he|hebrew)\b/i, 'windows-1255'],
  [/\b(tur|tr|turkish)\b/i, 'windows-1254'],
  [/\b(pol|pl|cze|ces|cs|slo|slk|sk|hun|hu|rum|ron|ro|hrv|hr|slv|sl|bos)\b/i, 'windows-1250'],
  [/\b(tha|th|thai)\b/i, 'windows-874'],
  [/\b(vie|vi|vietnamese)\b/i, 'windows-1258']
];

function tryDecode(bytes: Uint8Array, encoding: string, fatal = false): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/** Share of high bytes forming valid EUC-KR (KS X 1001 Hangul) pairs. */
function eucKrScore(bytes: Uint8Array): number {
  let pairs = 0;
  let high = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    high++;
    if (b >= 0xb0 && b <= 0xc8 && bytes[i + 1] >= 0xa1 && bytes[i + 1] <= 0xfe) {
      pairs++;
      i++;
      high++;
    }
  }
  return high === 0 ? 0 : (pairs * 2) / high;
}

/**
 * Decodes subtitle file bytes. Handles BOMs, UTF-16 without BOM, strict UTF-8,
 * and legacy code pages chosen from filename/language hints or byte statistics.
 */
export function decodeSubtitleBytes(bytes: Uint8Array, hint = ''): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return tryDecode(bytes.subarray(2), 'utf-16le') || '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return tryDecode(bytes.subarray(2), 'utf-16be') || '';

  // UTF-16 without BOM: lots of NUL bytes on one parity
  const sample = bytes.subarray(0, Math.min(bytes.length, 4000));
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 === 0 ? evenZero++ : oddZero++);
  if (oddZero > sample.length * 0.3) return tryDecode(bytes, 'utf-16le') || '';
  if (evenZero > sample.length * 0.3) return tryDecode(bytes, 'utf-16be') || '';

  const utf8 = tryDecode(bytes, 'utf-8', true);
  if (utf8 !== null) return utf8;

  for (const [re, enc] of LANGUAGE_CHARSETS) {
    if (re.test(hint.replace(/[._\-\[\]()]/g, ' '))) {
      const decoded = tryDecode(bytes, enc);
      if (decoded) return decoded;
    }
  }
  if (eucKrScore(bytes) > 0.6) {
    const decoded = tryDecode(bytes, 'euc-kr');
    if (decoded) return decoded;
  }
  return tryDecode(bytes, 'windows-1252') || new TextDecoder('utf-8').decode(bytes);
}
