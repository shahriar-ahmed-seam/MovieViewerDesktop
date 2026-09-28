# MovieViewer Desktop

MovieViewer is a desktop application for Linux and Windows that browses HTTP directory-listing media servers (Apache, Nginx, Lighttpd, h5ai) and plays their videos in a built-in player with full subtitle support.

It is built with Electron, React and TypeScript, and ships its own FFmpeg and FFprobe binaries, so no additional software is required.

[Download the latest release](https://github.com/shahriar-ahmed-seam/MovieViewerDesktop/releases/latest)

---

## Contents

- [Features](#features)
- [Subtitle support](#subtitle-support)
- [Installation](#installation)
- [Usage](#usage)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Building from source](#building-from-source)
- [Testing](#testing)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

**Media browser**

- Parses Apache, Nginx, Lighttpd and h5ai directory listings, including percent-encoded and Unicode paths
- Breadcrumb navigation, back stack, bookmarks and instant filtering of large folders
- "Continue watching" row with progress for recently played videos

**Player**

- Plays MKV, MP4, WebM and other formats supported by Chromium, including HEVC where the GPU driver allows it
- Resume prompt for partially watched videos; playback position is saved every few seconds
- Episode drawer and next/previous episode navigation within a folder
- Multiple audio tracks: non-default tracks are remuxed on the fly by FFmpeg (video copied, audio converted to AAC)
- Scaling modes (fit, crop, stretch, original), playback speed from 0.5x to 2.0x, and an audio boost of up to 200%
- Fallback button to open the stream in a system player (VLC, MPV, Totem) if a codec cannot be decoded

**Subtitles**

- Embedded, sidecar and local subtitle files, in text and image formats
- Text subtitles usually appear within one or two seconds of starting or seeking, without downloading the whole video
- Automatic track selection that skips forced-only, signs-only and commentary tracks
- Per-video delay adjustment in 0.1 s and 0.5 s steps, adjustable text size, and placement that follows the visible picture and moves above the control bar

---

## Subtitle support

| Source | Formats |
| :--- | :--- |
| Embedded in MKV / WebM | SubRip (SRT), ASS/SSA, WebVTT, Blu-ray PGS, DVD VobSub |
| Embedded in MP4 / MOV | mov_text (tx3g), WebVTT |
| Embedded in other containers | Any text format FFmpeg can convert, plus PGS and VobSub |
| Sidecar files on the server | SRT, VTT, ASS/SSA, SAMI (.smi), MicroDVD, SubViewer, MPL2, PGS (.sup), VobSub (.idx + .sub) |
| Local files | Same formats as sidecar files |

Sidecar files are matched to the playing video by name and episode number (S01E03, 1x03, "Episode 3"). The app also looks in `Subs` and `Subtitles` subfolders. Text encodings are handled automatically:

- UTF-8 and UTF-16 are detected, with or without a byte order mark.
- EUC-KR is recognized from its byte patterns.
- Other legacy code pages (Shift_JIS, GB18030, Big5 and the Windows code pages) are chosen from the language named in the file name, for example `Movie.kor.srt`.

### How embedded subtitles are loaded

Extracting a subtitle stream with `ffmpeg -map` reads the entire video file, which for a multi-gigabyte movie on a typical local network takes minutes. MovieViewer avoids this with three strategies, tried in order:

1. **Matroska index.** The container's Cues index points to every subtitle block. MovieViewer fetches only those blocks with HTTP range requests, starting at the current playback position. Blocks near the playhead are fetched first, and the rest are fetched slowly in the background so video playback keeps its bandwidth.
2. **MP4 sample tables.** For MP4 files, the subtitle samples are located from the `moov` box and fetched the same way.
3. **Streaming fallback.** For files without a usable index, FFmpeg reads from the current position and subtitles are delivered as they are found. After a seek, reading restarts at the new position. Reading pauses once it is far ahead of playback (Linux only).

Completed tracks are cached in memory, so switching back to a track is instant.

---

## Installation

Download the file for your platform from the [releases page](https://github.com/shahriar-ahmed-seam/MovieViewerDesktop/releases/latest).

### Linux (x86_64)

**Debian / Ubuntu package**

```bash
sudo apt install ./movieviewer-desktop_1.1.0_amd64.deb
```

This installs the app to `/opt/MovieViewer` and adds a MovieViewer entry to the application menu. To remove it:

```bash
sudo apt remove movieviewer-desktop
```

**AppImage (any distribution)**

```bash
chmod +x MovieViewer-1.1.0-linux-x86_64.AppImage
./MovieViewer-1.1.0-linux-x86_64.AppImage
```

The AppImage requires FUSE 2 (`libfuse2` on Ubuntu 22.04 and later).

### Windows (x64)

- **Portable:** run `MovieViewer-1.1.0-windows-x64-portable.exe`. Nothing is installed.
- **Zip:** extract `MovieViewer-1.1.0-windows-x64.zip` to any folder and run `MovieViewer.exe`.

The binaries are not code-signed, so Windows SmartScreen may show a warning the first time. Choose "More info" and then "Run anyway".

### Verifying downloads

Each release includes a `SHA256SUMS.txt` file:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

---

## Usage

1. Open **Settings** (gear icon) and enter the address of your media server or a folder on it, for example `http://192.168.1.10/media/`.
2. Browse folders and select a video to play it.
3. Subtitles turn on automatically when a suitable track exists. Press `S` or use the **Tracks** button to choose another subtitle or audio track, load a subtitle file from your computer, or adjust the subtitle delay.

The Tracks button shows the subtitle state: `Sub: Loading…`, `Sub: ON` or `Sub: Error`. The track dialog shows progress and any error message.

---

## Keyboard shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `K` | Play / pause |
| `Left` / `J` | Seek back 10 seconds |
| `Right` / `L` | Seek forward 10 seconds |
| `Up` / `Down` | Volume up / down by 5% |
| `M` | Mute / unmute |
| `F` / double-click | Toggle fullscreen |
| `S` / `C` | Subtitle and audio track dialog |
| `N` / `P` | Next / previous episode |
| `E` | Episode drawer |
| `Ctrl+Shift+D` | Playback diagnostics panel |
| `Esc` | Close dialog or drawer, exit fullscreen, or return to the browser |

---

## Settings

| Setting | Description |
| :--- | :--- |
| Server / directory URL | The folder the browser opens on start |
| Bookmarks | Saved locations for quick access |
| Preferred subtitle language | Used for automatic subtitle selection |
| Turn subtitles on automatically | Enables the best matching track when a video starts |
| Text size | Small, normal, large or huge subtitle text |
| Developer playback diagnostics | Shows a subtitle pipeline HUD, an overlay test button and the `D` shortcut for the diagnostics panel |

Settings, bookmarks and watch history are stored as JSON files in the Electron user data directory (`~/.config/movieviewer-desktop` on Linux, `%APPDATA%\movieviewer-desktop` on Windows).

---

## Building from source

### Requirements

- Node.js 20 or later and npm
- Linux or Windows (macOS is not a supported target)
- FFmpeg on `PATH` for the container tests

### Development

```bash
git clone https://github.com/shahriar-ahmed-seam/MovieViewerDesktop.git
cd MovieViewerDesktop
npm install
npm run electron:dev
```

This starts the Vite dev server and Electron together. `npm start` runs the app against the last production build.

On Linux, Electron may refuse to start unless its sandbox helper is owned by root. For local development you can run `npx electron --no-sandbox .` instead.

### Packaging

```bash
npm run pack:linux        # .deb and AppImage
npm run pack:win:nowine   # Windows portable .exe and .zip (works on Linux without Wine)
npm run pack:win          # Windows NSIS installer, portable .exe and .zip
```

Output is written to `release/`.

When building Windows packages on Linux, the executable icon and version information are written by `scripts/after-pack.js` using `resedit`, so Wine is not needed for the portable and zip targets. The NSIS installer target still requires Wine on Linux, or a Windows build machine.

The bundled FFmpeg and FFprobe binaries come from the `@ffmpeg-installer` and `@ffprobe-installer` packages. npm installs only the binary for the current platform. To build Windows packages on Linux, add the Windows binaries first:

```bash
npm install --no-save --force @ffmpeg-installer/win32-x64@4.1.0 @ffprobe-installer/win32-x64@5.1.0
```

Each package includes only its own platform's binaries.

---

## Testing

```bash
npm test                 # All offline tests
npm run test:subtitles   # Subtitle engine only
npm run verify:server    # Checks against a live media server (edit the URL in scripts/verify-architecture.ts)
```

The offline suite covers:

- Subtitle parsers for every supported format
- Charset detection
- The PGS and VobSub decoders
- Automatic track selection and sidecar matching
- The renderer track store
- All three extraction strategies, run against MKV and MP4 files generated with FFmpeg

`scripts/e2e-subtitles.js` drives the built application against a real server. It opens a video, seeks, waits for a subtitle to be drawn and saves a screenshot. The file header documents the options.

---

## Architecture

```
src/
  main/                     Electron main process
    index.ts                Window, IPC handlers
    http-parser.ts          Directory listing parser (cheerio)
    media-inspector.ts      ffprobe stream inspection
    remux-streamer.ts       Local HTTP server that remuxes alternate audio tracks
    binary-resolver.ts      Locates bundled or system ffmpeg / ffprobe
    database.ts             JSON store for history, bookmarks and settings
    subtitles/
      byte-source.ts        HTTP range reader with keep-alive and prioritized scheduling
      ebml.ts, mkv.ts       Matroska index reader, block extraction, streaming parser
      mp4.ts                MP4 sample-table text subtitle extractor
      ffmpeg-stream.ts      Seek-aware FFmpeg streaming fallback
      service.ts            Session management, caching, keyframe lookup
  shared/
    subtitles/              Text parsers, charset detection, PGS and VobSub decoders
  renderer/                 React UI
    pages/                  Browser and player pages
    components/             Overlay, track dialog, settings, diagnostics
    subtitles/              Track store, IPC client, auto-selection, useSubtitles hook
```

Subtitle data is streamed from the main process to the renderer over IPC as it is extracted. The overlay reads the current cue from a sorted store every animation frame. PGS and VobSub images are decoded only when shown, and drawn on a canvas aligned to the visible video picture.

When an alternate audio track is selected, the remuxed stream's clock starts at the video keyframe before the seek point. The player uses that keyframe time as its timeline offset, which keeps subtitles in sync after switching audio.

---

## Troubleshooting

**A video does not play.**
Chromium cannot decode some codecs (for example certain AC-3, DTS or 10-bit HEVC streams, depending on the GPU driver). Use "Open in System Media Player" on the error screen.

**Subtitles show "Loading" for a long time.**
The file probably has no usable index, so the streaming fallback is reading it from the current position. Subtitles appear as that reading passes each line. Open the track dialog to see progress.

**A subtitle track shows "Error" or "contains no subtitles".**
Some releases include empty or placeholder tracks. Choose another track in the dialog. When the track was selected automatically, the app already moves on to the next candidate.

**DVB subtitles are listed but not shown.**
DVB and teletext subtitles are not supported. They are never selected automatically.

**Subtitles are out of sync.**
Use the delay buttons in the track dialog. Positive values show subtitles later.

---

## License

MIT License. See [LICENSE](LICENSE).

FFmpeg and FFprobe are distributed under their own licenses (LGPL/GPL) through the `@ffmpeg-installer` and `@ffprobe-installer` packages.
