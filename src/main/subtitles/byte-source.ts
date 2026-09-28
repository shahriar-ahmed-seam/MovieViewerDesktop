import http from 'http';
import https from 'https';
import fs from 'fs';

/**
 * Random-access byte reader over HTTP(S) Range requests or local files.
 *
 * Embedded subtitles are tiny compared to the video, so instead of streaming the
 * entire file through ffmpeg (which is what made subtitles take minutes or time out),
 * the fast extractors read only the container index and the subtitle blocks.
 */
export interface ByteSource {
  readonly url: string;
  /** Total size in bytes, known after the first read (or null if the server does not report it). */
  size: number | null;
  /** Reads bytes [start, start + length). May return fewer bytes at end of file. */
  read(start: number, length: number): Promise<Buffer>;
  /**
   * Streams bytes [start, start + length) to `onData`. Returning false from `onData`
   * stops the transfer early (used to abandon a cluster once its subtitle blocks are found).
   */
  stream(start: number, length: number, onData: (chunk: Buffer) => boolean): Promise<void>;
  close(): void;
}

export class RangeNotSupportedError extends Error {
  constructor(url: string) {
    super(`Server does not support HTTP Range requests for ${url}`);
    this.name = 'RangeNotSupportedError';
  }
}

export class SourceAbortedError extends Error {
  constructor() {
    super('Read aborted');
    this.name = 'SourceAbortedError';
  }
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15000 });

const REQUEST_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;

export class HttpByteSource implements ByteSource {
  size: number | null = null;
  private resolvedUrl: string;
  private closed = false;
  private inflight = new Set<http.ClientRequest>();

