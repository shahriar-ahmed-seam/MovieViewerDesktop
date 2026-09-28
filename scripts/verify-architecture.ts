import http from 'http';
import fs from 'fs';
import { execSync } from 'child_process';
import { resolveFfprobePath, resolveFfmpegPath, getBinaryDiagnostics } from '../src/main/binary-resolver';
import { MediaInspector } from '../src/main/media-inspector';
import { RemuxStreamer } from '../src/main/remux-streamer';
import { SubtitleService } from '../src/main/subtitles/service';
import type { SubtitleSessionEvent, SubtitleCue } from '../src/shared/subtitles/types';

/** Runs one subtitle session to completion and returns what it delivered. */
function extractWithService(url: string, streamIndex: number, codec: string | undefined, streamTypes: string[] | undefined, timeoutMs: number) {
  const service = new SubtitleService();
  const sessionId = `verify-${streamIndex}-${Date.now()}`;
  return new Promise<{ ok: boolean; cues: SubtitleCue[]; packets: number; method?: string; error?: string; firstDataMs: number }>((resolve) => {
    const t0 = Date.now();
    const cues: SubtitleCue[] = [];
    let packets = 0;
    let firstDataMs = -1;
    let method: string | undefined;
    const timer = setTimeout(() => {
      service.cancel(sessionId);
      resolve({ ok: false, cues, packets, method, error: 'timeout', firstDataMs });
    }, timeoutMs);
    service.start({ sessionId, videoUrl: url, streamIndex, codec, streamTypes, startTimeMs: 0 }, (evt: SubtitleSessionEvent) => {
      if (evt.type === 'data') {
        if (firstDataMs < 0) firstDataMs = Date.now() - t0;
        if (evt.cues) cues.push(...evt.cues);
        packets += evt.packets?.length || 0;
        method = evt.method || method;
      } else if (evt.type === 'complete') {
        clearTimeout(timer);
        resolve({ ok: true, cues, packets, method: evt.method || method, firstDataMs });
      } else if (evt.type === 'error') {
        clearTimeout(timer);
        resolve({ ok: false, cues, packets, method, error: evt.error, firstDataMs });
      }
    });
  });
}

const MKV_TEST_URL = 'http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/%282026%29%201080p/Shelter%20%282026%29%201080p%20%5BDual%20Audio%5D/Shelter%20%282026%29%201080p%20BluRay%20x265%20HEVC%20ESub%20%5BDual%20Audio%5D%5BHindi%202.0%2BEnglish%205.1%5D%20-MsMod.mkv';

