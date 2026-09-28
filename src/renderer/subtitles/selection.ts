/**
 * Subtitle auto-selection and sidecar matching.
 *
 * Releases on the media server commonly carry a tiny "Forced" track first, "Signs & Songs"
 * tracks marked default, SDH variants, commentary tracks, and many languages. Picking the
 * first English track (the old behaviour) often selected a track with 3-15 cues, which looked
 * exactly like "subtitles don't work".
 */

export interface SelectableSubtitle {
  id: string;
  label: string;
  language?: string;
  title?: string;
  isExternal: boolean;
  isEmbedded?: boolean;
  isBitmap?: boolean;
  format?: string;
  codecName?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isCommentary?: boolean;
  /** Sidecar match quality against the playing video (higher = better). */
  matchScore?: number;
}

const LANG_ALIASES: Record<string, string[]> = {
  eng: ['en', 'eng', 'english'],
  ben: ['bn', 'ben', 'bengali', 'bangla'],
  hin: ['hi', 'hin', 'hindi'],
  kor: ['ko', 'kor', 'korean'],
  jpn: ['ja', 'jpn', 'japanese'],
  chi: ['zh', 'chi', 'zho', 'chinese', 'chs', 'cht', 'mandarin', 'cantonese'],
  spa: ['es', 'spa', 'spanish', 'castilian', 'espanol'],
  fre: ['fr', 'fre', 'fra', 'french', 'francais'],
  ger: ['de', 'ger', 'deu', 'german', 'deutsch'],
  ara: ['ar', 'ara', 'arabic'],
  urd: ['ur', 'urd', 'urdu'],
  tam: ['ta', 'tam', 'tamil'],
  tel: ['te', 'tel', 'telugu'],
  mal: ['ml', 'mal', 'malayalam'],
  kan: ['kn', 'kan', 'kannada'],
  ind: ['id', 'ind', 'indonesian'],
  may: ['ms', 'may', 'msa', 'malay'],
  tha: ['th', 'tha', 'thai'],
  vie: ['vi', 'vie', 'vietnamese'],
  por: ['pt', 'por', 'portuguese', 'brazilian'],
  rus: ['ru', 'rus', 'russian'],
  tur: ['tr', 'tur', 'turkish'],
  ita: ['it', 'ita', 'italian'],
  per: ['fa', 'per', 'fas', 'persian', 'farsi']
};

const ALIAS_TO_CODE = new Map<string, string>();
for (const [code, aliases] of Object.entries(LANG_ALIASES)) for (const a of aliases) ALIAS_TO_CODE.set(a, code);

export function normalizeLanguage(raw?: string): string {
  if (!raw) return 'und';
  const clean = raw.trim().toLowerCase().split(/[-_]/)[0];
  return ALIAS_TO_CODE.get(clean) || (clean.length === 3 ? clean : clean ? clean : 'und');
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Language of a track from its tag, title/label words, or file-name tokens. */
export function languageOf(opt: SelectableSubtitle): string {
  const tagged = normalizeLanguage(opt.language);
  if (tagged !== 'und') return tagged;
  const titleWords = tokens(opt.title || '');
  const labelWords = tokens(opt.label || '');
  // Track titles ("Eng", "English (SDH)") may use 3-letter codes; file names only count full
  // language names here, because short codes collide with ordinary words ("It", "May", "Per").
  const minLen = opt.isExternal ? 4 : 3;
  for (const w of [...titleWords, ...labelWords]) {
    const code = ALIAS_TO_CODE.get(w);
    if (code && w.length >= minLen) return code;
  }
  // File names like "Movie.2012.en.srt" / "Movie_eng.srt": a code right before the extension
  if (opt.isExternal) {
    const m = (opt.label || '').match(/[._\-]([a-z]{2,3})(?:[._\-](?:sdh|forced|cc|hi))?\.[a-z0-9]{2,4}(?:\s*\[[^\]]*\])?$/i);
    const code = m ? ALIAS_TO_CODE.get(m[1].toLowerCase()) : undefined;
    if (code) return code;
  }
  return 'und';
}