  constructor(public readonly url: string, private readonly signal?: AbortSignal) {
    this.resolvedUrl = url;
    signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  close() {
    this.closed = true;
    for (const req of this.inflight) {
      try { req.destroy(new SourceAbortedError()); } catch { /* ignore */ }
    }
    this.inflight.clear();
  }

  async read(start: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    if (this.size !== null) {
      if (start >= this.size) return Buffer.alloc(0);
      length = Math.min(length, this.size - start);
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.closed) throw new SourceAbortedError();
      try {
        return await this.requestRange(this.resolvedUrl, start, start + length - 1, 0);
      } catch (err) {
        lastErr = err;
        if (err instanceof RangeNotSupportedError || err instanceof SourceAbortedError || this.closed) throw err;
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async stream(start: number, length: number, onData: (chunk: Buffer) => boolean): Promise<void> {
    if (length <= 0) return;
    if (this.size !== null) {
      if (start >= this.size) return;
      length = Math.min(length, this.size - start);
    }
    let delivered = 0;
    let stopped = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.closed) throw new SourceAbortedError();
      try {
        await this.requestRange(this.resolvedUrl, start + delivered, start + length - 1, 0, (chunk) => {
          delivered += chunk.length;
          if (!onData(chunk)) {
            stopped = true;
            return false;
          }
          return true;
        });
        return;
      } catch (err) {
        lastErr = err;
        if (stopped) return;
        if (err instanceof RangeNotSupportedError || err instanceof SourceAbortedError || this.closed) throw err;
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private requestRange(
    url: string,
    start: number,
    endInclusive: number,
    redirects: number,
    onChunk?: (chunk: Buffer) => boolean
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error(`Invalid URL: ${url}`));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.request(parsed, {
        method: 'GET',
        agent: isHttps ? httpsAgent : httpAgent,
        headers: {
          Range: `bytes=${start}-${endInclusive}`,
          'User-Agent': 'MovieViewer/1.0 (Desktop; Electron)',
          'Accept-Encoding': 'identity'
        },
        timeout: REQUEST_TIMEOUT_MS
      }, (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          this.inflight.delete(req);
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          this.resolvedUrl = next;
          this.requestRange(next, start, endInclusive, redirects + 1, onChunk).then(resolve, reject);
          return;
        }

        if (status === 200) {
          // Server ignored the Range header; random access is impossible without downloading everything.
          const len = Number(res.headers['content-length']);
          if (Number.isFinite(len) && len > 0) this.size = len;
          res.destroy();
          this.inflight.delete(req);
          reject(new RangeNotSupportedError(url));
          return;
        }

        if (status === 416) {
          res.resume();
          this.inflight.delete(req);
          const cr = String(res.headers['content-range'] || '');
          const m = cr.match(/\/(\d+)/);
          if (m) this.size = Number(m[1]);
          resolve(Buffer.alloc(0));
          return;
        }

        if (status !== 206) {
          res.resume();
          this.inflight.delete(req);
          reject(new Error(`HTTP ${status} for range ${start}-${endInclusive}`));
          return;
        }

        const cr = String(res.headers['content-range'] || '');
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
        if (m && m[3] !== '*') this.size = Number(m[3]);
        if (m && Number(m[1]) !== start) {
          res.destroy();
          this.inflight.delete(req);
          reject(new Error(`Server returned unexpected range ${cr}`));
          return;
        }

        const chunks: Buffer[] = [];
        let finished = false;
        res.on('data', (c: Buffer) => {
          if (finished) return;
          if (onChunk) {
            if (!onChunk(c)) {
              finished = true;
              this.inflight.delete(req);
              req.destroy();
              resolve(Buffer.alloc(0));
            }
          } else {
            chunks.push(c);
          }
        });
        res.on('end', () => {
          if (finished) return;
          finished = true;
          this.inflight.delete(req);
          resolve(onChunk ? Buffer.alloc(0) : Buffer.concat(chunks));
        });
        res.on('error', (e) => {
          if (finished) return;
          this.inflight.delete(req);
          reject(e);
        });
      });

      req.on('timeout', () => req.destroy(new Error(`Range request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
      req.on('error', (e) => {
        this.inflight.delete(req);
        reject(this.closed ? new SourceAbortedError() : e);
      });
      this.inflight.add(req);
      req.end();
    });
  }
}

export class FileByteSource implements ByteSource {
  size: number | null = null;
  private fd: number | null = null;

  constructor(public readonly url: string) {
    const filePath = url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname) : url;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }

  async read(start: number, length: number): Promise<Buffer> {
    if (this.fd === null) throw new SourceAbortedError();
    const size = this.size ?? 0;
    if (start >= size || length <= 0) return Buffer.alloc(0);
    const len = Math.min(length, size - start);
    const buf = Buffer.alloc(len);
    await new Promise<void>((resolve, reject) => {
      fs.read(this.fd!, buf, 0, len, start, (err) => (err ? reject(err) : resolve()));
    });
    return buf;
  }

  async stream(start: number, length: number, onData: (chunk: Buffer) => boolean): Promise<void> {
    const CHUNK = 256 * 1024;
    const end = Math.min(start + length, this.size ?? 0);
    for (let pos = start; pos < end; pos += CHUNK) {
      const chunk = await this.read(pos, Math.min(CHUNK, end - pos));
      if (chunk.length === 0 || !onData(chunk)) return;
    }
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }
}

export function openByteSource(url: string, signal?: AbortSignal): ByteSource {
  if (/^https?:\/\//i.test(url)) return new HttpByteSource(url, signal);
  return new FileByteSource(url);
}

/**
 * Like runWithConcurrency, but each worker picks the pending item closest to the current
 * playback position (items at/after `priority - lookBehindMs` first, then the nearest earlier ones).
 * The priority is re-read for every pick, so a seek immediately redirects fetching.
 */
export async function runPrioritized<T>(
  items: T[],
  timeOf: (item: T) => number,
  concurrency: number | ((nextItemMs: number, priorityMs: number) => number),
  getPriorityMs: () => number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
  lookBehindMs = 10000
): Promise<void> {
  const pending = [...items].sort((a, b) => timeOf(a) - timeOf(b));
  const nextIndex = (): number => {
    const target = getPriorityMs() - lookBehindMs;
    let lo = 0;
    let hi = pending.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeOf(pending[mid]) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo < pending.length ? lo : pending.length - 1;
  };
  const maxRunners = typeof concurrency === 'number' ? concurrency : Math.max(1, concurrency(0, 0));
  /** How many runners may work right now (fewer once the region around the playhead is done). */
  const allowed = (): number => {
    if (typeof concurrency === 'number' || pending.length === 0) return maxRunners;
    return Math.max(1, concurrency(timeOf(pending[nextIndex()]), getPriorityMs()));
  };
  let firstError: unknown = null;
  const runners: Promise<void>[] = [];
  for (let r = 0; r < Math.max(1, maxRunners); r++) {
    const runnerIndex = r;
    runners.push((async () => {
      while (firstError === null) {
        if (shouldStop?.()) return;
        if (pending.length === 0) return;
        if (runnerIndex >= allowed()) {
          // Parked: wake up if the playhead moves into an unfetched region
          await new Promise(res => setTimeout(res, 250));
          continue;
        }
        const item = pending.splice(nextIndex(), 1)[0];
        if (item === undefined) return;
        try {
          await worker(item);
        } catch (err) {
          if (firstError === null) firstError = err;
        }
      }
    })());
  }
  await Promise.all(runners);
  if (firstError !== null) throw firstError;
}

/** Runs async tasks with bounded concurrency, stopping early if `shouldStop` returns true. */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  const runners: Promise<void>[] = [];
  for (let r = 0; r < Math.max(1, concurrency); r++) {
    runners.push((async () => {
      while (firstError === null) {
        if (shouldStop?.()) return;
        const idx = next++;
        if (idx >= items.length) return;
        try {
          await worker(items[idx], idx);
        } catch (err) {
          if (firstError === null) firstError = err;
        }
      }
    })());
  }
  await Promise.all(runners);
  if (firstError !== null) throw firstError;
}
