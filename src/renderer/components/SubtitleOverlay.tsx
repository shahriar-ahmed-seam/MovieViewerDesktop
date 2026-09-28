import React, { useEffect, useRef, useState } from 'react';
import type { SubtitleCue, BitmapSubtitlePacket } from '../../shared/subtitles/types';
import type { DecodedComposition } from '../../shared/subtitles/pgs';
import { SubtitleTrackStore } from '../subtitles/SubtitleTrackStore';

interface SubtitleOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  store: SubtitleTrackStore | null;
  /** Absolute media time in ms (includes the remux offset when audio is being remuxed). */
  getMediaTimeMs: () => number;
  /** Positive values show subtitles later. */
  subtitleDelayMs: number;
  controlsVisible: boolean;
  scalingMode: 'contain' | 'cover' | 'fill' | 'none';
  /** Text size multiplier from settings. */
  fontScale?: number;
  testMessage?: string | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Height reserved for the bottom control bar while it is visible. */
const CONTROL_BAR_PX = 118;
const TOP_BAR_PX = 64;

/** The rectangle the video picture occupies inside the container, honouring object-fit. */
function videoRect(video: HTMLVideoElement | null, cw: number, ch: number, mode: SubtitleOverlayProps['scalingMode']): Rect {
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  if (!vw || !vh || mode === 'fill') return { x: 0, y: 0, w: cw, h: ch };
  let scale: number;
  if (mode === 'contain') scale = Math.min(cw / vw, ch / vh);
  else if (mode === 'cover') scale = Math.max(cw / vw, ch / vh);
  else scale = 1;
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function intersect(a: Rect, cw: number, ch: number): Rect {
  const x = Math.max(0, a.x);
  const y = Math.max(0, a.y);
  const r = Math.min(cw, a.x + a.w);
  const b = Math.min(ch, a.y + a.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, b - y) };
}

/**
 * Where the subtitle frame (PGS: the 1920x1080 Blu-ray canvas, VobSub: the DVD frame) lands on screen.
 * When a release crops the black bars away, the frame is larger than the picture; it is centred on
 * the picture like a disc player would, so bottom-bar subtitles fall into the letterbox area.
 */
function subtitleFrameRect(kind: string, comp: DecodedComposition, vr: Rect): Rect {
  const fw = comp.frameWidth || vr.w;
  const fh = comp.frameHeight || vr.h;
  const videoAspect = vr.w / Math.max(1, vr.h);
  let frameAspect = fw / fh;
  if (kind === 'vobsub' && fw <= 720) {
    // DVD frames are anamorphic: 720x480/576 displays as 4:3 or 16:9
    frameAspect = videoAspect > 1.5 ? 16 / 9 : 4 / 3;
  }
  if (Math.abs(videoAspect / frameAspect - 1) < 0.03) return vr;
  if (videoAspect > frameAspect) {
    // Picture is wider than the frame (bars cropped top/bottom)
    const h = vr.w / frameAspect;
    return { x: vr.x, y: vr.y + (vr.h - h) / 2, w: vr.w, h };
  }
  const w = vr.h * frameAspect;
  return { x: vr.x + (vr.w - w) / 2, y: vr.y, w, h: vr.h };
}

const bitmapCanvasCache = new WeakMap<DecodedComposition, HTMLCanvasElement[]>();

