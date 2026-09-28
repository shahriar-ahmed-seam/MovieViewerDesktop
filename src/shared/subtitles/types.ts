/**
 * Shared subtitle data model used by the main-process extractors and the renderer overlay.
 */

export type SubtitleRenderKind = 'text' | 'pgs' | 'vobsub';

export type CueAlign = 'bottom' | 'middle' | 'top';

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Vertical placement derived from ASS alignment/position or WebVTT settings. */
  align?: CueAlign;
}

export interface BitmapSubtitlePacket {
  startMs: number;
  /** Known end time (block duration, VobSub stop command). Otherwise the next packet ends it. */
  endMs?: number;
  data: Uint8Array;
}

export interface SubtitleTrackHeader {
  kind: SubtitleRenderKind;
  codecId: string;
  /** VobSub .idx text (palette + frame size). */
  vobsubIdx?: string;
}

export type SubtitleExtractionMethod = 'mkv-index' | 'mp4-index' | 'ffmpeg-stream' | 'memory-cache';

export interface SubtitleProgress {
  /** Items (blocks / samples) fetched so far, when the total is known. */
  loaded?: number;
  total?: number;
  /** Streaming mode: media time range already scanned. */
  coveredFromMs?: number;
  coveredUntilMs?: number;
}

export interface SubtitleSessionEvent {
  sessionId: string;
  type: 'header' | 'data' | 'progress' | 'complete' | 'error';
  header?: SubtitleTrackHeader;
  cues?: SubtitleCue[];
  packets?: BitmapSubtitlePacket[];
  method?: SubtitleExtractionMethod;
  progress?: SubtitleProgress;
  error?: string;
  elapsedMs?: number;
  totalItems?: number;
}

export interface SubtitleSessionRequest {
  sessionId: string;
  videoUrl: string;
  /** ffprobe stream index of the subtitle stream. */
  streamIndex: number;
  /** ffprobe codec_name (lower case). */
  codec?: string;
  /** Current playback position, so the nearest subtitles are fetched first. */
  startTimeMs?: number;
  durationMs?: number;
  /** ffprobe codec_type for every stream index (used to map to Matroska track numbers). */
  streamTypes?: string[];
}

export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1',
  'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl', 'hdmv_text_subtitle', 'ttml', 'eia_608'
]);

export const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'pgs', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub', 'dvb_subtitle', 'dvbsub', 'xsub'
]);

/** Bitmap codecs this app can decode and draw. */
export const RENDERABLE_BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'pgs', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub']);

export function bitmapKindForCodec(codec: string): SubtitleRenderKind | null {
  const c = codec.toLowerCase();
  if (c === 'hdmv_pgs_subtitle' || c === 'pgs' || c === 'pgssub' || c === 's_hdmv/pgs') return 'pgs';
  if (c === 'dvd_subtitle' || c === 'dvdsub' || c === 'vobsub' || c === 's_vobsub') return 'vobsub';
  return null;
}