function describes(opt: SelectableSubtitle, re: RegExp): boolean {
  return re.test(`${opt.title || ''} ${opt.label || ''}`.toLowerCase());
}

export function isForcedTrack(opt: SelectableSubtitle): boolean {
  return !!opt.isForced || describes(opt, /\bforced\b/);
}

export function isSignsOnlyTrack(opt: SelectableSubtitle): boolean {
  return describes(opt, /\bsigns?\b|\bsongs?\b/) && !describes(opt, /dialog|full|complete/);
}

export function isCommentaryTrack(opt: SelectableSubtitle): boolean {
  return !!opt.isCommentary || describes(opt, /commentary/);
}

export function isUnsupportedCodec(opt: SelectableSubtitle): boolean {
  const c = (opt.codecName || '').toLowerCase();
  return c === 'dvb_subtitle' || c === 'dvb_teletext' || c === 'xsub' || c === 'eia_608';
}

export function scoreSubtitle(opt: SelectableSubtitle, preferredLang: string): number {
  if (isUnsupportedCodec(opt)) return -Infinity;
  if (opt.isExternal && opt.matchScore !== undefined && opt.matchScore < 0) return -Infinity;
  const pref = normalizeLanguage(preferredLang);
  const lang = languageOf(opt);
  let score = 0;
  if (lang === pref) score += 100;
  else if (lang === 'eng') score += 60;
  else if (lang === 'und') score += 40;
  if (isForcedTrack(opt)) score -= 90;
  if (isCommentaryTrack(opt)) score -= 120;
  if (isSignsOnlyTrack(opt)) score -= 70;
  if (opt.isHearingImpaired || describes(opt, /\bsdh\b/)) score -= 4;
  if (opt.isDefault) score += 3;
  if (!opt.isBitmap) score += 2;
  if (opt.isExternal) score += 8 + Math.min(20, Math.max(0, opt.matchScore || 0) / 5);
  return score;
}

/** Candidates in the order they should be tried (best first). */
export function rankSubtitles<T extends SelectableSubtitle>(options: T[], preferredLang: string): T[] {
  return options
    .map((o, i) => ({ o, i, s: scoreSubtitle(o, preferredLang) }))
    .filter(x => Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.o);
}

// ---------------------------------------------------------------------------
// Sidecar matching
// ---------------------------------------------------------------------------

interface EpisodeTag {
  season?: number;
  episode: number;
}

function episodeTag(name: string): EpisodeTag | null {
  const n = name.toLowerCase();
  const m = n.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/) || n.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  const e = n.match(/(?:\bep?|episode)[ ._-]*(\d{1,3})\b/);
  return e ? { episode: Number(e[1]) } : null;
}

function sameEpisode(a: EpisodeTag, b: EpisodeTag): boolean {
  if (a.episode !== b.episode) return false;
  return a.season === undefined || b.season === undefined || a.season === b.season;
}

function baseName(name: string): string {
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* keep */ }
  return decoded.replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * How well a sidecar subtitle file matches the video. Negative means "belongs to another episode".
 */
export function sidecarMatchScore(videoName: string, subName: string, videoCountInFolder: number): number {
  const v = baseName(videoName);
  const s = baseName(subName);
  const ve = episodeTag(videoName);
  const se = episodeTag(subName);
  if (ve && se && !sameEpisode(ve, se)) return -1;
  let score = 0;
  if (s === v) score += 100;
  else if (s.startsWith(v) || v.startsWith(s)) score += 90;
  if (ve && se) score += 60;
  const vt = new Set(v.split(' '));
  const st = s.split(' ');
  const shared = st.filter(t => vt.has(t)).length;
  score += Math.min(30, shared * 3);
  if (videoCountInFolder <= 1) score += 20;
  // Several videos, no episode tag and no name overlap: probably unrelated
  if (videoCountInFolder > 1 && score < 20) return -1;
  return score;
}
