import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryContext, MediaFile, MediaTracksResult } from '../../shared/types';
import type { SubtitleOption } from '../components/TrackSelector';
import { SubtitleTrackStore } from './SubtitleTrackStore';
import { cancelSession, fetchSubtitleBytes, isSessionActive, loadSubtitleBytes, reportPlayhead, startEmbeddedSession } from './subtitleClient';
import { languageOf, rankSubtitles, sidecarMatchScore } from './selection';

export interface SubtitleUiStatus {
  state: 'off' | 'loading' | 'ready' | 'empty' | 'error';
  message: string | null;
  itemCount: number;
  detail: string | null;
}

interface UseSubtitlesParams {
  videoUrl: string;
  videoTitle: string;
  directoryContext: DirectoryContext;
  getMediaTimeMs: () => number;
  durationSec: number;
  preferredLanguage: string;
  autoEnable: boolean;
  showHud: (msg: string) => void;
}

const SUB_DIR_RE = /^(subs?|subtitles?|srt|subtitle files?)$/i;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, '');
}

export function useSubtitles(params: UseSubtitlesParams) {
  const [options, setOptions] = useState<SubtitleOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [store, setStore] = useState<SubtitleTrackStore | null>(null);
  const [delayMs, setDelayMs] = useState(0);
  const [, setTick] = useState(0);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const genRef = useRef(0);
  const optionsRef = useRef<SubtitleOption[]>([]);
  const storesRef = useRef(new Map<string, SubtitleTrackStore>());
  const activeRef = useRef<SubtitleTrackStore | null>(null);
  const autoQueueRef = useRef<string[] | null>(null);
  const embeddedRef = useRef<{ analysis: MediaTracksResult | null; provided: boolean }>({ analysis: null, provided: false });
  const sidecarsReadyRef = useRef(false);
  const autoStartedRef = useRef(false);

  const updateOptions = useCallback((next: SubtitleOption[]) => {
    optionsRef.current = next;
    setOptions(next);
  }, []);

  // Re-render (throttled) while the active store streams in, for status text in the UI
  useEffect(() => {
    if (!store) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastStatus = store.status;
    const unsub = store.subscribe(() => {
      if (store.status !== lastStatus) {
        lastStatus = store.status;
        setTick(t => t + 1);
        onStatusChange(store);
        return;
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          setTick(t => t + 1);
        }, 400);
      }
    });
    if (store.status !== 'loading') onStatusChange(store);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const activate = useCallback((opt: SubtitleOption, mode: 'auto' | 'user') => {
    const p = paramsRef.current;
    const prev = activeRef.current;
    if (prev && prev.optionId !== opt.id && isSessionActive(prev)) {
      cancelSession(prev);
      storesRef.current.delete(prev.optionId); // partial result; restart if chosen again
    }
    if (mode === 'user') autoQueueRef.current = null;

    let s = storesRef.current.get(opt.id);
    if (s && (s.status === 'error' || (s.status === 'loading' && s.sessionId && !isSessionActive(s)))) s = undefined;
    if (!s) {
      if (opt.isEmbedded && opt.streamIndex !== undefined) {
        s = startEmbeddedSession({
          optionId: opt.id,
          videoUrl: p.videoUrl,
          streamIndex: opt.streamIndex,
          codec: opt.codecName,
          startTimeMs: p.getMediaTimeMs(),
          durationMs: p.durationSec > 0 ? p.durationSec * 1000 : undefined,
          streamTypes: embeddedRef.current.analysis?.inspection?.streamTypes
        });
      } else if (opt.sidecarUrl) {
        const created = new SubtitleTrackStore(opt.id);
        s = created;
        const gen = genRef.current;
        (async () => {
          try {
            const bytes = await fetchSubtitleBytes(opt.sidecarUrl!);
            let companion: { fileName: string; bytes: Uint8Array } | undefined;
            if (opt.companionUrl) {
              companion = { fileName: opt.companionName || 'companion', bytes: await fetchSubtitleBytes(opt.companionUrl) };
            }
            if (gen !== genRef.current) return;
            loadSubtitleBytes(created, opt.sidecarName || opt.label, bytes, companion, paramsRef.current.preferredLanguage);
          } catch (err: any) {
            if (gen === genRef.current) created.setStatus('error', `Could not download ${opt.label}: ${err?.message || err}`);
          }
        })();
      } else {
        return;
      }
      storesRef.current.set(opt.id, s);
    }
    activeRef.current = s;
    setStore(s);
    setSelectedId(opt.id);
  }, []);

  /** Auto-mode fallback: an empty/broken track moves on to the next best candidate. */
  const onStatusChange = useCallback((s: SubtitleTrackStore) => {
    if (s !== activeRef.current) return;
    if ((s.status === 'empty' || s.status === 'error') && autoQueueRef.current && autoQueueRef.current.length > 0) {
      const nextId = autoQueueRef.current.shift()!;
      const next = optionsRef.current.find(o => o.id === nextId);
      if (next) {
        activate(next, 'auto');
        return;
      }
    }
    if (s.status === 'error' || s.status === 'empty') {
      paramsRef.current.showHud(s.error || 'Subtitle track is empty');
    }
  }, [activate]);

  const maybeAutoStart = useCallback(() => {
    if (autoStartedRef.current || !sidecarsReadyRef.current || !embeddedRef.current.provided) return;
    autoStartedRef.current = true;
    if (!paramsRef.current.autoEnable) return;
    const ranked = rankSubtitles(optionsRef.current, paramsRef.current.preferredLanguage || 'eng');
    if (ranked.length === 0) return;
    autoQueueRef.current = ranked.slice(1, 6).map(o => o.id);
    activate(ranked[0], 'auto');
  }, [activate]);

  const mergeOptions = useCallback((sidecars: SubtitleOption[] | null, embedded: SubtitleOption[] | null) => {
    const current = optionsRef.current;
    const keepLocal = current.filter(o => o.isLocal);
    const side = sidecars ?? current.filter(o => o.isExternal && !o.isLocal);
    const emb = embedded ?? current.filter(o => o.isEmbedded);
    updateOptions([...keepLocal, ...side, ...emb]);
  }, [updateOptions]);

  const discoverSidecars = useCallback(async (gen: number): Promise<SubtitleOption[]> => {
    const p = paramsRef.current;
    const ctx = p.directoryContext;
    const videoName = p.videoTitle;
    let files: MediaFile[] = [...(ctx?.subtitleFiles || [])];
    const videoCount = Math.max(1, ctx?.videoFiles?.length || 1);

    if (window.electronAPI?.fetchDirectory && ctx?.directoryUrl) {
      try {
        const listing = files.length === 0 ? await window.electronAPI.fetchDirectory(ctx.directoryUrl) : null;
        if (gen !== genRef.current) return [];
        const items = listing?.success && listing.data ? listing.data : [];
        if (files.length === 0) files = items.filter(it => it.isSubtitleFile);
        // "Subs" / "Subtitles" folders (optionally with a per-episode subfolder)
        const subDirs = items.filter(it => it.isDirectory && SUB_DIR_RE.test(it.cleanDisplayName.trim())).slice(0, 2);
        for (const dir of subDirs) {
          const res = await window.electronAPI.fetchDirectory(dir.fullUrl);
          if (gen !== genRef.current) return [];
          if (!res.success || !res.data) continue;
          files.push(...res.data.filter(it => it.isSubtitleFile));
          const base = stripExt(videoName).toLowerCase();
          const episodeDir = res.data.find(it => it.isDirectory && base.startsWith(it.cleanDisplayName.toLowerCase().trim()));
          if (episodeDir) {
            const inner = await window.electronAPI.fetchDirectory(episodeDir.fullUrl);
            if (gen !== genRef.current) return [];
            if (inner.success && inner.data) {
              // Files inside a per-episode folder belong to this video regardless of their names
              files.push(...inner.data.filter(it => it.isSubtitleFile).map(it => ({ ...it, cleanDisplayName: `${stripExt(videoName)} ${it.cleanDisplayName}` })));
            }
          }
        }
      } catch {
        // Directory listing is best effort
      }
    }

    // Pair VobSub .idx with .sub; standalone .sub files are MicroDVD text
    const byBase = new Map<string, MediaFile[]>();
    for (const f of files) {
      const key = stripExt(f.fullUrl);
      byBase.set(key, [...(byBase.get(key) || []), f]);
    }
    const out: SubtitleOption[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.fullUrl)) continue;
      const ext = f.extension.toLowerCase();
      const siblings = byBase.get(stripExt(f.fullUrl)) || [];
      let companion: MediaFile | undefined;
      if (ext === 'idx') companion = siblings.find(x => x.extension.toLowerCase() === 'sub');
      if (ext === 'sub' && siblings.some(x => x.extension.toLowerCase() === 'idx')) continue; // handled via .idx
      seen.add(f.fullUrl);
      if (companion) seen.add(companion.fullUrl);
      const match = sidecarMatchScore(videoName, f.cleanDisplayName, videoCount);
      const opt: SubtitleOption = {
        id: `sidecar-${f.fullUrl}`,
        label: f.cleanDisplayName + (companion ? ' [VobSub]' : ''),
        isExternal: true,
        format: ext,
        sidecarUrl: f.fullUrl,
        sidecarName: f.name,
        companionUrl: companion?.fullUrl,
        companionName: companion?.name,
        isBitmap: ext === 'idx' || ext === 'sup',
        matchScore: match
      };
      opt.language = languageOf({ ...opt, language: undefined });
      out.push(opt);
    }
    const matching = out.filter(o => (o.matchScore ?? 0) >= 0);
    const list = matching.length > 0 ? matching : out.map(o => ({ ...o, matchScore: 0 }));
    return list.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  }, []);

  // New video: reset everything and discover sidecars
  useEffect(() => {
    const gen = ++genRef.current;
    const prev = activeRef.current;
    if (prev) cancelSession(prev);
    for (const s of storesRef.current.values()) cancelSession(s);
    storesRef.current.clear();
    activeRef.current = null;
    autoQueueRef.current = null;
    autoStartedRef.current = false;
    sidecarsReadyRef.current = false;
    embeddedRef.current = { analysis: null, provided: false };
    updateOptions([]);
    setSelectedId(null);
    setStore(null);
    setDelayMs(0);

    discoverSidecars(gen).then((sidecars) => {
      if (gen !== genRef.current) return;
      mergeOptions(sidecars, null);
      sidecarsReadyRef.current = true;
      maybeAutoStart();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.videoUrl]);

  // Cancel extraction when the player closes
  useEffect(() => () => {
    genRef.current++;
    for (const s of storesRef.current.values()) cancelSession(s);
  }, []);

  // Keep the main process informed about the playhead (seek-aware streaming fallback)
  useEffect(() => {
    const id = setInterval(() => reportPlayhead(activeRef.current, paramsRef.current.getMediaTimeMs()), 1000);
    return () => clearInterval(id);
  }, []);

  /** Called by the player once ffprobe analysis of `url` finishes (or fails with null). */
  const provideEmbeddedTracks = useCallback((url: string, analysis: MediaTracksResult | null) => {
    if (url !== paramsRef.current.videoUrl) return;
    embeddedRef.current = { analysis, provided: true };
    const embedded: SubtitleOption[] = (analysis?.subtitleTracks || []).map(st => ({
      id: st.id,
      label: st.label,
      language: st.language,
      codec: st.codec,
      codecName: st.codecName,
      isExternal: false,
      isEmbedded: true,
      trackNumber: st.trackNumber,
      streamIndex: st.streamIndex,
      format: st.format,
      isBitmap: st.isBitmap,
      isDefault: st.isDefault,
      isForced: st.isForced,
      isHearingImpaired: st.isHearingImpaired,
      isCommentary: st.isCommentary,
      title: st.title
    }));
    mergeOptions(null, embedded);
    maybeAutoStart();
  }, [mergeOptions, maybeAutoStart]);

  const select = useCallback((id: string | null) => {
    if (id === null) {
      const prev = activeRef.current;
      if (prev && isSessionActive(prev)) {
        cancelSession(prev);
        storesRef.current.delete(prev.optionId);
      }
      autoQueueRef.current = null;
      activeRef.current = null;
      setStore(null);
      setSelectedId(null);
      paramsRef.current.showHud('Subtitles: Off');
      return;
    }
    const opt = optionsRef.current.find(o => o.id === id);
    if (!opt) return;
    activate(opt, 'user');
    paramsRef.current.showHud(`Subtitles: ${opt.label}`);
  }, [activate]);

  const loadLocalFile = useCallback(async () => {
    if (!window.electronAPI?.pickLocalSubtitle) return;
    const file = await window.electronAPI.pickLocalSubtitle();
    if (!file) return;
    const id = `local-${Date.now()}`;
    const s = new SubtitleTrackStore(id);
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes as any);
    const companion = file.companion
      ? { fileName: file.companion.fileName, bytes: file.companion.bytes instanceof Uint8Array ? file.companion.bytes : new Uint8Array(file.companion.bytes as any) }
      : undefined;
    loadSubtitleBytes(s, file.fileName, bytes, companion, paramsRef.current.preferredLanguage);
    if (s.status !== 'ready') {
      paramsRef.current.showHud(s.error || `Could not read ${file.fileName}`);
      return;
    }
    const opt: SubtitleOption = {
      id,
      label: `${file.fileName} (${s.itemCount} ${s.kind === 'text' ? 'cues' : 'images'})`,
      isExternal: true,
      isLocal: true,
      format: file.extension,
      isBitmap: s.kind !== 'text'
    };
    storesRef.current.set(id, s);
    updateOptions([opt, ...optionsRef.current]);
    activate(opt, 'user');
    paramsRef.current.showHud(`Loaded ${file.fileName}`);
  }, [activate, updateOptions]);

  const notifySeek = useCallback(() => {
    reportPlayhead(activeRef.current, paramsRef.current.getMediaTimeMs());
  }, []);

  let status: SubtitleUiStatus;
  if (!store) {
    status = { state: 'off', message: null, itemCount: 0, detail: null };
  } else {
    const count = store.itemCount;
    const unit = store.kind === 'text' ? 'lines' : 'images';
    let detail: string | null = null;
    if (store.progress?.total) detail = `${Math.min(store.progress.loaded || 0, store.progress.total)}/${store.progress.total} fetched`;
    else if (store.progress?.coveredUntilMs !== undefined) detail = `scanned up to ${fmtTime(store.progress.coveredUntilMs)}`;
    if (store.status === 'loading') {
      status = { state: 'loading', message: count > 0 ? `Loading subtitles… ${count} ${unit} so far` : 'Loading subtitles…', itemCount: count, detail };
    } else if (store.status === 'ready') {
      status = { state: 'ready', message: `${count} ${unit}${store.completedInMs !== null ? ` loaded in ${(store.completedInMs / 1000).toFixed(1)}s` : ''}`, itemCount: count, detail: store.method };
    } else {
      status = { state: store.status, message: store.error, itemCount: count, detail: null };
    }
  }

  return {
    options,
    selectedId,
    store,
    status,
    delayMs,
    setDelayMs,
    select,
    loadLocalFile,
    provideEmbeddedTracks,
    notifySeek
  };
}
