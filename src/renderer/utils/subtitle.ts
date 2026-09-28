/**
 * Compatibility entry point. The single subtitle parser implementation lives in
 * src/shared/subtitles/text.ts and is shared by the main process (embedded tracks)
 * and the renderer (sidecar / local files).
 */
export {
  parseTimeToMs,
  parseVttTimeToMs,
  formatMsToVttTime,
  sanitizeSubtitleText,
  parseSrt,
  parseVtt,
  parseAss,
  parseSmi,
  parseMicroDvd,
  parseSubViewer,
  parseMpl2,
  parseSubtitleToCues,
  detectTextSubtitleFormat,
  decodeSubtitleBytes,
  findCuesAtTime,
  findCueAtTime,
  applySubtitleDelay
} from '../../shared/subtitles/text';
export type { SubtitleCue } from '../../shared/subtitles/types';
