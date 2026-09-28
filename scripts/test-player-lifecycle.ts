import { sanitizeDisplayUrl } from '../src/renderer/components/PlaybackDiagnosticsPanel';
import { parseSubtitleToCues, findCuesAtTime } from '../src/renderer/utils/subtitle';

let passed = 0;
let failed = 0;

function assert(desc: string, cond: boolean, details?: any) {
  if (cond) {
    console.log(`✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${desc}`, details ? details : '');
    failed++;
  }
}

console.log('==============================================');
console.log('MovieViewer - Player Lifecycle & Safety Tests');
console.log('==============================================\n');

// 1. URL & Token Sanitization
console.log('--- 1. Diagnostics URL & Token Sanitization ---');
const rawUrlWithToken = 'http://192.168.1.100:8080/movies/Secret%20Folder/movie.mkv?token=secret123&auth=abc&password=pwd';
const sanitizedHttp = sanitizeDisplayUrl(rawUrlWithToken);
assert('Sanitized HTTP removes token parameter', !sanitizedHttp.includes('secret123'));
assert('Sanitized HTTP removes auth parameter', !sanitizedHttp.includes('auth=abc'));
assert('Sanitized HTTP removes password parameter', !sanitizedHttp.includes('pwd'));
assert('Sanitized HTTP preserves safe host and filename', sanitizedHttp.includes('192.168.1.100:8080') && sanitizedHttp.includes('movie.mkv'));
assert('Sanitized HTTP collapses intermediate folders to /.../', sanitizedHttp.includes('/.../movie.mkv'));

const rawLocalPath = '/home/exampleuser/Documents/PrivateVault/sensitive_movie.mp4';
const sanitizedLocal = sanitizeDisplayUrl(rawLocalPath);
assert('Sanitized local path hides private directories', !sanitizedLocal.includes('PrivateVault'));
assert('Sanitized local path hides home username', !sanitizedLocal.includes('exampleuser'));
assert('Sanitized local path preserves filename', sanitizedLocal.includes('sensitive_movie.mp4'));

// 2. Generation / Cancellation Token Simulation
console.log('\n--- 2. Request Generation & Cancellation Simulation ---');
let currentGeneration = 0;
let activeCuesState: any[] = [];
let lastAction = '';

function simulateLoadTracks(videoUrl: string) {
  const token = ++currentGeneration;
  // Synchronously invalidate state
  activeCuesState = [];
  lastAction = `Started load generation #${token}`;

  return new Promise<void>((resolve) => {
    // Simulate async network/ffprobe latency
    setTimeout(() => {
      if (token !== currentGeneration) {
        lastAction = `Discarded stale result for token #${token}`;
        resolve();
        return;
      }
      activeCuesState = [{ id: 'cue-1', text: `Cues for ${videoUrl}` }];
      lastAction = `Loaded generation #${token}`;
      resolve();
    }, 50);
  });
}

async function runCancellationTest() {
  const p1 = simulateLoadTracks('video-1.mkv');
  // Immediately switch video before p1 completes
  const p2 = simulateLoadTracks('video-2.mkv');

  await Promise.all([p1, p2]);
  assert('Current generation is 2', currentGeneration === 2);
  assert('State contains cues for video-2 and NOT video-1', activeCuesState[0]?.text === 'Cues for video-2.mkv');
  assert('Final action indicates generation #2 loaded', lastAction.includes('Loaded generation #2'));
}

// 3. AudioContext Multiple MediaElementSource Guard
console.log('\n--- 3. AudioContext Source Connection Safety ---');
let audioSourceConnected = false;
let connectionAttempts = 0;

function connectVideoToGain() {
  connectionAttempts++;
  if (audioSourceConnected) {
    // Guard prevents calling createMediaElementSource a second time
    return 'skipped_already_connected';
  }
  audioSourceConnected = true;
  return 'connected';
}

const firstConnect = connectVideoToGain();
const secondConnect = connectVideoToGain();
assert('First connection succeeds', firstConnect === 'connected');
assert('Second connection is safely guarded against InvalidStateError', secondConnect === 'skipped_already_connected');
assert('Connection attempt was executed twice without throwing', connectionAttempts === 2);

// 4. Safe Buffered Range & Division by Zero Guards
console.log('\n--- 4. Safe Buffered Range & Duration Computation ---');
function calculateBufferPercent(bufferedEnd: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(bufferedEnd) || bufferedEnd <= 0) return 0;
  return Math.min(100, (bufferedEnd / duration) * 100);
}

assert('Zero duration returns 0% buffer', calculateBufferPercent(10, 0) === 0);
assert('NaN duration returns 0% buffer', calculateBufferPercent(10, NaN) === 0);
assert('Infinity duration returns 0% buffer', calculateBufferPercent(10, Infinity) === 0);
assert('Normal buffer returns correct percentage', Math.round(calculateBufferPercent(50, 100)) === 50);
assert('Over-buffered caps at 100%', calculateBufferPercent(120, 100) === 100);

// 5. Cue Lookup During Active Seeking & Delay
console.log('\n--- 5. Subtitle Cue Filtering at Time with Delay ---');
const sampleVtt = `WEBVTT

00:00:05.000 --> 00:00:08.000
First subtitle line

00:00:10.000 --> 00:00:14.000
Second subtitle line
`;

const cues = parseSubtitleToCues(sampleVtt, 'vtt');
assert('Parsed 2 cues from VTT', cues.length === 2);

// Subtitle delay test: +2000ms delay means subtitle scheduled for 5s appears at video time 7s
const delayMs = 2000;
const videoTimeAt6s = 6000;
const effectiveTimeAt6s = videoTimeAt6s - delayMs; // 4000ms
const activeAt6s = findCuesAtTime(cues, effectiveTimeAt6s);
assert('At 6.0s video time with +2.0s delay, 5.0s cue is not yet displayed', activeAt6s.length === 0);

const videoTimeAt7s = 7000;
const effectiveTimeAt7s = videoTimeAt7s - delayMs; // 5000ms
const activeAt7s = findCuesAtTime(cues, effectiveTimeAt7s);
assert('At 7.0s video time with +2.0s delay, 5.0s cue is active', activeAt7s.length === 1 && activeAt7s[0].text === 'First subtitle line');

runCancellationTest().then(() => {
  console.log('\n==============================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('==============================================');
  if (failed > 0) process.exit(1);
});
