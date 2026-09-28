import { SubtitleTrackStore } from './SubtitleTrackStore';
import type { SubtitleSessionEvent } from '../../shared/subtitles/types';
import { decodeSubtitleBytes, parseSubtitleToCues } from '../../shared/subtitles/text';
import { parseSupFile } from '../../shared/subtitles/pgs';
import { parseVobSubSidecar } from '../../shared/subtitles/vobsub';

/**
 * Renderer side of the embedded-subtitle pipeline: one global IPC listener routes streamed
 * events to the store of the matching session.
 */

const stores = new Map<string, SubtitleTrackStore>();
let unsubscribe: (() => void) | null = null;
let counter = 0;

function ensureListener() {
  if (unsubscribe || !window.electronAPI?.onSubtitleEvent) return;
  unsubscribe = window.electronAPI.onSubtitleEvent((evt: SubtitleSessionEvent) => {
    const store = stores.get(evt.sessionId);
    if (!store) return;
    switch (evt.type) {
      case 'header':
        if (evt.header) store.setHeader(evt.header);
        break;
      case 'data':
        if (evt.method) store.method = evt.method;
        if (evt.cues?.length) store.addCues(evt.cues);
        if (evt.packets?.length) store.addPackets(evt.packets);
        break;
      case 'progress':
        if (evt.progress) store.setProgress(evt.progress);
        break;
      case 'complete':
        if (evt.method) store.method = evt.method;
        store.setStatus(store.itemCount > 0 ? 'ready' : 'empty', store.itemCount > 0 ? null : 'This subtitle track contains no subtitles');
        stores.delete(evt.sessionId);
        break;
      case 'error':
        store.setStatus(store.itemCount > 0 ? 'ready' : 'error', evt.error || 'Subtitle extraction failed');
        stores.delete(evt.sessionId);
        break;
    }
  });
}

export interface EmbeddedSessionParams {
  optionId: string;
  videoUrl: string;
  streamIndex: number;
  codec?: string;
  startTimeMs: number;
  durationMs?: number;
  streamTypes?: string[];
}

export function startEmbeddedSession(p: EmbeddedSessionParams): SubtitleTrackStore {
  ensureListener();
  const sessionId = `sub-${Date.now()}-${++counter}`;
  const store = new SubtitleTrackStore(p.optionId, sessionId);
  stores.set(sessionId, store);
  if (!window.electronAPI?.startSubtitleSession) {
    store.setStatus('error', 'Subtitle service unavailable');
    return store;
  }
  window.electronAPI.startSubtitleSession({
    sessionId,
    videoUrl: p.videoUrl,
    streamIndex: p.streamIndex,
    codec: p.codec,
    startTimeMs: Math.max(0, Math.round(p.startTimeMs)),
    durationMs: p.durationMs,
    streamTypes: p.streamTypes
  }).then((res) => {
    if (!res?.ok) {
      store.setStatus('error', res?.error || 'Could not start subtitle extraction');
      stores.delete(sessionId);
    }
  }).catch((err) => {
    store.setStatus('error', err?.message || 'Could not start subtitle extraction');
    stores.delete(sessionId);
  });
  return store;
}

export function cancelSession(store: SubtitleTrackStore | null) {
  if (!store?.sessionId) return;
  if (stores.has(store.sessionId)) {
    stores.delete(store.sessionId);
    window.electronAPI?.cancelSubtitleSession?.(store.sessionId);
    if (store.status === 'loading') store.setStatus(store.itemCount > 0 ? 'ready' : 'error', store.itemCount > 0 ? null : 'Cancelled');
  }
}

export function isSessionActive(store: SubtitleTrackStore | null): boolean {
  return !!store?.sessionId && stores.has(store.sessionId);
}

export function reportPlayhead(store: SubtitleTrackStore | null, timeMs: number) {
  if (!store?.sessionId || !stores.has(store.sessionId) || !Number.isFinite(timeMs)) return;
  window.electronAPI?.updateSubtitlePlayhead?.(store.sessionId, Math.max(0, Math.round(timeMs)));
}

// ---------------------------------------------------------------------------
// Sidecar / local files
// ---------------------------------------------------------------------------

function extensionOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function looksLikeMpegPs(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba;
}

/**
 * Fills `store` from subtitle file bytes: text formats (any charset), PGS .sup, VobSub .idx/.sub.
 */
export function loadSubtitleBytes(
  store: SubtitleTrackStore,
  fileName: string,
  bytes: Uint8Array,
  companion?: { fileName: string; bytes: Uint8Array },
  preferredLang = 'en'
): void {
  store.method = 'file';
  const ext = extensionOf(fileName);
  try {
    // PGS .sup
    if (ext === 'sup' || (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x47)) {
      const packets = parseSupFile(bytes).map(p => ({ startMs: p.startMs, data: p.data.slice() }));
      store.setHeader({ kind: 'pgs', codecId: 'SUP' });
      store.addPackets(packets);
      store.setStatus(packets.length > 0 ? 'ready' : 'empty', packets.length > 0 ? null : `${fileName} contains no subtitles`);
      return;
    }
    // VobSub pair
    let idxBytes: Uint8Array | null = null;
    let subBytes: Uint8Array | null = null;
    if (ext === 'idx') {
      idxBytes = bytes;
      subBytes = companion?.bytes ?? null;
    } else if (ext === 'sub' && looksLikeMpegPs(bytes)) {
      subBytes = bytes;
      idxBytes = companion?.bytes ?? null;
    }
    if (idxBytes || subBytes) {
      if (!idxBytes || !subBytes) {
        store.setStatus('error', 'VobSub needs both the .idx and the .sub file');
        return;
      }
      const idxText = new TextDecoder('latin1').decode(idxBytes);
      const packets = parseVobSubSidecar(idxText, subBytes);
      store.setHeader({ kind: 'vobsub', codecId: 'VOBSUB', vobsubIdx: idxText });
      store.addPackets(packets);
      store.setStatus(packets.length > 0 ? 'ready' : 'empty', packets.length > 0 ? null : `${fileName} contains no subtitles`);
      return;
    }
    // Text formats
    const text = decodeSubtitleBytes(bytes, fileName);
    const cues = parseSubtitleToCues(text, ext, preferredLang);
    store.setHeader({ kind: 'text', codecId: ext.toUpperCase() || 'TEXT' });
    store.addCues(cues);
    store.setStatus(cues.length > 0 ? 'ready' : 'empty', cues.length > 0 ? null : `No subtitles could be read from ${fileName}`);
  } catch (err: any) {
    store.setStatus('error', err?.message || `Could not read ${fileName}`);
  }
}

export async function fetchSubtitleBytes(url: string): Promise<Uint8Array> {
  if (window.electronAPI?.fetchSubtitleFile) {
    const res = await window.electronAPI.fetchSubtitleFile(url);
    if (res.success && res.bytes) return res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes as any);
    throw new Error(res.error || 'Download failed');
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
