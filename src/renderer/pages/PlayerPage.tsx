import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { MediaFile, DirectoryContext, formatTimeMs } from '../types/media';
import { EpisodeDrawer } from '../components/EpisodeDrawer';
import { TrackSelectorModal, AudioOption } from '../components/TrackSelector';
import { SubtitleOverlay } from '../components/SubtitleOverlay';
import { SubtitleDebugHud } from '../components/SubtitleDebugHud';
import { PlaybackDiagnosticsPanel, sanitizeDisplayUrl } from '../components/PlaybackDiagnosticsPanel';
import {
  MediaInspectionResult, MediaTracksResult, PlaybackDiagnosticsState, SubtitlePipelineStage,
  SubtitlePipelineDiagnostics, BinaryDiagnostics
} from '../../shared/types';
import { useSubtitles } from '../subtitles/useSubtitles';

interface PlayerPageProps {
  mediaUrl: string;
  mediaTitle: string;
  directoryContext: DirectoryContext;
  onNavigateBack: () => void;
}

type VideoScaling = 'contain' | 'cover' | 'fill' | 'none';

export const PlayerPage: React.FC<PlayerPageProps> = ({
  mediaUrl: initialUrl,
  mediaTitle: initialTitle,
  directoryContext,
  onNavigateBack
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressScrubberRef = useRef<HTMLDivElement>(null);

  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [currentTitle, setCurrentTitle] = useState(initialTitle);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [scalingMode, setScalingMode] = useState<VideoScaling>('contain');
  const [isMaximized, setIsMaximized] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<'playing' | 'paused' | 'seeking' | 'buffering' | 'ended'>('paused');

  // Audio tracks
  const [audioOptions, setAudioOptions] = useState<AudioOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [audioBoost, setAudioBoost] = useState(1.0);
  const [audioSwitching, setAudioSwitching] = useState<boolean>(false);
  const [audioSwitchError, setAudioSwitchError] = useState<string | null>(null);

  // UI overlays
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isTrackModalOpen, setIsTrackModalOpen] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showScalingMenu, setShowScalingMenu] = useState(false);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [resumePositionMs, setResumePositionMs] = useState(0);
  const [hudMessage, setHudMessage] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  // Diagnostics (developer mode only)
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [developerDiagnosticsEnabled, setDeveloperDiagnosticsEnabled] = useState(false);
  const [inspectionResult, setInspectionResult] = useState<MediaInspectionResult | null>(null);
  const [diagnosticsData, setDiagnosticsData] = useState<any>(null);
  const [lastActionMessage, setLastActionMessage] = useState<string>('Player initialized');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [binaryDiagnostics, setBinaryDiagnostics] = useState<BinaryDiagnostics | null>(null);
  const [subtitlePrefs, setSubtitlePrefs] = useState({ language: 'eng', autoEnable: true, scale: 1 });
  const testTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Lifecycle & Cancellation Tracking
  const isMountedRef = useRef<boolean>(true);
  const loadGenerationRef = useRef<number>(0);
  const audioGenerationRef = useRef<number>(0);

  const autoHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hudTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resumeTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Audio Stream Remuxing & Tracking Refs
  const remuxOffsetRef = useRef<number>(0);
  const totalDurationRef = useRef<number>(0);
  const audioSessionIdRef = useRef<string>('default');
  const defaultAudioStreamIndexRef = useRef<number | null>(null);

  // Audio Context for Boost
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioSourceConnectedRef = useRef<boolean>(false);

  /** Absolute media position in ms. While audio is remuxed the <video> clock starts at remuxOffset. */
  const getMediaTimeMs = useCallback(() => {
    const v = videoRef.current;
    return Math.round((remuxOffsetRef.current + (v ? v.currentTime : 0)) * 1000);
  }, []);

  // Subtitle engine: sidecar discovery, embedded extraction sessions, auto-selection, local files
  const subtitles = useSubtitles({
    videoUrl: currentUrl,
    videoTitle: currentTitle,
    directoryContext,
    getMediaTimeMs,
    durationSec: duration,
    preferredLanguage: subtitlePrefs.language,
    autoEnable: subtitlePrefs.autoEnable,
    showHud: (msg: string) => showHud(msg)
  });

  const triggerSubtitleTest = () => {
    setTestMessage('Subtitle overlay test: this line should be clearly readable');
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = setTimeout(() => {
      setTestMessage(null);
    }, 5000);
  };

  // Component lifecycle: mount & unmount safety
  useEffect(() => {
    isMountedRef.current = true;
    window.electronAPI?.isMaximized?.().then((max) => {
      if (isMountedRef.current) setIsMaximized(max);
    }).catch(() => {});

    window.electronAPI?.getSettings?.().then((settings) => {
      if (!isMountedRef.current || !settings) return;
      if (settings.developerDiagnostics) setDeveloperDiagnosticsEnabled(true);
      setSubtitlePrefs({
        language: settings.preferredSubtitleLanguage || 'eng',
        autoEnable: settings.subtitlesEnabledByDefault !== false,
        scale: settings.subtitleScale && settings.subtitleScale > 0 ? settings.subtitleScale : 1
      });
    }).catch(() => {});

    window.electronAPI?.getBinaryDiagnostics?.().then((diag) => {
      if (isMountedRef.current) setBinaryDiagnostics(diag);
    }).catch((err) => console.warn('Failed to fetch binary diagnostics:', err));

    return () => {
      isMountedRef.current = false;
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      if (gainNodeRef.current) {
        try {
          gainNodeRef.current.disconnect();
        } catch {}
        gainNodeRef.current = null;
      }
      if (audioSessionIdRef.current) {
        window.electronAPI?.cancelAudioRemux?.(audioSessionIdRef.current);
      }
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
    };
  }, []);

  // Web Audio gain node setup (Single source connection guard)
  const initAudioContextIfNeeded = useCallback(() => {
    if (audioCtxRef.current || !videoRef.current) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      const ctx = new AudioContextClass();
      const gain = ctx.createGain();
      gain.gain.value = audioBoost;

      if (!audioSourceConnectedRef.current && videoRef.current) {
        const source = ctx.createMediaElementSource(videoRef.current);
        source.connect(gain);
        gain.connect(ctx.destination);
        audioSourceConnectedRef.current = true;
      }

      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
    } catch (err) {
      console.warn('AudioContext setup error (non-fatal):', err);
    }
  }, [audioBoost]);

  useEffect(() => {
    if (gainNodeRef.current && Number.isFinite(audioBoost)) {
      try {
        gainNodeRef.current.gain.value = audioBoost;
      } catch {}
    }
  }, [audioBoost]);

  // Probe streams (audio + embedded subtitles) whenever currentUrl or directoryContext changes
  useEffect(() => {
    // Synchronously reset previous video state to avoid leaking into new video
    setShowResumePrompt(false);
    setResumePositionMs(0);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    setVideoError(null);
    setAudioSwitching(false);
    setAudioSwitchError(null);
    remuxOffsetRef.current = 0;
    totalDurationRef.current = 0;

    loadTracks(currentUrl);
    checkSavedProgress(currentUrl);
  }, [currentUrl, directoryContext]);

  const loadTracks = async (url: string) => {
    const currentToken = ++loadGenerationRef.current;
    setLastActionMessage(`Probing streams for generation #${currentToken}...`);

    const auds: AudioOption[] = [];
    let analysis: MediaTracksResult | null = null;

    // ffprobe container inspection: audio tracks + embedded subtitle streams
    if (window.electronAPI?.analyzeMediaTracks) {
      try {
        analysis = await window.electronAPI.analyzeMediaTracks(url);
        if (!isMountedRef.current || currentToken !== loadGenerationRef.current) {
          return;
        }

        const inspection = (analysis.inspection || null) as MediaInspectionResult | null;
        setInspectionResult(inspection);
        setDiagnosticsData(analysis.inspection || analysis);

        if (analysis.duration && totalDurationRef.current === 0) {
          setDuration(analysis.duration);
          totalDurationRef.current = analysis.duration;
        }

        if (analysis.audioTracks && analysis.audioTracks.length > 0) {
          for (const at of analysis.audioTracks) {
            auds.push({
              id: at.id,
              label: at.label,
              language: at.language,
              codec: at.codec,
              channels: at.channels,
              trackNumber: at.trackNumber,
              streamIndex: at.streamIndex,
              isDefault: at.isDefault,
              title: at.title
            });
          }

          const defTrack = analysis.audioTracks.find(a => a.isDefault) || analysis.audioTracks[0];
          defaultAudioStreamIndexRef.current = defTrack ? defTrack.streamIndex : (analysis.audioTracks[0]?.streamIndex ?? 1);
        }
        setLastActionMessage(`Streams discovered: ${auds.length} audio, ${analysis.subtitleTracks?.length || 0} embedded subtitle tracks`);
      } catch (e: any) {
        if (!isMountedRef.current || currentToken !== loadGenerationRef.current) return;
        console.warn('Error analyzing media streams:', e);
        setLastActionMessage(`Media stream analysis failed: ${e?.message || 'Unknown error'}`);
        analysis = null;
      }
    }

    if (!isMountedRef.current || currentToken !== loadGenerationRef.current) return;

    // Embedded subtitle tracks go to the subtitle engine (which also merges sidecar files)
    subtitles.provideEmbeddedTracks(url, analysis);

    // Fallback for browser HTML5 video audio tracks if ffprobe returned none
    if (videoRef.current) {
      const v = videoRef.current as any;
      if (v.audioTracks && v.audioTracks.length > 0 && auds.length === 0) {
        for (let i = 0; i < v.audioTracks.length; i++) {
          const a = v.audioTracks[i];
          auds.push({
            id: `audio-${i}`,
            streamIndex: i + 1,
            label: a.label || `Audio Stream #${i + 1} (${a.language || 'Main'})`,
            language: a.language
          });
        }
      }
    }

    setAudioOptions(auds);
    if (auds.length > 0) {
      const def = auds.find(a => a.isDefault) || auds[0];
      setSelectedAudioId(def.id);
    }
  };

  const handleSubtitleDelayChange = (newDelayMs: number) => {
    const clamped = Math.max(-60000, Math.min(60000, Math.round(newDelayMs)));
    subtitles.setDelayMs(clamped);
    const delaySec = (clamped / 1000).toFixed(1);
    showHud(`Sub Delay: ${clamped > 0 ? '+' : ''}${delaySec}s`);
  };

  const handleSelectAudio = async (audId: string, targetSeekTime?: number) => {
    const token = ++audioGenerationRef.current;
    const target = audioOptions.find(a => a.id === audId);
    if (!target) return;

    const v = videoRef.current;
    const effectiveCurrentTime = targetSeekTime !== undefined
      ? targetSeekTime
      : (remuxOffsetRef.current + (v ? v.currentTime : 0));
    const wasPlaying = isPlaying;
    const savedRate = playbackSpeed;
    const savedVolume = volume;
    const savedMuted = isMuted;

    // Check if selecting default track and not seeking within remux
    const isDefaultTrack = target.isDefault || target.streamIndex === defaultAudioStreamIndexRef.current;

    if (isDefaultTrack && targetSeekTime === undefined && remuxOffsetRef.current === 0) {
      setSelectedAudioId(audId);
      showHud(`Audio: ${target.label}`);
      setLastActionMessage(`Active audio: ${target.label} (direct stream #${target.streamIndex})`);
      return;
    }

    if (isDefaultTrack && targetSeekTime === undefined) {
      // Switching back to direct playback from remux
      setSelectedAudioId(audId);
      remuxOffsetRef.current = 0;
      setAudioSwitching(true);
      setAudioSwitchError(null);
      setLastActionMessage(`Switching audio back to primary stream #${target.streamIndex}...`);

      if (audioSessionIdRef.current) {
        window.electronAPI?.cancelAudioRemux?.(audioSessionIdRef.current);
      }

      if (v) {
        v.src = currentUrl;
        const onReady = () => {
          v.removeEventListener('loadeddata', onReady);
          if (!isMountedRef.current || token !== audioGenerationRef.current) return;
          try {
            v.currentTime = effectiveCurrentTime;
            v.playbackRate = savedRate;
            v.volume = savedVolume;
            v.muted = savedMuted;
            if (wasPlaying) {
              v.play().catch(() => {
                if (isMountedRef.current) setIsPlaying(false);
              });
            }
          } catch {}
          setAudioSwitching(false);
          setLastActionMessage(`Switched back to native audio #${target.streamIndex}`);
        };
        v.addEventListener('loadeddata', onReady);
        v.load();
      } else {
        setAudioSwitching(false);
      }
      showHud(`Audio: ${target.label}`);
      return;
    }

    // Secondary / non-default audio track or remux seek: use RemuxStreamer
    setSelectedAudioId(audId);
    setAudioSwitching(true);
    setAudioSwitchError(null);

    // Cancel prior session before launching new one
    if (audioSessionIdRef.current) {
      window.electronAPI?.cancelAudioRemux?.(audioSessionIdRef.current);
    }

    const newSessionId = `remux-${Date.now()}`;
    audioSessionIdRef.current = newSessionId;
    setLastActionMessage(`Starting audio remux session for stream #${target.streamIndex} at ${effectiveCurrentTime.toFixed(1)}s...`);

    try {
      const res = await window.electronAPI.prepareAudioRemux({
        videoUrl: currentUrl,
        audioStreamIndex: target.streamIndex,
        startTime: effectiveCurrentTime,
        sessionId: newSessionId
      });

      if (!isMountedRef.current || token !== audioGenerationRef.current || audioSessionIdRef.current !== newSessionId) {
        setLastActionMessage(`Discarded audio remux result for session ${newSessionId} (superseded)`);
        return; // Cancelled by newer request
      }

      if (!res.success || !res.streamUrl) {
        const errMsg = res.error || 'Failed to switch audio stream';
        setAudioSwitchError(errMsg);
        setAudioSwitching(false);
        setLastActionMessage(`Audio remux failed: ${errMsg}`);
        showHud('Audio switch failed');
        return;
      }

      // The remuxer starts on the keyframe at/before the request; that is where its clock's 0 is
      remuxOffsetRef.current = typeof res.startTime === 'number' && Number.isFinite(res.startTime)
        ? res.startTime
        : effectiveCurrentTime;

      if (v) {
        v.src = res.streamUrl;
        const onLoaded = () => {
          v.removeEventListener('loadeddata', onLoaded);
          if (!isMountedRef.current || token !== audioGenerationRef.current) return;
          try {
            v.playbackRate = savedRate;
            v.volume = savedVolume;
            v.muted = savedMuted;
            if (wasPlaying) {
              v.play().catch(() => {
                if (isMountedRef.current) setIsPlaying(false);
              });
            }
          } catch {}
          setAudioSwitching(false);
          setLastActionMessage(`Active audio stream #${target.streamIndex} via live remux`);
        };
        v.addEventListener('loadeddata', onLoaded);
        v.load();
      } else {
        setAudioSwitching(false);
      }
      showHud(`Audio: ${target.label}`);
    } catch (err: any) {
      if (!isMountedRef.current || token !== audioGenerationRef.current) return;
      if (audioSessionIdRef.current === newSessionId) {
        const msg = err?.message || 'Error preparing audio stream';
        setAudioSwitchError(msg);
        setAudioSwitching(false);
        setLastActionMessage(`Audio remux exception: ${msg}`);
      }
    }
  };

  const checkSavedProgress = async (url: string) => {
    const currentToken = loadGenerationRef.current;
    if (!window.electronAPI) return;
    try {
      const saved = await window.electronAPI.getPosition(url);
      if (!isMountedRef.current || currentToken !== loadGenerationRef.current) {
        // Discard stale progress result belonging to previous video
        return;
      }
      if (saved && saved.positionMs > 10000 && !saved.completed) {
        setResumePositionMs(saved.positionMs);
        setShowResumePrompt(true);
        if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = setTimeout(() => {
          if (isMountedRef.current && currentToken === loadGenerationRef.current) {
            setShowResumePrompt(false);
          }
        }, 8000);
      }
    } catch (e) {
      console.error('Error checking saved progress:', e);
    }
  };

  const showHud = (msg: string) => {
    setHudMessage(msg);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setHudMessage(null);
    }, 1000);
  };

  // Snappy Auto-Hide Timer (900ms delay for desktop player responsiveness)
  const resetAutoHide = useCallback(() => {
    setControlsVisible(true);
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      if (isPlaying && !isDrawerOpen && !showSpeedMenu && !showScalingMenu && !isTrackModalOpen && !isScrubbing && !isDiagnosticsOpen) {
        setControlsVisible(false);
      }
    }, 900);
  }, [isPlaying, isDrawerOpen, showSpeedMenu, showScalingMenu, isTrackModalOpen, isScrubbing, isDiagnosticsOpen]);

  // Periodic progress saving
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isMountedRef.current || !videoRef.current || duration <= 0 || currentTime <= 0) return;
      const effectivePos = remuxOffsetRef.current + videoRef.current.currentTime;
      const posMs = Math.floor(effectivePos * 1000);
      const durMs = Math.floor(duration * 1000);
      window.electronAPI?.savePosition?.({
        videoUrl: currentUrl,
        title: currentTitle,
        directoryUrl: directoryContext.directoryUrl,
        positionMs: posMs,
        durationMs: durMs,
        lastPlayedTimestamp: Date.now(),
        completed: posMs >= durMs * 0.95
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [currentUrl, currentTitle, duration, currentTime, directoryContext.directoryUrl]);

  // Play / Pause toggle with AudioContext & rejection safety
  const togglePlay = () => {
    if (!videoRef.current) return;
    initAudioContextIfNeeded();
    if (videoRef.current.paused) {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      videoRef.current.play().then(() => {
        if (isMountedRef.current) setIsPlaying(true);
      }).catch((err) => {
        console.warn('Playback play() rejected:', err);
        if (isMountedRef.current) setIsPlaying(false);
      });
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    resetAutoHide();
  };

  // Safe seek handler (bounds-guarded, remux-aware)
  const seekRelative = (seconds: number) => {
    if (!videoRef.current) return;
    const effectiveTime = remuxOffsetRef.current + videoRef.current.currentTime;
    const effectiveDur = Number.isFinite(duration) && duration > 0 ? duration : (remuxOffsetRef.current + (videoRef.current.duration || 0));
    const target = Math.max(0, Math.min(effectiveDur, effectiveTime + seconds));

    const isRemuxActive = remuxOffsetRef.current > 0 || (selectedAudioId && audioOptions.find(a => a.id === selectedAudioId)?.streamIndex !== defaultAudioStreamIndexRef.current);
    if (isRemuxActive && selectedAudioId) {
      handleSelectAudio(selectedAudioId, target);
    } else {
      try {
        videoRef.current.currentTime = target;
        setCurrentTime(target);
      } catch (e) {
        console.warn('Seek failed:', e);
      }
    }
    showHud(`${seconds > 0 ? '+' : ''}${seconds}s`);
    resetAutoHide();
  };

  const handleScrubberSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressScrubberRef.current || !videoRef.current) return;
    const rect = progressScrubberRef.current.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const effectiveDur = Number.isFinite(duration) && duration > 0 ? duration : (remuxOffsetRef.current + (videoRef.current.duration || 0));

    if (Number.isFinite(effectiveDur) && effectiveDur > 0) {
      const target = fraction * effectiveDur;
      const isRemuxActive = remuxOffsetRef.current > 0 || (selectedAudioId && audioOptions.find(a => a.id === selectedAudioId)?.streamIndex !== defaultAudioStreamIndexRef.current);
      if (isRemuxActive && selectedAudioId) {
        handleSelectAudio(selectedAudioId, target);
      } else {
        try {
          videoRef.current.currentTime = target;
          setCurrentTime(target);
        } catch (e) {
          console.warn('Scrubber seek failed:', e);
        }
      }
    }
  };

  // Next / Prev episode
  const handleNextEpisode = () => {
    const idx = directoryContext.videoFiles.findIndex((f) => f.fullUrl === currentUrl);
    if (idx >= 0 && idx + 1 < directoryContext.videoFiles.length) {
      const next = directoryContext.videoFiles[idx + 1];
      switchEpisode(next);
    }
  };

  const handlePrevEpisode = () => {
    const idx = directoryContext.videoFiles.findIndex((f) => f.fullUrl === currentUrl);
    if (idx > 0) {
      const prev = directoryContext.videoFiles[idx - 1];
      switchEpisode(prev);
    }
  };

  const switchEpisode = (file: MediaFile) => {
    // 1. Cancel previous audio remux session
    if (audioSessionIdRef.current) {
      window.electronAPI?.cancelAudioRemux?.(audioSessionIdRef.current);
    }
    // 2. Invalidate generation tokens immediately (subtitle sessions reset when currentUrl changes)
    loadGenerationRef.current++;
    audioGenerationRef.current++;

    // 4. Save position of previous video before switching if playing/paused
    if (videoRef.current && duration > 0 && currentTime > 0) {
      window.electronAPI?.savePosition?.({
        videoUrl: currentUrl,
        title: currentTitle,
        directoryUrl: directoryContext.directoryUrl,
        positionMs: Math.floor((remuxOffsetRef.current + videoRef.current.currentTime) * 1000),
        durationMs: Math.floor(duration * 1000),
        lastPlayedTimestamp: Date.now(),
        completed: false
      });
    }

    // 5. Synchronously clear previous video state to avoid leaking into new video
    remuxOffsetRef.current = 0;
    totalDurationRef.current = 0;
    setCurrentTime(0);
    setDuration(0);
    setBufferedTime(0);
    setVideoError(null);
    setAudioSwitching(false);
    setAudioSwitchError(null);
    setShowResumePrompt(false);
    setResumePositionMs(0);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    setAudioOptions([]);
    setSelectedAudioId(null);
    setLastActionMessage(`Switched episode to ${file.cleanDisplayName}`);

    setCurrentUrl(file.fullUrl);
    setCurrentTitle(file.cleanDisplayName);
    resetAutoHide();
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    resetAutoHide();
  };

  // Window Controls
  const handleMinimize = () => window.electronAPI?.minimizeWindow?.();
  const handleMaximize = () => {
    window.electronAPI?.maximizeWindow?.();
    setIsMaximized(!isMaximized);
  };
  const handleClose = () => window.electronAPI?.closeWindow?.();

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;

      if ((e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) ||
          (developerDiagnosticsEnabled && (e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.altKey && !e.metaKey)) {
        e.preventDefault();
        setIsDiagnosticsOpen((prev) => !prev);
        return;
      }

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          seekRelative(-10);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          seekRelative(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (videoRef.current) {
            const nextVol = Math.min(1, videoRef.current.volume + 0.05);
            videoRef.current.volume = nextVol;
            setVolume(nextVol);
            showHud(`Volume: ${Math.round(nextVol * 100)}%`);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (videoRef.current) {
            const nextVol = Math.max(0, videoRef.current.volume - 0.05);
            videoRef.current.volume = nextVol;
            setVolume(nextVol);
            showHud(`Volume: ${Math.round(nextVol * 100)}%`);
          }
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.muted = !videoRef.current.muted;
            setIsMuted(videoRef.current.muted);
            showHud(videoRef.current.muted ? 'Muted' : 'Unmuted');
          }
          break;
        case 's':
        case 'S':
        case 'c':
        case 'C':
          e.preventDefault();
          setIsTrackModalOpen((prev) => !prev);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          handleNextEpisode();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          handlePrevEpisode();
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          setIsDrawerOpen((prev) => !prev);
          break;
        case 'Escape':
          if (isDiagnosticsOpen) {
            setIsDiagnosticsOpen(false);
          } else if (isTrackModalOpen) {
            setIsTrackModalOpen(false);
          } else if (isDrawerOpen) {
            setIsDrawerOpen(false);
          } else if (!document.fullscreenElement) {
            onNavigateBack();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekRelative, isDrawerOpen, isTrackModalOpen, isDiagnosticsOpen, developerDiagnosticsEnabled, onNavigateBack]);

  const currentIdx = directoryContext.videoFiles.findIndex((f) => f.fullUrl === currentUrl);
  const hasNext = currentIdx >= 0 && currentIdx + 1 < directoryContext.videoFiles.length;
  const hasPrev = currentIdx > 0;

  const displayProgress = Number.isFinite(duration) && duration > 0 ? (currentTime / duration) * 100 : 0;
  const displayBuffered = Number.isFinite(duration) && duration > 0 ? (bufferedTime / duration) * 100 : 0;

  const subtitleStore = subtitles.store;
  const selectedSubtitleOption = useMemo(() => {
    return subtitles.options.find(s => s.id === subtitles.selectedId) || null;
  }, [subtitles.options, subtitles.selectedId]);

  // Developer diagnostics snapshot (computed on normal re-renders, never per frame)
  const subtitleNowMs = getMediaTimeMs() - subtitles.delayMs;
  const activeCuesNow = subtitleStore && subtitleStore.kind === 'text' ? subtitleStore.activeCues(subtitleNowMs) : [];
  const activeBitmapNow = subtitleStore && subtitleStore.kind !== 'text' ? subtitleStore.activeBitmap(subtitleNowMs) : null;
  const activeCount = activeCuesNow.length + (activeBitmapNow ? 1 : 0);

  let pipelineStage: SubtitlePipelineStage = 'no_track_selected';
  if (subtitleStore) {
    if (subtitleStore.status === 'error') pipelineStage = 'extraction_failed';
    else if (subtitleStore.status === 'empty') pipelineStage = 'zero_cues';
    else if (subtitleStore.itemCount === 0) pipelineStage = 'extracting';
    else pipelineStage = activeCount > 0 ? 'actively_rendering' : 'no_active_cue_at_time';
  }
  const legacySubtitleStatus: PlaybackDiagnosticsState['subtitleExtractionStatus'] = !subtitleStore
    ? 'idle'
    : subtitleStore.status === 'loading' ? 'extracting' : subtitleStore.status === 'ready' ? 'ready' : 'failed';

  const firstCue = subtitleStore && subtitleStore.kind === 'text' ? subtitleStore.getCues()[0] : undefined;
  const firstCuePreview = firstCue
    ? `[${formatTimeMs(firstCue.startMs)} → ${formatTimeMs(firstCue.endMs)}] "${firstCue.text.replace(/\r?\n/g, ' ').trim()}"`
    : subtitleStore && subtitleStore.itemCount > 0 ? `${subtitleStore.itemCount} bitmap subtitles` : 'None';

  const subtitlePipelineDiagnostics: SubtitlePipelineDiagnostics = {
    selectedLabel: selectedSubtitleOption?.label || null,
    streamIndex: selectedSubtitleOption?.streamIndex ?? null,
    codec: subtitleStore?.header?.codecId || selectedSubtitleOption?.codec || selectedSubtitleOption?.format || null,
    isBitmap: !!subtitleStore && subtitleStore.kind !== 'text',
    ffprobeInfo: binaryDiagnostics?.ffprobe,
    ffmpegInfo: binaryDiagnostics?.ffmpeg,
    ffmpegExitCode: null,
    ffmpegStderr: subtitleStore?.error ?? (subtitleStore?.method ? `method: ${subtitleStore.method}` : null),
    extractedCharCount: 0,
    extractedCueCount: subtitleStore?.itemCount ?? 0,
    firstCuePreview,
    currentVideoTimeMs: subtitleNowMs,
    activeCueCount: activeCount,
    pipelineStage
  };

  const effDur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const selectedAudio = audioOptions.find(a => a.id === selectedAudioId);
  const diagnosticsState: PlaybackDiagnosticsState = {
    mediaUrl: sanitizeDisplayUrl(currentUrl),
    sanitizedUrl: sanitizeDisplayUrl(currentUrl),
    container: inspectionResult?.container || (currentUrl.endsWith('.mkv') ? 'matroska' : currentUrl.endsWith('.mp4') ? 'mp4' : undefined),
    duration: effDur,
    videoStreams: inspectionResult?.videoStreams || [],
    audioStreams: inspectionResult?.audioStreams || [],
    subtitleStreams: inspectionResult?.subtitleStreams || [],
    selectedAudioStreamIndex: selectedAudio?.streamIndex,
    selectedSubtitleStreamIndex: selectedSubtitleOption?.streamIndex,
    selectedAudioLabel: selectedAudio?.label,
    selectedSubtitleLabel: selectedSubtitleOption?.label,
    subtitleType: subtitleStore?.header?.codecId || selectedSubtitleOption?.format,
    subtitleExtractionStatus: legacySubtitleStatus,
    subtitleError: subtitleStore?.error || undefined,
    totalCues: subtitleStore?.itemCount ?? 0,
    activeCues: activeCuesNow.map((c) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs, text: c.text })),
    currentTime,
    bufferedEnd: bufferedTime,
    bufferedPercent: effDur > 0 ? Math.min(100, (bufferedTime / effDur) * 100) : 0,
    playbackState,
    mediaError: videoError || audioSwitchError || null,
    lastActionMessage,
    subtitlePipelineDiagnostics
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={resetAutoHide}
      onDoubleClick={toggleFullscreen}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        overflow: 'hidden',
        cursor: controlsVisible ? 'default' : 'none'
      }}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        src={currentUrl}
        autoPlay
        crossOrigin="anonymous"
        style={{
          width: '100%',
          height: '100%',
          objectFit: scalingMode,
          display: 'block'
        }}
        onPlay={() => {
          setIsPlaying(true);
          setPlaybackState('playing');
        }}
        onPause={() => {
          setIsPlaying(false);
          setPlaybackState('paused');
        }}
        onWaiting={() => setPlaybackState('buffering')}
        onPlaying={() => setPlaybackState('playing')}
        onSeeking={() => setPlaybackState('seeking')}
        onSeeked={() => {
          setPlaybackState(videoRef.current?.paused ? 'paused' : 'playing');
          subtitles.notifySeek();
        }}
        onError={() => {
          const v = videoRef.current;
          const mediaErr = v?.error;
          let detail = 'The video stream format or codec could not be rendered natively by Chromium.';
          if (mediaErr) {
            switch (mediaErr.code) {
              case MediaError.MEDIA_ERR_ABORTED:
                detail = 'Playback was aborted by the user or browser.';
                break;
              case MediaError.MEDIA_ERR_NETWORK:
                detail = 'A network error caused media download to fail.';
                break;
              case MediaError.MEDIA_ERR_DECODE:
                detail = 'The video stream could not be decoded (unsupported codec or corrupted stream).';
                break;
              case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                detail = 'The media container, format, or audio/video codec is not supported natively by Chromium.';
                break;
            }
          }
          setVideoError(detail);
          setLastActionMessage(`Media error: ${detail}`);
        }}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          const effective = remuxOffsetRef.current + v.currentTime;
          setCurrentTime(effective);
          if (v.buffered && v.buffered.length > 0) {
            try {
              const bEnd = v.buffered.end(v.buffered.length - 1);
              if (Number.isFinite(bEnd)) {
                setBufferedTime(remuxOffsetRef.current + bEnd);
              }
            } catch {
              // Ignore IndexSizeError during concurrent seek
            }
          }
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v && Number.isFinite(v.duration) && v.duration > 0) {
            if (remuxOffsetRef.current === 0 || !totalDurationRef.current) {
              setDuration(v.duration);
              totalDurationRef.current = v.duration;
            }
          }
        }}
        onDurationChange={() => {
          const v = videoRef.current;
          if (v && Number.isFinite(v.duration) && v.duration > 0) {
            if (remuxOffsetRef.current === 0 || !totalDurationRef.current) {
              setDuration(v.duration);
              totalDurationRef.current = v.duration;
            }
          }
        }}
        onEnded={() => {
          setPlaybackState('ended');
          handleNextEpisode();
        }}
      />

      {/* Subtitles: text cues and PGS/VobSub bitmaps, positioned on the visible picture */}
      <SubtitleOverlay
        videoRef={videoRef}
        containerRef={containerRef}
        store={subtitles.store}
        getMediaTimeMs={getMediaTimeMs}
        subtitleDelayMs={subtitles.delayMs}
        controlsVisible={controlsVisible}
        scalingMode={scalingMode}
        fontScale={subtitlePrefs.scale}
        testMessage={testMessage}
      />

      {/* Subtitle pipeline HUD (Settings → Developer Playback Diagnostics) */}
      {developerDiagnosticsEnabled && (
        <SubtitleDebugHud
          store={subtitles.store}
          option={selectedSubtitleOption}
          status={subtitles.status}
          getMediaTimeMs={getMediaTimeMs}
          delayMs={subtitles.delayMs}
          binaryDiagnostics={binaryDiagnostics}
          onTestOverlay={triggerSubtitleTest}
          onLoadLocal={subtitles.loadLocalFile}
        />
      )}

      {/* Video Decode Error Banner / External Player Fallback Overlay */}
      {videoError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            backdropFilter: 'blur(16px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center',
            zIndex: 1500,
            gap: '16px'
          }}
        >
          <svg width="56" height="56" viewBox="0 0 24 24" fill="var(--accent-red)">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Video Playback Encountered An Issue
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '520px', lineHeight: 1.6 }}>
            {videoError}
            <br />
            <br />
            You can launch this video directly in your installed media player (such as Totem, VLC, or MPV) for full codec support.
          </div>
          <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                window.electronAPI?.openExternalPlayer?.(currentUrl);
              }}
              style={{ padding: '10px 20px', fontSize: '13px' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              Open in System Media Player (VLC / Totem)
            </button>
            <button
              className="btn btn-surface"
              onClick={() => {
                setVideoError(null);
                videoRef.current?.load();
              }}
              style={{ padding: '10px 16px', fontSize: '13px' }}
            >
              Retry
            </button>
            <button
              className="btn btn-surface"
              onClick={onNavigateBack}
              style={{ padding: '10px 16px', fontSize: '13px' }}
            >
              Back to Browser
            </button>
          </div>
        </div>
      )}

      {/* Action / Gesture HUD Overlay */}
      {hudMessage && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--glass-border)',
            padding: '12px 24px',
            borderRadius: 'var(--radius-md)',
            color: 'var(--elegant-primary)',
            fontSize: '18px',
            fontWeight: 700,
            pointerEvents: 'none',
            zIndex: 1400,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
          }}
        >
          {hudMessage}
        </div>
      )}

      {/* Resume Prompt Banner */}
      {showResumePrompt && (
        <div
          style={{
            position: 'absolute',
            bottom: '90px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'var(--dark-surface-card)',
            border: '1px solid var(--elegant-primary)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            zIndex: 1300,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)'
          }}
        >
          <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            Resume from {formatTimeMs(resumePositionMs)}?
          </span>
          <button
            className="btn btn-primary"
            style={{ padding: '6px 14px', fontSize: '12px' }}
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.currentTime = resumePositionMs / 1000;
              }
              setShowResumePrompt(false);
            }}
          >
            Resume
          </button>
          <button
            className="btn btn-surface"
            style={{ padding: '6px 14px', fontSize: '12px' }}
            onClick={() => setShowResumePrompt(false)}
          >
            Start Over
          </button>
        </div>
      )}

      {/* Custom Controls Overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: controlsVisible
            ? 'linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 25%, rgba(0,0,0,0) 75%, rgba(0,0,0,0.92) 100%)'
            : 'none',
          opacity: controlsVisible ? 1 : 0,
          transition: 'opacity 0.15s ease-out',
          pointerEvents: controlsVisible ? 'auto' : 'none',
          padding: '12px 16px'
        }}
        onClick={resetAutoHide}
      >
        {/* Top Control Bar with Integrated Desktop Titlebar Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', WebkitAppRegion: 'drag' } as any}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1, WebkitAppRegion: 'no-drag' } as any}>
            <button
              className="btn btn-surface btn-icon"
              onClick={onNavigateBack}
              title="Back (Esc)"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  color: '#FFF',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
                title={currentTitle}
              >
                {currentTitle}
              </div>
              {directoryContext.directoryTitle && (
                <div style={{ fontSize: '11px', color: 'var(--elegant-primary)' }}>
                  {directoryContext.directoryTitle}
                </div>
              )}
            </div>
          </div>

          {/* Top Actions: Subtitles, Audio, Scaling, Speed, Diagnostics, Episodes, and Window Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', WebkitAppRegion: 'no-drag' } as any}>
            {/* Developer Diagnostics Button (Visible when enabled in Settings) */}
            {developerDiagnosticsEnabled && (
              <button
                className={`btn ${isDiagnosticsOpen ? 'btn-primary' : 'btn-surface'}`}
                onClick={() => setIsDiagnosticsOpen((prev) => !prev)}
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                title="Developer Playback Diagnostics (Ctrl+Shift+D / D)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
                </svg>
                Diag
              </button>
            )}

            {/* Subtitle overlay test (developer mode) */}
            {developerDiagnosticsEnabled && (
              <button
                className="btn btn-surface"
                onClick={triggerSubtitleTest}
                style={{ fontSize: '12px', padding: '6px 12px' }}
                title="Show a test line in the subtitle overlay for 5 seconds"
              >
                Test Subtitle
              </button>
            )}

            {/* Subtitle & Audio Track Button */}
            <button
              className={`btn ${subtitles.selectedId ? 'btn-primary' : 'btn-surface'}`}
              onClick={() => setIsTrackModalOpen(true)}
              style={{ fontSize: '12px', padding: '6px 12px' }}
              title="Subtitles & Audio Tracks (S / C)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/>
              </svg>
              {!subtitles.selectedId
                ? 'Tracks'
                : subtitles.status.state === 'loading' && subtitles.status.itemCount === 0
                  ? 'Sub: Loading…'
                  : subtitles.status.state === 'error' || subtitles.status.state === 'empty'
                    ? 'Sub: Error'
                    : 'Sub: ON'}
            </button>

            {/* Video Scaling Button */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-surface"
                style={{ padding: '6px 12px', fontSize: '12px' }}
                onClick={() => setShowScalingMenu(!showScalingMenu)}
                title="Aspect Ratio / Scaling"
              >
                Scale: {scalingMode.toUpperCase()}
              </button>

              {showScalingMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '6px',
                    backgroundColor: 'var(--dark-surface-card)',
                    border: '1px solid var(--dark-outline-variant)',
                    borderRadius: 'var(--radius-md)',
                    padding: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    zIndex: 1500
                  }}
                >
                  {(['contain', 'cover', 'fill', 'none'] as VideoScaling[]).map((mode) => (
                    <button
                      key={mode}
                      className={`btn ${scalingMode === mode ? 'btn-primary' : 'btn-surface'}`}
                      style={{ fontSize: '12px', padding: '6px 16px', justifyContent: 'flex-start' }}
                      onClick={() => {
                        setScalingMode(mode);
                        setShowScalingMenu(false);
                      }}
                    >
                      {mode === 'contain' ? 'Fit (Contain)' : mode === 'cover' ? 'Crop / Zoom (Cover)' : mode === 'fill' ? 'Stretch Fill' : 'Original Size'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Playback Speed Button */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-surface"
                style={{ padding: '6px 12px', fontSize: '12px' }}
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                title="Playback Speed"
              >
                {playbackSpeed}x
              </button>

              {showSpeedMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '6px',
                    backgroundColor: 'var(--dark-surface-card)',
                    border: '1px solid var(--dark-outline-variant)',
                    borderRadius: 'var(--radius-md)',
                    padding: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    zIndex: 1500
                  }}
                >
                  {[0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((spd) => (
                    <button
                      key={spd}
                      className={`btn ${playbackSpeed === spd ? 'btn-primary' : 'btn-surface'}`}
                      style={{ fontSize: '12px', padding: '6px 16px' }}
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.playbackRate = spd;
                        }
                        setPlaybackSpeed(spd);
                        setShowSpeedMenu(false);
                      }}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Episode Drawer Toggle */}
            <button
              className={`btn ${isDrawerOpen ? 'btn-primary' : 'btn-surface'}`}
              onClick={() => setIsDrawerOpen(!isDrawerOpen)}
              title="Episode Drawer (E)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/>
              </svg>
              Episodes
            </button>

            {/* Desktop Window Controls (Minimize, Maximize, Close) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px', borderLeft: '1px solid var(--dark-outline-variant)', paddingLeft: '8px' }}>
              <button className="titlebar-btn" onClick={handleMinimize} title="Minimize Window">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button className="titlebar-btn" onClick={handleMaximize} title={isMaximized ? "Restore Window" : "Maximize Window"}>
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="5" y="9" width="10" height="10" rx="1" />
                    <polyline points="9 5 19 5 19 15" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                )}
              </button>
              <button className="titlebar-btn close" onClick={handleClose} title="Close App">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Center Big Play/Pause Button */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <button
            onClick={togglePlay}
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
              border: '2px solid rgba(255, 255, 255, 0.3)',
              color: '#FFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              backdropFilter: 'blur(8px)',
              transition: 'all var(--transition-fast)'
            }}
            onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
            onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1.0)'}
          >
            {isPlaying ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 2 }}>
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>
        </div>

        {/* Bottom Control Bar */}
        <div>
          {/* Progress Scrubber */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#FFF', width: '50px' }}>
              {formatTimeMs(currentTime * 1000)}
            </span>

            <div
              ref={progressScrubberRef}
              style={{
                position: 'relative',
                flex: 1,
                height: '10px',
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                borderRadius: '5px',
                cursor: 'pointer'
              }}
              onClick={handleScrubberSeek}
            >
              {/* Buffered Progress */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: '100%',
                  width: `${displayBuffered}%`,
                  backgroundColor: 'rgba(255, 255, 255, 0.35)',
                  borderRadius: '5px'
                }}
              />
              {/* Played Progress */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: '100%',
                  width: `${displayProgress}%`,
                  backgroundColor: 'var(--elegant-primary)',
                  borderRadius: '5px'
                }}
              />
              {/* Scrubber Knob */}
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: `${displayProgress}%`,
                  transform: 'translate(-50%, -50%)',
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  backgroundColor: '#FFF',
                  boxShadow: '0 0 8px rgba(0,0,0,0.5)',
                  pointerEvents: 'none'
                }}
              />
            </div>

            <span style={{ fontSize: '12px', color: 'var(--text-muted)', width: '50px', textAlign: 'right' }}>
              {Number.isFinite(duration) && duration > 0 ? formatTimeMs(duration * 1000) : '--:--'}
            </span>
          </div>

          {/* Transport Buttons */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                className="btn btn-surface btn-icon"
                onClick={handlePrevEpisode}
                disabled={!hasPrev}
                style={{ opacity: hasPrev ? 1 : 0.4 }}
                title="Previous Episode (P)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
                </svg>
              </button>

              <button
                className="btn btn-surface btn-icon"
                onClick={() => seekRelative(-10)}
                title="Rewind 10s (← / J)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                </svg>
              </button>

              <button
                className="btn btn-primary btn-icon"
                onClick={togglePlay}
                title="Play/Pause (Space / K)"
              >
                {isPlaying ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 2 }}>
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                )}
              </button>

              <button
                className="btn btn-surface btn-icon"
                onClick={() => seekRelative(10)}
                title="Forward 10s (→ / L)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                </svg>
              </button>

              <button
                className="btn btn-surface btn-icon"
                onClick={handleNextEpisode}
                disabled={!hasNext}
                style={{ opacity: hasNext ? 1 : 0.4 }}
                title="Next Episode (N)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                </svg>
              </button>

              {/* Volume Slider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '12px' }}>
                <button
                  className="btn btn-surface btn-icon"
                  style={{ width: '28px', height: '28px' }}
                  onClick={() => {
                    if (videoRef.current) {
                      videoRef.current.muted = !videoRef.current.muted;
                      setIsMuted(videoRef.current.muted);
                    }
                  }}
                  title="Mute (M)"
                >
                  {isMuted || volume === 0 ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (videoRef.current) {
                      videoRef.current.volume = val;
                      videoRef.current.muted = false;
                    }
                    setVolume(val);
                    setIsMuted(false);
                  }}
                  style={{ width: '80px', accentColor: 'var(--elegant-primary)' }}
                />
              </div>
            </div>

            {/* Right Controls: Fullscreen */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                className="btn btn-surface btn-icon"
                onClick={toggleFullscreen}
                title="Fullscreen (F)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Episode Side Drawer */}
      <EpisodeDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        videoFiles={directoryContext.videoFiles}
        currentVideoUrl={currentUrl}
        directoryTitle={directoryContext.directoryTitle}
        onSelectEpisode={switchEpisode}
      />

      {/* Subtitles & Audio Track Modal */}
      <TrackSelectorModal
        isOpen={isTrackModalOpen}
        onClose={() => setIsTrackModalOpen(false)}
        subtitleOptions={subtitles.options}
        selectedSubtitleId={subtitles.selectedId}
        onSelectSubtitle={subtitles.select}
        onLoadLocalSubtitle={subtitles.loadLocalFile}
        subtitleStatus={subtitles.status}
        audioOptions={audioOptions}
        selectedAudioId={selectedAudioId}
        onSelectAudio={handleSelectAudio}
        audioSwitching={audioSwitching}
        audioSwitchError={audioSwitchError}
        subtitleDelayMs={subtitles.delayMs}
        onSubtitleDelayChange={handleSubtitleDelayChange}
        audioBoost={audioBoost}
        onAudioBoostChange={setAudioBoost}
        onOpenExternalPlayer={() => window.electronAPI?.openExternalPlayer?.(currentUrl)}
        diagnosticsData={diagnosticsData}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
      />

      {/* Playback Diagnostics Panel (Dev Tools Overlay) */}
      <PlaybackDiagnosticsPanel
        diagnostics={diagnosticsState}
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
      />
    </div>
  );
};
