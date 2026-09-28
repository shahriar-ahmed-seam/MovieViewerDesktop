export enum FileType {
  DIRECTORY = 'DIRECTORY',
  VIDEO = 'VIDEO',
  SUBTITLE = 'SUBTITLE',
  AUDIO = 'AUDIO',
  OTHER = 'OTHER'
}

export interface MediaFile {
  name: string;
  fullUrl: string;
  isDirectory: boolean;
  sizeString?: string | null;
  dateString?: string | null;
  extension: string;
  fileType: FileType;
  cleanDisplayName: string;
  isPlayableVideo: boolean;
  isSubtitleFile: boolean;
}

export interface DirectoryContext {
  directoryUrl: string;
  directoryTitle: string;
  videoFiles: MediaFile[];
  subtitleFiles: MediaFile[];
}

export interface PlaybackPosition {
  videoUrl: string;
  title: string;
  directoryUrl: string;
  positionMs: number;
  durationMs: number;
  lastPlayedTimestamp: number;
  completed: boolean;
  progressFraction?: number;
  formattedPosition?: string;
  formattedDuration?: string;
}

export interface ServerBookmark {
  id?: number;
  title: string;
  url: string;
  lastVisitedTimestamp: number;
}

export interface AppSettings {
  serverUrl: string;
  defaultPlaybackSpeed: number;
  seekJumpSeconds: number;
  autoResume: boolean;
  githubRepo: string;
  autoCheckUpdates: boolean;
  developerDiagnostics?: boolean;
  /** ISO 639 code preferred when auto-selecting subtitles (e.g. 'eng', 'ben', 'kor'). */
  preferredSubtitleLanguage?: string;
  /** Turn subtitles on automatically when a video has them. */
  subtitlesEnabledByDefault?: boolean;
  /** Subtitle text size multiplier (1 = default). */
  subtitleScale?: number;
}

export interface SubtitleExtractionResult {
  success: boolean;
  rawText?: string;
  exitCode: number;
  stderr: string;
  error?: string;
  characterCount: number;
  cueCount: number;
}

export type SubtitlePipelineStage =
  | 'no_track_selected'
  | 'extracting'
  | 'extraction_failed'
  | 'zero_cues'
  | 'bitmap_unsupported'
  | 'no_active_cue_at_time'
  | 'actively_rendering';

export interface BinaryResolution {
  path: string | null;
  available: boolean;
  source: 'env' | 'resources-unpacked' | 'node-modules' | 'system' | 'none';
  version?: string;
}

export interface BinaryDiagnostics {
  ffprobe: BinaryResolution;
  ffmpeg: BinaryResolution;
}

export interface SubtitlePipelineDiagnostics {
  selectedLabel: string | null;
  streamIndex: number | null;
  codec: string | null;
  isBitmap: boolean;
  ffprobeInfo?: BinaryResolution;
  ffmpegInfo?: BinaryResolution;
  ffmpegExitCode: number | null;
  ffmpegStderr: string | null;
  extractedCharCount: number;
  extractedCueCount: number;
  firstCuePreview: string | null;
  currentVideoTimeMs: number;
  activeCueCount: number;
  pipelineStage: SubtitlePipelineStage;
}

export interface PlaybackDiagnosticsState {
  mediaUrl?: string;
  sanitizedUrl: string;
  container?: string;
  duration?: number;
  videoStreams: InspectedVideoStream[];
  audioStreams: InspectedAudioStream[];
  subtitleStreams: InspectedSubtitleStream[];
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex?: number;
  selectedAudioLabel?: string;
  selectedSubtitleLabel?: string;
  subtitleType?: string;
  subtitleExtractionStatus: 'idle' | 'extracting' | 'ready' | 'failed' | 'bitmap_unsupported';
  subtitleError?: string;
  totalCues: number;
  activeCues: { id: string; startMs: number; endMs: number; text: string }[];
  currentTime: number;
  bufferedEnd: number;
  bufferedPercent: number;
  playbackState: 'playing' | 'paused' | 'seeking' | 'buffering' | 'ended';
  mediaError: string | null;
  lastActionMessage?: string;
  subtitlePipelineDiagnostics?: SubtitlePipelineDiagnostics;
}

export interface InspectedVideoStream {
  streamIndex: number;
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
}

