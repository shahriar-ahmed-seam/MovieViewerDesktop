import { spawn, ChildProcess } from 'child_process';
import { resolveFfprobePath } from './binary-resolver';
import {
  MediaInspectionResult,
  InspectedVideoStream,
  InspectedAudioStream,
  InspectedSubtitleStream,
  DiagnosticLogEntry,
  MediaTracksResult,
  ParsedAudioTrack,
  ParsedSubtitleTrack
} from '../shared/types';

const ISO_LANG_MAP: Record<string, string> = {
  kor: 'Korean', ko: 'Korean', 'ko-kr': 'Korean',
  eng: 'English', en: 'English', 'en-us': 'English (US)', 'en-gb': 'English (UK)',
  hin: 'Hindi', hi: 'Hindi', 'hi-in': 'Hindi',
  jpn: 'Japanese', ja: 'Japanese', 'ja-jp': 'Japanese',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
  spa: 'Spanish', es: 'Spanish', 'es-es': 'Spanish', 'es-mx': 'Spanish (Latin America)',
  ara: 'Arabic', ar: 'Arabic',
  fra: 'French', fre: 'French', fr: 'French',
  deu: 'German', ger: 'German', de: 'German',
  rus: 'Russian', ru: 'Russian',
  ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
  vie: 'Vietnamese', vi: 'Vietnamese',
  ind: 'Indonesian', id: 'Indonesian',
  tha: 'Thai', th: 'Thai',
  ben: 'Bengali', bn: 'Bengali',
  tam: 'Tamil', ta: 'Tamil',
  tel: 'Telugu', te: 'Telugu',
  urd: 'Urdu', ur: 'Urdu',
  pan: 'Punjabi', pa: 'Punjabi',
  tur: 'Turkish', tr: 'Turkish',
  pol: 'Polish', pl: 'Polish',
  nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
  swe: 'Swedish', sv: 'Swedish',
  nor: 'Norwegian', no: 'Norwegian',
  dan: 'Danish', da: 'Danish',
  fin: 'Finnish', fi: 'Finnish',
  fil: 'Filipino / Tagalog', tgl: 'Tagalog', tl: 'Tagalog',
  msa: 'Malay', may: 'Malay', ms: 'Malay',
  heb: 'Hebrew', he: 'Hebrew',
  ell: 'Greek', gre: 'Greek', el: 'Greek',
  ces: 'Czech', cze: 'Czech', cs: 'Czech',
  hun: 'Hungarian', hu: 'Hungarian',
  ron: 'Romanian', rum: 'Romanian', ro: 'Romanian',
  ukr: 'Ukrainian', uk: 'Ukrainian',
  bul: 'Bulgarian', bg: 'Bulgarian',
  hrv: 'Croatian', hr: 'Croatian',
  srp: 'Serbian', sr: 'Serbian',
  slo: 'Slovak', slk: 'Slovak', sk: 'Slovak',
  slv: 'Slovenian', sl: 'Slovenian',
  est: 'Estonian', et: 'Estonian',
  lav: 'Latvian', lv: 'Latvian',
  lit: 'Lithuanian', lt: 'Lithuanian',
  ice: 'Icelandic', isl: 'Icelandic', is: 'Icelandic',
  nob: 'Norwegian Bokmal', nb: 'Norwegian Bokmal', nno: 'Norwegian Nynorsk',
  per: 'Persian', fas: 'Persian', fa: 'Persian',
  kan: 'Kannada', kn: 'Kannada',
  mal: 'Malayalam', ml: 'Malayalam',
  mar: 'Marathi', mr: 'Marathi',
  guj: 'Gujarati', gu: 'Gujarati',
  nep: 'Nepali', ne: 'Nepali',
  sin: 'Sinhala', si: 'Sinhala',
  cat: 'Catalan', ca: 'Catalan',
  baq: 'Basque', eus: 'Basque',
  glg: 'Galician', gl: 'Galician',
  'pt-pt': 'Portuguese (Portugal)', 'es-419': 'Spanish (Latin America)', 'zh-hans': 'Chinese (Simplified)', 'zh-hant': 'Chinese (Traditional)',
  und: 'Undetermined'
};

