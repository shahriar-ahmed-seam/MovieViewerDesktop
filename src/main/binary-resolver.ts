import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

let electronApp: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron');
  electronApp = electron?.app || null;
} catch {
  // Running outside electron runtime (e.g. tests or build tools)
}

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

const EXE = process.platform === 'win32' ? '.exe' : '';
const PLATFORM_DIR = `${process.platform}-${process.arch}`; // e.g. linux-x64, win32-x64

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (process.platform === 'win32') return fs.statSync(filePath).isFile();
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Files inside app.asar cannot be executed; electron-builder places them in app.asar.unpacked. */
function unpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function getBinaryVersion(binPath: string): string | undefined {
  try {
    const out = execFileSync(binPath, ['-version'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
    return out.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function findSystemBinary(binName: string): string | null {
  const candidates = process.platform === 'win32'
    ? []
    : [`/usr/bin/${binName}`, `/usr/local/bin/${binName}`, `/opt/homebrew/bin/${binName}`, `/snap/bin/${binName}`];
  for (const p of candidates) {
    if (isExecutable(p)) return p;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, binName + EXE);
    if (isExecutable(p)) return p;
  }
  return null;
}

function resolveBinary(name: 'ffmpeg' | 'ffprobe'): BinaryResolution {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const envPath = process.env[envKey];
  if (envPath && isExecutable(envPath)) {
    return { path: envPath, available: true, source: 'env' };
  }

  // Packaged app resources (asar.unpacked)
  if (electronApp?.isPackaged && process.resourcesPath) {
    const resPath = process.resourcesPath;
    const pkg = `@${name}-installer`;
    const candidates = [
      path.join(resPath, 'app.asar.unpacked', 'node_modules', pkg, PLATFORM_DIR, name + EXE),
      path.join(resPath, 'node_modules', pkg, PLATFORM_DIR, name + EXE),
      path.join(resPath, 'bin', name + EXE)
    ];
    for (const c of candidates) {
      if (isExecutable(c)) return { path: c, available: true, source: 'resources-unpacked' };
    }
  }

  const systemPath = findSystemBinary(name);
  if (systemPath) return { path: systemPath, available: true, source: 'system' };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installer = name === 'ffmpeg' ? require('@ffmpeg-installer/ffmpeg') : require('@ffprobe-installer/ffprobe');
    const p = installer?.path ? unpackedPath(installer.path) : null;
    if (p && isExecutable(p)) return { path: p, available: true, source: 'node-modules' };
  } catch {
    // ignore
  }

  return { path: null, available: false, source: 'none' };
}

// Resolution is cached: it used to run synchronously (including `-version`) for every probe,
// extraction and remux request, stalling the main process.
const cache: Partial<Record<'ffmpeg' | 'ffprobe', BinaryResolution>> = {};

function cached(name: 'ffmpeg' | 'ffprobe'): BinaryResolution {
  let res = cache[name];
  if (!res || !res.available) {
    res = resolveBinary(name);
    cache[name] = res;
  }
  return res;
}

export function resolveFfprobePath(): BinaryResolution {
  return cached('ffprobe');
}

export function resolveFfmpegPath(): BinaryResolution {
  return cached('ffmpeg');
}

export function getBinaryDiagnostics(): BinaryDiagnostics {
  const ffprobe = cached('ffprobe');
  const ffmpeg = cached('ffmpeg');
  if (ffprobe.available && ffprobe.path && ffprobe.version === undefined) ffprobe.version = getBinaryVersion(ffprobe.path);
  if (ffmpeg.available && ffmpeg.path && ffmpeg.version === undefined) ffmpeg.version = getBinaryVersion(ffmpeg.path);
  return { ffprobe, ffmpeg };
}