async function runTests() {
  console.log('==============================================');
  console.log('MovieViewer Desktop - Architecture Acceptance Tests');
  console.log('==============================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // 1. Binary Resolution
  console.log('--- Step 1: Binary Discovery & Diagnostics ---');
  const diag = getBinaryDiagnostics();
  console.log('Diagnostics:', JSON.stringify(diag, null, 2));

  assert(diag.ffprobe.available && !!diag.ffprobe.path, 'ffprobe binary resolved', `source: ${diag.ffprobe.source}`);
  assert(diag.ffmpeg.available && !!diag.ffmpeg.path, 'ffmpeg binary resolved', `source: ${diag.ffmpeg.source}`);
  assert(!!diag.ffprobe.version, `ffprobe version detected: ${diag.ffprobe.version}`);
  assert(!!diag.ffmpeg.version, `ffmpeg version detected: ${diag.ffmpeg.version}`);

  // 2. Real MKV Probing with ffprobe
  console.log('\n--- Step 2: Inspecting Real Multi-Audio MKV ---');
  console.log(`URL: ${MKV_TEST_URL}`);
  const startTime = Date.now();
  const inspectResult = await MediaInspector.inspectMedia(MKV_TEST_URL);
  const probeElapsed = Date.now() - startTime;
  console.log(`Probe completed in ${probeElapsed}ms`);

  assert(inspectResult.success, 'Media inspection succeeded', inspectResult.error);
  if (inspectResult.success) {
    console.log(`Container: ${inspectResult.container}, Duration: ${inspectResult.duration}s`);
    console.log(`Video streams: ${inspectResult.videoStreams.length}`);
    console.log(`Audio streams: ${inspectResult.audioStreams.length}`);
    console.log(`Subtitle streams: ${inspectResult.subtitleStreams.length}`);

    assert(inspectResult.videoStreams.length > 0, 'Found at least 1 video stream');
    assert(inspectResult.videoStreams[0].streamIndex === 0, `Video stream index is 0 (actual: ${inspectResult.videoStreams[0]?.streamIndex})`);

    // Verify audio streams
    assert(inspectResult.audioStreams.length >= 2, `Found >= 2 audio streams (actual: ${inspectResult.audioStreams.length})`);
    const audio0 = inspectResult.audioStreams[0];
    const audio1 = inspectResult.audioStreams[1];
    console.log('Audio 0:', audio0);
    console.log('Audio 1:', audio1);

    assert(audio0.streamIndex === 1, `First audio track has container streamIndex = 1 (actual: ${audio0.streamIndex})`);
    assert(audio1.streamIndex === 2, `Second audio track has container streamIndex = 2 (actual: ${audio1.streamIndex})`);
    assert(audio0.language === 'hin' || audio0.title.toLowerCase().includes('hindi'), 'First audio track identified as Hindi');
    assert(audio1.language === 'eng' || audio1.title.toLowerCase().includes('english'), 'Second audio track identified as English');

    // Verify subtitle stream
    assert(inspectResult.subtitleStreams.length >= 1, `Found >= 1 subtitle stream (actual: ${inspectResult.subtitleStreams.length})`);
    const sub0 = inspectResult.subtitleStreams[0];
    console.log('Subtitle 0:', sub0);
    assert(sub0.streamIndex === 3, `Subtitle track has container streamIndex = 3 (actual: ${sub0.streamIndex})`);
    assert(sub0.kind === 'text', `Subtitle kind is text (actual: ${sub0.kind})`);

  // 3. Embedded subtitle extraction (index-based, no full download)
    console.log('\n--- Step 3: Embedded Subtitle Extraction ---');
    const subStart = Date.now();
    const res = await extractWithService(MKV_TEST_URL, sub0.streamIndex, sub0.codecName, inspectResult.streamTypes, 60000);
    console.log(`Extraction finished in ${Date.now() - subStart}ms via ${res.method} (first data after ${res.firstDataMs}ms)`);
    assert(res.ok, 'Subtitle extraction succeeded', res.error);
    assert(res.cues.length > 10, `Extracted ${res.cues.length} cues`);
    assert(res.firstDataMs >= 0 && res.firstDataMs < 10000, `First cues arrived within 10s (${res.firstDataMs}ms)`);
    console.log('Sample cues:', res.cues.slice(0, 3).map(c => `${c.startMs}-${c.endMs}: ${c.text}`));
  }

  // 4. Remux Streamer with Live Audio Switching
  console.log('\n--- Step 4: Remux Streamer Audio Switching ---');
  const serverPort = await RemuxStreamer.start();
  assert(serverPort > 0, `Remux streamer started on local port ${serverPort}`);

  // Test session for stream 2 (English audio)
  const session1Url = RemuxStreamer.getStreamUrl({
    videoUrl: MKV_TEST_URL,
    audioStreamIndex: 2,
    startTime: 10,
    sessionId: 'test-sess-1'
  });
  assert(!!session1Url, `Prepared stream URL for audio stream 2: ${session1Url}`);

  // Fetch initial chunk from local loopback server
  const fetchChunk = (url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; chunkLength: number; isMatroska: boolean }> => {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let received = 0;
        let isMatroska = false;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          // Check Matroska/EBML header magic bytes 0x1A 0x45 0xDF 0xA3
          if (!isMatroska && chunk.length >= 4) {
            if (chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3) {
              isMatroska = true;
            }
          }
          if (received > 100000) {
            req.destroy(); // Got enough data
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, chunkLength: received, isMatroska });
          }
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, chunkLength: received, isMatroska });
        });
        res.on('error', (err) => {
          if ((req as any).destroyed) {
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, chunkLength: received, isMatroska });
          } else {
            reject(err);
          }
        });
      });
      req.on('error', (err) => {
        if ((req as any).destroyed) {
          resolve({ statusCode: 200, headers: {}, chunkLength: 0, isMatroska: false });
        } else {
          reject(err);
        }
      });
    });
  };

  const streamTest = await fetchChunk(session1Url);
  assert(streamTest.statusCode === 200, `Stream returned HTTP 200 (actual: ${streamTest.statusCode})`);
  assert(streamTest.headers['content-type'] === 'video/x-matroska', `Content-Type is video/x-matroska (actual: ${streamTest.headers['content-type']})`);
  assert(streamTest.isMatroska, 'Stream starts with valid EBML/Matroska header');
  assert(streamTest.chunkLength > 50000, `Received initial chunk of ${streamTest.chunkLength} bytes`);

  // Test rapid switching cancellation
  console.log('\n--- Step 5: Rapid Switching Cancellation ---');
  const rapid1Url = RemuxStreamer.getStreamUrl({
    videoUrl: MKV_TEST_URL,
    audioStreamIndex: 1,
    startTime: 30,
    sessionId: 'rapid-1'
  });
  // Immediately switch before consumption
  RemuxStreamer.cancelSession('rapid-1');
  const rapid2Url = RemuxStreamer.getStreamUrl({
    videoUrl: MKV_TEST_URL,
    audioStreamIndex: 2,
    startTime: 35,
    sessionId: 'rapid-2'
  });
  const rapid2Test = await fetchChunk(rapid2Url);
  assert(rapid2Test.statusCode === 200 && rapid2Test.isMatroska, 'Rapid switch successfully served stream 2 without lockup');
  RemuxStreamer.cancelSession('rapid-2');
  RemuxStreamer.stop();

  // 6. Robust Error Handling (Invalid URLs and stream indices)
  console.log('\n--- Step 6: Error Handling & Resilience ---');
  const badInspect = await MediaInspector.inspectMedia('http://127.0.0.1:59999/does_not_exist.mkv');
  assert(!badInspect.success, 'Invalid media URL safely returns failure without throwing uncaught exception');
  assert(!!badInspect.error, `Error message returned gracefully: ${badInspect.error}`);

  const badSub = await extractWithService(MKV_TEST_URL, 9999, 'subrip', inspectResult.streamTypes, 30000);
  assert(!badSub.ok && badSub.cues.length === 0, 'Extracting invalid streamIndex 9999 returns failure gracefully', badSub.error);

  // 7. Dual-Audio MP4 and Rapid Repeated Switching
  console.log('\n--- Step 7: Dual-Audio MP4 & Rapid Repeated Switching ---');
  const mp4Path = '/tmp/test_dual_audio.mp4';
  if (!fs.existsSync(mp4Path)) {
    console.log('Generating test dual-audio MP4 with ffmpeg...');
    execSync(`ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -f lavfi -i sine=frequency=440:duration=2 -f lavfi -i sine=frequency=880:duration=2 -map 0:v -map 1:a -map 2:a -c:v libx264 -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:0 title="English Stereo" -metadata:s:a:1 language=spa -metadata:s:a:1 title="Spanish Stereo" -y "${mp4Path}"`, { stdio: 'ignore' });
  }

  await RemuxStreamer.start();
  const mp4Inspect = await MediaInspector.inspectMedia(mp4Path);
  assert(mp4Inspect.success, 'MP4 media inspection succeeded');
  assert(mp4Inspect.audioStreams.length === 2, `Found 2 audio streams in MP4 (actual: ${mp4Inspect.audioStreams.length})`);
  assert(mp4Inspect.audioStreams[0].streamIndex === 1, `MP4 audio 1 has streamIndex 1`);
  assert(mp4Inspect.audioStreams[1].streamIndex === 2, `MP4 audio 2 has streamIndex 2`);
  assert(mp4Inspect.audioStreams[0].language === 'eng', 'MP4 audio 1 is English');
  assert(mp4Inspect.audioStreams[1].language === 'spa', 'MP4 audio 2 is Spanish');

  // Rapid repeated switching on MP4 (5 switches in rapid succession)
  for (let i = 0; i < 5; i++) {
    const targetStream = (i % 2) + 1; // Alternating 1 and 2
    const rapidSessionId = `rapid-mp4-${i}`;
    const rUrl = RemuxStreamer.getStreamUrl({
      videoUrl: '/tmp/test_dual_audio.mp4',
      audioStreamIndex: targetStream,
      startTime: 0.5,
      sessionId: rapidSessionId
    });
    if (i < 4) {
      // Cancel previous quickly
      RemuxStreamer.cancelSession(rapidSessionId);
    } else {
      // Final switch: verify stream data arrives smoothly
      const finalStream = await fetchChunk(rUrl);
      assert(finalStream.statusCode === 200 && finalStream.isMatroska, 'Final switch of repeated rapid switching on MP4 succeeded');
      RemuxStreamer.cancelSession(rapidSessionId);
    }
  }
  RemuxStreamer.stop();

  console.log('\n==============================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('==============================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