function compositionCanvases(comp: DecodedComposition): HTMLCanvasElement[] {
  let list = bitmapCanvasCache.get(comp);
  if (!list) {
    list = comp.bitmaps.map((b) => {
      const c = document.createElement('canvas');
      c.width = b.width;
      c.height = b.height;
      const ctx = c.getContext('2d');
      if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(b.rgba), b.width, b.height), 0, 0);
      return c;
    });
    bitmapCanvasCache.set(comp, list);
  }
  return list;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  videoRef,
  containerRef,
  store,
  getMediaTimeMs,
  subtitleDelayMs,
  controlsVisible,
  scalingMode,
  fontScale = 1,
  testMessage
}) => {
  const [activeCues, setActiveCues] = useState<SubtitleCue[]>([]);
  const [layout, setLayout] = useState({ cw: 0, ch: 0, vr: { x: 0, y: 0, w: 0, h: 0 } as Rect });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const lastKeyRef = useRef('');
  const lastPacketRef = useRef<BitmapSubtitlePacket | null>(null);
  const lastDrawKeyRef = useRef('');
  const propsRef = useRef({ getMediaTimeMs, subtitleDelayMs, controlsVisible, scalingMode });
  propsRef.current = { getMediaTimeMs, subtitleDelayMs, controlsVisible, scalingMode };

  // Track container size and the video's picture rectangle
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const vr = videoRect(videoRef.current, cw, ch, propsRef.current.scalingMode);
      setLayout(prev =>
        prev.cw === cw && prev.ch === ch && Math.abs(prev.vr.w - vr.w) < 0.5 && Math.abs(prev.vr.h - vr.h) < 0.5 && Math.abs(prev.vr.x - vr.x) < 0.5 && Math.abs(prev.vr.y - vr.y) < 0.5
          ? prev
          : { cw, ch, vr }
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    const v = videoRef.current;
    v?.addEventListener('loadedmetadata', measure);
    v?.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      v?.removeEventListener('loadedmetadata', measure);
      v?.removeEventListener('resize', measure);
    };
  }, [containerRef, videoRef, scalingMode]);

  // Frame loop: find what should be visible now; touch React/canvas only when it changes
  useEffect(() => {
    lastKeyRef.current = '';
    lastPacketRef.current = null;
    lastDrawKeyRef.current = '';
    setActiveCues([]);
    if (!store) return;
    let raf = 0;
    const tick = () => {
      const { getMediaTimeMs: getT, subtitleDelayMs: delay } = propsRef.current;
      const t = getT() - delay;
      if (store.kind === 'text') {
        const cues = store.activeCues(t);
        const key = cues.map(c => c.id).join('|');
        if (key !== lastKeyRef.current) {
          lastKeyRef.current = key;
          setActiveCues(cues);
        }
      } else {
        const p = store.activeBitmap(t);
        if (p !== lastPacketRef.current) {
          lastPacketRef.current = p;
          lastDrawKeyRef.current = ''; // force redraw
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // Bitmap drawing (runs from its own rAF so layout / controls changes redraw too)
  useEffect(() => {
    const clear = () => {
      const c = canvasRef.current;
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    };
    clear();
    if (!store) return;
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      // The track kind is only known once the header arrives, so check it every frame
      if (canvas && store.kind !== 'text') {
        const dpr = window.devicePixelRatio || 1;
        const { cw, ch, vr } = layout;
        const packet = lastPacketRef.current;
        const key = `${packet ? `${packet.startMs}:${packet.data.length}` : 'none'}|${cw}x${ch}|${vr.x},${vr.y},${vr.w},${vr.h}|${propsRef.current.controlsVisible}|${dpr}`;
        if (key !== lastDrawKeyRef.current) {
          lastDrawKeyRef.current = key;
          const pw = Math.round(cw * dpr);
          const ph = Math.round(ch * dpr);
          if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
          }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, pw, ph);
            const comp = packet ? store.decode(packet) : null;
            if (comp && vr.w > 0 && vr.h > 0) {
              const fr = subtitleFrameRect(store.kind, comp, vr);
              const sx = fr.w / comp.frameWidth;
              const sy = fr.h / comp.frameHeight;
              const canvases = compositionCanvases(comp);
              // Lift bottom subtitles above the control bar while it is shown
              let lift = 0;
              if (propsRef.current.controlsVisible) {
                let lowest = 0;
                comp.bitmaps.forEach((b) => {
                  const top = fr.y + b.y * sy;
                  if (top > ch / 2) lowest = Math.max(lowest, top + b.height * sy);
                });
                if (lowest > ch - CONTROL_BAR_PX) lift = lowest - (ch - CONTROL_BAR_PX);
              }
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              comp.bitmaps.forEach((b, i) => {
                let x = fr.x + b.x * sx;
                let y = fr.y + b.y * sy;
                const w = b.width * sx;
                const h = b.height * sy;
                if (y > ch / 2) y -= lift;
                // Keep everything inside the visible container
                x = Math.min(Math.max(0, x), Math.max(0, cw - w));
                y = Math.min(Math.max(0, y), Math.max(0, ch - h));
                ctx.drawImage(canvases[i], x * dpr, y * dpr, w * dpr, h * dpr);
              });
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [store, layout]);

  const visible = intersect(layout.vr, layout.cw, layout.ch);
  const baseHeight = visible.h > 0 ? visible.h : layout.ch;
  const fontPx = Math.round(Math.min(72, Math.max(15, baseHeight * 0.047)) * fontScale);
  const margin = Math.max(12, baseHeight * 0.05);
  const bottomInset = Math.max(layout.ch - (visible.y + visible.h) + margin, controlsVisible ? CONTROL_BAR_PX : 0);
  const topInset = Math.max(visible.y + margin, controlsVisible ? TOP_BAR_PX + 8 : 0);

  const textStyle: React.CSSProperties = {
    color: '#FFFFFF',
    fontSize: `${fontPx}px`,
    lineHeight: 1.28,
    fontWeight: 600,
    fontFamily: '"Inter", "Noto Sans", "Noto Sans Bengali", "Noto Sans CJK KR", "Noto Sans CJK SC", "Segoe UI", Roboto, Arial, sans-serif',
    textAlign: 'center',
    whiteSpace: 'pre-line',
    textShadow: '0 0 4px rgba(0,0,0,0.95), 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000',
    background: 'rgba(0, 0, 0, 0.42)',
    borderRadius: '6px',
    padding: '0.08em 0.45em',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    unicodeBidi: 'plaintext',
    maxWidth: '100%'
  };

  const groups: Record<'top' | 'middle' | 'bottom', SubtitleCue[]> = { top: [], middle: [], bottom: [] };
  for (const c of activeCues) groups[c.align || 'bottom'].push(c);

  const lane = (cues: SubtitleCue[], pos: 'top' | 'middle' | 'bottom') => {
    if (cues.length === 0) return null;
    const style: React.CSSProperties = {
      position: 'absolute',
      left: Math.max(0, visible.x) + visible.w * 0.06,
      width: (visible.w || layout.cw) * 0.88,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: `${Math.round(fontPx * 0.2)}px`,
      transition: 'bottom 0.15s ease-out, top 0.15s ease-out'
    };
    if (pos === 'bottom') style.bottom = bottomInset;
    else if (pos === 'top') style.top = topInset;
    else {
      style.top = visible.y + visible.h / 2;
      style.transform = 'translateY(-50%)';
    }
    return (
      <div style={style} data-subtitle-lane={pos}>
        {cues.map(c => (
          <span key={c.id} dir="auto" style={textStyle}>{c.text}</span>
        ))}
      </div>
    );
  };

  return (
    <div
      className="subtitle-overlay"
      aria-live="polite"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1200, overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
      />
      {testMessage ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: bottomInset, display: 'flex', justifyContent: 'center' }}>
          <span style={textStyle}>{testMessage}</span>
        </div>
      ) : (
        <>
          {lane(groups.top, 'top')}
          {lane(groups.middle, 'middle')}
          {lane(groups.bottom, 'bottom')}
        </>
      )}
    </div>
  );
};
