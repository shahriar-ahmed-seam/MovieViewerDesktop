import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import { resolveFfmpegPath } from './binary-resolver';

export interface RemuxStreamParams {
  videoUrl: string;
  audioStreamIndex: number;
  startTime?: number;
  sessionId?: string;
}

export class RemuxStreamer {
  private static server: http.Server | null = null;
  private static port: number = 0;
  private static activeSessions = new Map<string, ChildProcess>();

  public static async start(): Promise<number> {
    if (this.server && this.port > 0) {
      return this.port;
    }

    return new Promise<number>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.on('error', (err) => {
        console.error('[RemuxStreamer] Server error:', err);
        reject(err);
      });

      // Bind to 127.0.0.1 on dynamic random available port
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr?.port) {
          this.port = addr.port;
          this.server = srv;
          console.log(`[RemuxStreamer] Local remux server listening on http://127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to obtain port for RemuxStreamer'));
        }
      });
    });
  }

  public static stop() {
    for (const [key, proc] of this.activeSessions.entries()) {
      try { proc.kill('SIGKILL'); } catch {}
      this.activeSessions.delete(key);
    }
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }

  public static cancelSession(sessionId: string) {
    for (const [key, proc] of this.activeSessions.entries()) {
      if (key.startsWith(`${sessionId}#`)) {
        try { proc.kill('SIGKILL'); } catch {}
        this.activeSessions.delete(key);
      }
    }
  }

  public static getStreamUrl(params: RemuxStreamParams): string {
    const p = new URLSearchParams();
    p.set('url', params.videoUrl);
    p.set('audioIndex', params.audioStreamIndex.toString());
    if (params.startTime !== undefined && params.startTime > 0) {
      p.set('startTime', params.startTime.toString());
    }
    if (params.sessionId) {
      p.set('sessionId', params.sessionId);
    }
    return `http://127.0.0.1:${this.port}/remux?${p.toString()}`;
  }

  private static handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // Enable CORS for all local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url?.startsWith('/remux')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    try {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const videoUrl = parsedUrl.searchParams.get('url');
      const audioIndexStr = parsedUrl.searchParams.get('audioIndex');
      const startTimeStr = parsedUrl.searchParams.get('startTime');
      const sessionId = parsedUrl.searchParams.get('sessionId') || 'default';

      if (!videoUrl || !audioIndexStr) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url or audioIndex query parameters');
        return;
      }

      const audioIndex = parseInt(audioIndexStr, 10);
      const startTime = startTimeStr ? Math.max(0, parseFloat(startTimeStr)) : 0;

      const ffmpegRes = resolveFfmpegPath();
      if (!ffmpegRes.available || !ffmpegRes.path) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('ffmpeg binary is not available on this system');
        return;
      }

      // Cancel previous ffmpeg worker for this session
      this.cancelSession(sessionId);

      const ffmpegArgs: string[] = ['-v', 'error'];

      if (startTime > 0) {
        ffmpegArgs.push('-ss', startTime.toFixed(3));
      }

      ffmpegArgs.push(
        '-i', videoUrl,
        '-map', '0:v:0',
        '-map', `0:${audioIndex}`,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-f', 'matroska',
        'pipe:1'
      );

      console.log(`[RemuxStreamer] Spawning ffmpeg for stream index ${audioIndex}, start: ${startTime}s, session: ${sessionId}`);

      const proc = spawn(ffmpegRes.path, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const sessionKey = `${sessionId}#${Date.now()}`;
      this.activeSessions.set(sessionKey, proc);

      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
        'Transfer-Encoding': 'chunked',
        'Accept-Ranges': 'none'
      });

      proc.stdout.pipe(res);

      proc.stderr.on('data', (d) => {
        const errStr = d.toString('utf8');
        if (!errStr.includes('Broken pipe') && !errStr.includes('Conversion failed')) {
          console.warn('[RemuxStreamer ffmpeg stderr]:', errStr.trim());
        }
      });

      const cleanup = () => {
        try { proc.kill('SIGKILL'); } catch {}
        this.activeSessions.delete(sessionKey);
      };

      req.on('close', cleanup);
      res.on('finish', cleanup);
      proc.on('close', cleanup);
      proc.on('error', (err) => {
        console.error('[RemuxStreamer] ffmpeg spawn error:', err);
        cleanup();
      });
    } catch (e: any) {
      console.error('[RemuxStreamer] Request handling exception:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(e.message || 'Internal remux server error');
      }
    }
  }
}