export interface InspectedAudioStream {
  streamIndex: number;
  codec: string;
  channels: number;
  channelLayout?: string;
  language: string;
  title?: string;
  isDefault: boolean;
  disposition: Record<string, number>;
  sampleRate?: number;
}

export interface InspectedSubtitleStream {
  streamIndex: number;
  codec: string;
  /** Raw ffprobe codec_name (lower case), e.g. 'subrip', 'hdmv_pgs_subtitle'. */
  codecName?: string;
  kind: 'text' | 'bitmap';
  language: string;
  title?: string;
  isDefault: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isCommentary?: boolean;
  disposition: Record<string, number>;
  format: 'ass' | 'srt' | 'vtt' | 'pgs' | 'vobsub' | 'other';
}

export interface DiagnosticLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: any;
}

export interface MediaInspectionResult {
  success: boolean;
  url: string;
  container?: string;
  duration?: number;
  videoStreams: InspectedVideoStream[];
  audioStreams: InspectedAudioStream[];
  subtitleStreams: InspectedSubtitleStream[];
  /** ffprobe codec_type for every stream index (video/audio/subtitle/attachment/data). */
  streamTypes?: string[];
  error?: string;
  errorCode?: 'BINARY_NOT_FOUND' | 'PROBE_TIMEOUT' | 'NETWORK_ERROR' | 'UNSUPPORTED_MEDIA' | 'PARSE_ERROR';
  diagnostics?: DiagnosticLogEntry[];
}

export interface ParsedAudioTrack {
  id: string;
  trackNumber: number;
  streamIndex: number; // Actual ffprobe container stream index (e.g. 1, 2)
  label: string;
  language: string;
  codec: string;
  channels?: number;
  isDefault?: boolean;
  title?: string;
}

export interface ParsedSubtitleTrack {
  id: string;
  trackNumber: number;
  streamIndex?: number; // Actual ffprobe container stream index (e.g. 3, 4)
  label: string;
  language: string;
  codec: string;
  codecName?: string;
  format: 'ass' | 'srt' | 'vtt' | 'pgs' | 'vobsub' | 'other';
  isExternal: boolean;
  isBitmap?: boolean;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  isCommentary?: boolean;
  src?: string;
  title?: string;
}

export interface MediaTracksResult {
  audioTracks: ParsedAudioTrack[];
  subtitleTracks: ParsedSubtitleTrack[];
  videoCodec?: string;
  container?: string;
  duration?: number;
  inspection?: MediaInspectionResult;
}

export const DEFAULT_SERVER_URL = "http://172.16.50.12/";
export const DEFAULT_GITHUB_REPO = "shahriar-ahmed-seam/MovieViewerDesktop";

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  defaultPlaybackSpeed: 1.0,
  seekJumpSeconds: 10,
  autoResume: true,
  githubRepo: DEFAULT_GITHUB_REPO,
  autoCheckUpdates: true,
  developerDiagnostics: false,
  preferredSubtitleLanguage: 'eng',
  subtitlesEnabledByDefault: true,
  subtitleScale: 1
};

export const VIDEO_EXTENSIONS = new Set([
  'mkv', 'mp4', 'avi', 'webm', 'mov', 'm4v', 'flv', 'ts', 'wmv',
  '3gp', 'vob', 'ogv', 'm2ts', 'mts', 'divx', 'asf', 'f4v'
]);

export const SUBTITLE_EXTENSIONS = new Set([
  'srt', 'vtt', 'ass', 'ssa', 'sub', 'idx', 'smi', 'ttml'
]);

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'aac', 'flac', 'm4a', 'wav', 'ogg', 'opus', 'wma', 'alac', 'ac3', 'eac3', 'dts'
]);

export function extractExtension(fileName: string): string {
  const clean = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
  const lastDot = clean.lastIndexOf('.');
  if (lastDot > 0 && lastDot < clean.length - 1) {
    return clean.substring(lastDot + 1).toLowerCase();
  }
  return '';
}

export function getFileType(isDirectory: boolean, ext: string): FileType {
  if (isDirectory) return FileType.DIRECTORY;
  if (VIDEO_EXTENSIONS.has(ext)) return FileType.VIDEO;
  if (SUBTITLE_EXTENSIONS.has(ext)) return FileType.SUBTITLE;
  if (AUDIO_EXTENSIONS.has(ext)) return FileType.AUDIO;
  return FileType.OTHER;
}

export function formatTimeMs(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
