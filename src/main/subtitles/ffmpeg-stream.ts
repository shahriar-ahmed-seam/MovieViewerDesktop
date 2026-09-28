import { spawn, ChildProcess } from 'child_process';
import { resolveFfmpegPath } from '../binary-resolver';
import { MkvStreamParser, MkvTrack, MKV_TRACK_TYPE } from './mkv';

/**
 * Progressive fallback for files whose subtitle blocks cannot be located through an index
 * (no Cues entries, non-Matroska/MP4 containers, servers without Range support).
 *
 * ffmpeg starts near the playback position, copies only the subtitle stream (plus the first
 * audio stream as a cheap progress clock) into a Matroska pipe, and every subtitle block is
 * forwarded as soon as it is demuxed. The network is several times faster than the video
 * bitrate, so extraction stays ahead of playback.
 */

/** Codecs that Matroska can carry as-is; everything else textual is converted to SubRip. */
const MKV_COPYABLE = new Set(['subrip', 'srt', 'ass', 'ssa', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvdsub']);

export interface FfmpegStreamCallbacks {
  onTrack: (track: MkvTrack) => void;
  onBlock: (block: { startMs: number; durationMs?: number; data: Uint8Array }) => void;
  /** Media time ffmpeg has read up to (from the audio clock), even when no subtitles appear. */
  onProgress?: (ms: number) => void;
  onExit: (result: { code: number | null; stderr: string; reachedEnd: boolean; stoppedByUs: boolean }) => void;
}

export class FfmpegSubtitleStream {
  private proc: ChildProcess | null = null;
  private stderr = '';
  private stopped = false;
  private paused = false;
  readonly fromMs: number;

  constructor(
    private readonly url: string,
    private readonly streamIndex: number,
    private readonly codec: string,
    fromMs: number,
    private readonly cb: FfmpegStreamCallbacks,
    private readonly withProgressClock = true
  ) {
    this.fromMs = Math.max(0, fromMs);
  }

  /** Seconds the demuxer is asked to seek to (a little before the requested time). */
  get seekMs(): number {
    const s = Math.max(0, this.fromMs - 8000);
    return s > 1000 ? s : 0;
  }

  start(): void {
    const ff = resolveFfmpegPath();
    if (!ff.available || !ff.path) {
      this.cb.onExit({ code: -1, stderr: 'ffmpeg binary is not available on this system', reachedEnd: false, stoppedByUs: false });
      return;
    }
    const isHttp = /^https?:\/\//i.test(this.url);
    const args: string[] = ['-v', 'error', '-nostdin'];
    if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (this.seekMs > 0) args.push('-ss', (this.seekMs / 1000).toFixed(3));
    args.push('-copyts', '-i', this.url, '-map', `0:${this.streamIndex}`);
    if (this.withProgressClock) args.push('-map', '0:a:0?');
    args.push(
      '-c:s', MKV_COPYABLE.has(this.codec) ? 'copy' : 'srt',
      '-c:a', 'copy',
      '-f', 'matroska',
      '-cluster_time_limit', '1000',
      '-cluster_size_limit', '262144',
      '-flush_packets', '1',
      'pipe:1'
    );

    let subtitleTrack = -1;
    let lastProgressReport = 0;
    const parser = new MkvStreamParser(
      (tracks) => {
        const t = tracks.find(x => x.type === MKV_TRACK_TYPE.subtitle) || tracks[0];
        if (t) {
          subtitleTrack = t.number;
          this.cb.onTrack(t);
        }
      },
      (block) => {
        if (block.trackNumber === subtitleTrack) {
          for (const frame of block.frames) this.cb.onBlock({ startMs: block.startMs, durationMs: block.durationMs, data: frame });
        } else if (this.cb.onProgress && block.startMs - lastProgressReport > 1000) {
          lastProgressReport = block.startMs;
          this.cb.onProgress(block.startMs);
        }
      }
    );

    const proc = spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout!.on('data', (chunk: Buffer) => {
      try {
        parser.push(chunk);
      } catch (err: any) {
        this.stderr += `\n[parser] ${err?.message || err}`;
        this.kill();
      }
    });
    proc.stderr!.on('data', (d: Buffer) => {
      if (this.stderr.length < 16000) this.stderr += d.toString('utf8');
    });
    proc.on('error', (err) => {
      this.stderr += `\n${err.message}`;
    });
    proc.on('close', (code) => {
      this.proc = null;
      this.cb.onExit({ code, stderr: this.stderr.trim(), reachedEnd: !this.stopped && code === 0, stoppedByUs: this.stopped });
    });
  }

  /** Suspends reading (POSIX only) once extraction is far ahead of playback to save bandwidth. */
  setPaused(paused: boolean): void {
    if (!this.proc || this.paused === paused || process.platform === 'win32') return;
    try {
      this.proc.kill(paused ? 'SIGSTOP' : 'SIGCONT');
      this.paused = paused;
    } catch { /* ignore */ }
  }

  get running(): boolean {
    return this.proc !== null;
  }

  private kill() {
    if (this.proc) {
      try {
        if (this.paused) this.proc.kill('SIGCONT');
        this.proc.kill('SIGKILL');
      } catch { /* ignore */ }
    }
  }

  stop(): void {
    this.stopped = true;
    this.kill();
  }
}