const BITMAP_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgs',
  'dvd_subtitle',
  'vobsub',
  'dvb_subtitle',
  'xsub',
  'dvdsub'
]);

function normalizeLang(raw?: string): { code: string; label: string } {
  if (!raw) return { code: 'und', label: 'Unknown Language' };
  const clean = raw.trim().toLowerCase();
  const label = ISO_LANG_MAP[clean] || raw.trim();
  return { code: clean, label };
}

export class MediaInspector {
  private static activeProbes = new Map<string, ChildProcess>();

  public static cancel(url: string) {
    const p = this.activeProbes.get(url);
    if (p) {
      try { p.kill('SIGKILL'); } catch {}
      this.activeProbes.delete(url);
    }
  }

  /**
   * Probes any local file path or HTTP(S) media URL using verified ffprobe binary.
   */
  public static async inspectMedia(url: string, timeoutMs: number = 15000): Promise<MediaInspectionResult> {
    const diagnostics: DiagnosticLogEntry[] = [];
    const log = (level: 'info' | 'warn' | 'error', message: string, details?: any) => {
      diagnostics.push({ timestamp: Date.now(), level, message, details });
    };

    log('info', `Starting ffprobe media inspection for URL: ${url}`);

    // Cancel any preceding in-flight probe for this exact URL
    this.cancel(url);

    const probeRes = resolveFfprobePath();
    if (!probeRes.available || !probeRes.path) {
      log('error', 'ffprobe binary was not found on the system or bundled runtime.');
      return {
        success: false,
        url,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
        error: 'ffprobe binary is unavailable on this machine. Please install ffmpeg/ffprobe.',
        errorCode: 'BINARY_NOT_FOUND',
        diagnostics
      };
    }

    log('info', `Using ffprobe binary at: ${probeRes.path} (source: ${probeRes.source}, version: ${probeRes.version || 'unknown'})`);

    // NOTE: dispositions must be requested via the stream_disposition section; a bare
    // "disposition" entry in the stream section returns nothing, so default/forced were always false.
    const ffprobeArgs = [
      '-v', 'error',
      '-show_entries',
      'stream=index,codec_name,codec_type,channels,channel_layout,width,height,r_frame_rate,sample_rate' +
        ':stream_disposition=default,forced,hearing_impaired,visual_impaired,comment,captions' +
        ':stream_tags=language,title,handler_name' +
        ':format=format_name,duration',
      '-of', 'json',
      url
    ];

    let stdout = '';
    let stderr = '';

    try {
      const probePromise = new Promise<{ code: number | null }>((resolve, reject) => {
        const proc = spawn(probeRes.path!, ffprobeArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        this.activeProbes.set(url, proc);

        const timer = setTimeout(() => {
          log('warn', `ffprobe inspection timed out after ${timeoutMs}ms`);
          try { proc.kill('SIGKILL'); } catch {}
          reject(new Error(`ffprobe inspection timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('error', (err) => {
          clearTimeout(timer);
          this.activeProbes.delete(url);
          reject(err);
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          this.activeProbes.delete(url);
          resolve({ code });
        });
      });

      const { code } = await probePromise;

      if (code !== 0) {
        log('error', `ffprobe exited with code ${code}`, { stderr });
        return {
          success: false,
          url,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: [],
          error: stderr.trim() || `ffprobe failed with exit code ${code}`,
          errorCode: 'NETWORK_ERROR',
          diagnostics
        };
      }

      let parsedJson: any;
      try {
        parsedJson = JSON.parse(stdout);
      } catch (jsonErr: any) {
        log('error', `Failed to parse ffprobe json: ${jsonErr.message}`, { stdout, stderr });
        return {
          success: false,
          url,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: [],
          error: `Failed to parse ffprobe output: ${jsonErr.message}`,
          errorCode: 'PARSE_ERROR',
          diagnostics
        };
      }

      if ((!parsedJson.streams || parsedJson.streams.length === 0) && !parsedJson.format?.format_name) {
        return {
          success: false,
          url,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: [],
          error: stderr.trim() || 'No valid media streams found in target',
          errorCode: 'PARSE_ERROR',
          diagnostics
        };
      }

      log('info', 'ffprobe output successfully received and parsed into JSON', {
        streamCount: parsedJson.streams?.length || 0,
        format: parsedJson.format?.format_name,
        duration: parsedJson.format?.duration
      });

      const videoStreams: InspectedVideoStream[] = [];
      const audioStreams: InspectedAudioStream[] = [];
      const subtitleStreams: InspectedSubtitleStream[] = [];

      const streams: any[] = Array.isArray(parsedJson.streams) ? parsedJson.streams : [];
      const streamTypes: string[] = [];
      for (const s of streams) {
        if (typeof s.index === 'number') streamTypes[s.index] = s.codec_type || 'data';
      }
      for (const s of streams) {
        const sIdx = typeof s.index === 'number' ? s.index : 0;
        const codec = (s.codec_name || '').toLowerCase();
        const type = s.codec_type;
        const disposition = s.disposition || {};
        const isDefault = disposition.default === 1;
        const tags = s.tags || {};
        const lang = normalizeLang(tags.language || tags.LANG || tags.Language);
        const title = tags.title || tags.TITLE || undefined;

        if (type === 'video') {
          let fps: number | undefined;
          if (s.r_frame_rate && s.r_frame_rate.includes('/')) {
            const [num, den] = s.r_frame_rate.split('/').map(Number);
            if (den > 0) fps = Math.round((num / den) * 100) / 100;
          }
          videoStreams.push({
            streamIndex: sIdx,
            codec: codec.toUpperCase(),
            width: s.width,
            height: s.height,
            fps,
            bitrate: s.bit_rate ? Number(s.bit_rate) : undefined
          });
        } else if (type === 'audio') {
          audioStreams.push({
            streamIndex: sIdx,
            codec: codec.toUpperCase(),
            channels: s.channels || 2,
            channelLayout: s.channel_layout,
            language: lang.code,
            title: title || lang.label,
            isDefault,
            disposition,
            sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined
          });
        } else if (type === 'subtitle') {
          const isBitmap = BITMAP_CODECS.has(codec);
          let format: 'ass' | 'srt' | 'vtt' | 'pgs' | 'vobsub' | 'other' = 'other';
          if (isBitmap) {
            format = codec.includes('pgs') ? 'pgs' : (codec.startsWith('dvd') || codec === 'vobsub' ? 'vobsub' : 'other');
          } else if (codec === 'subrip' || codec === 'srt') {
            format = 'srt';
          } else if (codec === 'ass' || codec === 'ssa') {
            format = 'ass';
          } else if (codec === 'webvtt') {
            format = 'vtt';
          }
          const titleLower = String(title || '').toLowerCase();

          subtitleStreams.push({
            streamIndex: sIdx,
            codec: codec ? codec.toUpperCase() : 'UNKNOWN',
            codecName: codec,
            kind: isBitmap ? 'bitmap' : 'text',
            language: lang.code,
            title: title || undefined,
            isDefault,
            isForced: disposition.forced === 1 || /\bforced\b/.test(titleLower),
            isHearingImpaired: disposition.hearing_impaired === 1 || /\b(sdh|cc|hearing)\b/.test(titleLower),
            isCommentary: disposition.comment === 1 || /commentary/.test(titleLower),
            disposition,
            format
          });
        }
      }

      const duration = parsedJson.format?.duration ? parseFloat(parsedJson.format.duration) : undefined;
      const container = parsedJson.format?.format_name || undefined;

      return {
        success: true,
        url,
        container,
        duration,
        videoStreams,
        audioStreams,
        subtitleStreams,
        streamTypes,
        diagnostics
      };
    } catch (err: any) {
      log('error', `Exception during media inspection: ${err.message}`);
      return {
        success: false,
        url,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
        error: err.message || 'Unknown inspection error',
        errorCode: err.message?.includes('timed out') ? 'PROBE_TIMEOUT' : 'NETWORK_ERROR',
        diagnostics
      };
    }
  }

  /**
   * Adapts MediaInspectionResult into the application's MediaTracksResult format with true stream indexes.
   */
  public static async analyzeTracks(url: string): Promise<MediaTracksResult> {
    const inspection = await this.inspectMedia(url);
    if (!inspection.success) {
      console.warn(`Media inspection failed for ${url}:`, inspection.error);
      return {
        audioTracks: [],
        subtitleTracks: [],
        inspection
      };
    }

    const audioTracks: ParsedAudioTrack[] = inspection.audioStreams.map((a, i) => {
      const langName = ISO_LANG_MAP[a.language] || a.language.toUpperCase();
      const channelLabel = a.channels === 6 ? '5.1 Surround' : a.channels === 8 ? '7.1 Surround' : a.channels === 1 ? 'Mono' : 'Stereo';
      const label = a.title && a.title !== langName
        ? `${langName} - ${a.title} (${a.codec}, ${channelLabel})`
        : `${langName} (${a.codec}, ${channelLabel})${a.isDefault ? ' [Default]' : ''}`;

      return {
        id: `stream-audio-${a.streamIndex}`,
        trackNumber: i + 1,
        streamIndex: a.streamIndex,
        label,
        language: a.language,
        codec: a.codec,
        channels: a.channels,
        isDefault: a.isDefault,
        title: a.title
      };
    });

    const subtitleTracks: ParsedSubtitleTrack[] = inspection.subtitleStreams.map((s, i) => {
      const known = ISO_LANG_MAP[s.language];
      const langName = known && s.language !== 'und' ? known : '';
      const title = (s.title || '').trim();
      const titleIsNoise = !title || title.toLowerCase() === langName.toLowerCase() ||
        /\.(org|com|net|me|in|ag|zip|plus|kids|mx|to|cc)\b|www\.|@|^(srt|ass|subrip)$/i.test(title);
      const parts: string[] = [];
      if (langName) parts.push(langName);
      if (!titleIsNoise) parts.push(title);
      if (parts.length === 0) parts.push(title || known || `Track ${i + 1}`);
      const tags: string[] = [];
      if (s.isForced && !/forced/i.test(title)) tags.push('Forced');
      if (s.isHearingImpaired && !/sdh|cc/i.test(title)) tags.push('SDH');
      if (s.format === 'pgs') tags.push('PGS');
      else if (s.format === 'vobsub') tags.push('VobSub');
      else if (s.format === 'ass') tags.push('ASS');
      const label = `${parts.join(' - ')}${tags.length ? ` [${tags.join(', ')}]` : ''}`;

      return {
        id: `stream-sub-${s.streamIndex}`,
        trackNumber: i + 1,
        streamIndex: s.streamIndex,
        label,
        language: s.language,
        codec: s.codec,
        codecName: s.codecName,
        format: s.format,
        isExternal: false,
        isBitmap: s.kind === 'bitmap',
        isDefault: s.isDefault,
        isForced: s.isForced,
        isHearingImpaired: s.isHearingImpaired,
        isCommentary: s.isCommentary,
        title: s.title
      };
    });

    const primaryVideo = inspection.videoStreams[0];

    return {
      audioTracks,
      subtitleTracks,
      videoCodec: primaryVideo ? `${primaryVideo.codec}${primaryVideo.height ? ` (${primaryVideo.height}p)` : ''}` : undefined,
      container: inspection.container,
      duration: inspection.duration,
      inspection
    };
  }

}
