import {
  parseTimeToMs,
  formatMsToVttTime,
  sanitizeSubtitleText,
  parseSrt,
  parseVtt,
  parseAss,
  parseSubtitleToCues,
  findCuesAtTime,
  findCueAtTime,
  applySubtitleDelay,
  SubtitleCue
} from '../src/renderer/utils/subtitle';

async function runSubtitleTests() {
  console.log('==============================================');
  console.log('MovieViewer - Subtitle Pipeline Unit Tests');
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

  // --- Category 1: Timecode Parsing & Formatting ---
  console.log('--- 1. Timecode Parsing & Formatting ---');
  assert(parseTimeToMs('01:23:45,678') === (1 * 3600 + 23 * 60 + 45) * 1000 + 678, 'Parses HH:MM:SS,mmm with comma');
  assert(parseTimeToMs('00:02:15.500') === 135500, 'Parses HH:MM:SS.mmm with dot');
  assert(parseTimeToMs('1:05.250') === 65250, 'Parses M:SS.mmm');
  assert(parseTimeToMs('45.100') === 45100, 'Parses SS.mmm');
  assert(formatMsToVttTime(135500) === '00:02:15.500', 'Formats 135500ms to 00:02:15.500');
  assert(formatMsToVttTime(0) === '00:00:00.000', 'Formats 0ms to 00:00:00.000');

  // --- Category 2: HTML & ASS Sanitization ---
  console.log('\n--- 2. HTML & ASS Sanitization ---');
  const dirtyHtml = '<b>Hello</b> <i>world</i>! <font color="#ff0000">Red text</font><br/>Second &amp; third line &quot;quoted&#39;';
  const cleanHtml = sanitizeSubtitleText(dirtyHtml);
  assert(cleanHtml === 'Hello world! Red text\nSecond & third line "quoted\'', 'Strips HTML tags, converts <br/> to newline, decodes entities');

  const dirtyAss = '{\\an8\\pos(192,20)\\c&H0000FF&}Top Subtitle\\NSecond line of text\\hwith space{\\p1}m 0 0 l 10 10{\\p0}';
  const cleanAss = sanitizeSubtitleText(dirtyAss);
  assert(cleanAss === 'Top Subtitle\nSecond line of text with space', 'Strips ASS override blocks, drawings, converts \\N to newline, \\h to space');

  // --- Category 3: SRT Parsing ---
  console.log('\n--- 3. SRT Parser ---');
  const srtSample = `
1
00:01:20,000 --> 00:01:24,500
<i>Welcome</i> to MovieViewer!
Enjoy your high-definition movie.

2
00:01:25,000 --> 00:01:28,000
<font color="#ffff00">Audio &amp; subtitles synchronized.</font>
`;
  const srtCues = parseSrt(srtSample);
  assert(srtCues.length === 2, `Parsed 2 SRT cues (actual: ${srtCues.length})`);
  assert(srtCues[0].startMs === 80000 && srtCues[0].endMs === 84500, 'SRT cue 1 timestamps correct');
  assert(srtCues[0].text === 'Welcome to MovieViewer!\nEnjoy your high-definition movie.', 'SRT cue 1 multiline text cleaned of <i> tags');
  assert(srtCues[1].text === 'Audio & subtitles synchronized.', 'SRT cue 2 entity decoded and font tag stripped');

  // --- Category 4: WebVTT Parsing ---
  console.log('\n--- 4. WebVTT Parser ---');
  const vttSample = `WEBVTT - Sample File
NOTE This is a commentary note that should be ignored

STYLE
::cue { color: yellow; }

cue-1
00:00:10.000 --> 00:00:15.000 line:80% position:50% align:center
First WebVTT subtitle line.
<v Speaker 1>Second line with speaker tag.</v>

cue-2
00:00:16.500 --> 00:00:20.000
Standalone cue without settings.
`;
  const vttCues = parseVtt(vttSample);
  assert(vttCues.length === 2, `Parsed 2 WebVTT cues, skipped NOTE and STYLE (actual: ${vttCues.length})`);
  assert(vttCues[0].startMs === 10000 && vttCues[0].endMs === 15000, 'VTT cue 1 timestamps parsed, cue settings ignored');
  assert(vttCues[0].text === 'First WebVTT subtitle line.\nSecond line with speaker tag.', 'VTT cue 1 stripped <v> tag, multiline preserved');
  assert(vttCues[1].startMs === 16500 && vttCues[1].text === 'Standalone cue without settings.', 'VTT cue 2 parsed cleanly');

  // --- Category 5: ASS/SSA Parsing ---
  console.log('\n--- 5. ASS / SSA Parser ---');
  const assSample = `[Script Info]
Title: Test ASS File
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:05.50,0:01:10.20,Default,,0,0,0,,{\\an8}Hello!\\NWait, are you sure, really sure?
Dialogue: 0,0:01:12.00,0:01:15.50,Default,,0,0,0,,Yes, I am sure.
; This is a comment that should be ignored
`;
  const assCues = parseAss(assSample);
  assert(assCues.length === 2, `Parsed 2 ASS dialogue cues (actual: ${assCues.length})`);
  assert(assCues[0].startMs === 65500 && assCues[0].endMs === 70200, 'ASS cue 1 start and end ms accurate');
  assert(assCues[0].text === 'Hello!\nWait, are you sure, really sure?', 'ASS dialogue preserves multiple internal commas and converts \\N to newline');
  assert(assCues[1].text === 'Yes, I am sure.', 'ASS cue 2 dialogue parsed cleanly');

  // --- Category 6: Malformed Subtitles & Error Resilience ---
  console.log('\n--- 6. Malformed Subtitles Resilience ---');
  const malformedSample = `\uFEFF1
00:00:05,000 --> 00:00:02,000
Inverted end timestamp (end < start)

2
This is a corrupted block without timestamp arrow
Text with no timestamps

3
00:00:10,000 --> 00:00:15,000
Valid cue after corrupted block

4
00:00:20,000 --> 00:00:25,000
   
`;
  const malformedCues = parseSubtitleToCues(malformedSample, 'srt');
  assert(malformedCues.length === 2, `Handled malformed input gracefully, recovered 2 valid cues (actual: ${malformedCues.length})`);
  assert(malformedCues[0].startMs === 5000 && malformedCues[0].endMs >= 5000, 'Inverted timestamp cue auto-corrected endMs >= startMs');
  assert(malformedCues[1].startMs === 10000 && malformedCues[1].text === 'Valid cue after corrupted block', 'Recovered valid cue after corrupted lines');

  // Empty input handling
  assert(parseSubtitleToCues('', 'srt').length === 0, 'Empty string returns empty cue array');
  assert(parseSubtitleToCues('   ', 'vtt').length === 0, 'Whitespace string returns empty cue array');

  // --- Category 7: Subtitle Delay Direction ---
  console.log('\n--- 7. Subtitle Delay Direction ---');
  const baseCues: SubtitleCue[] = [
    { id: '1', startMs: 10000, endMs: 15000, text: 'Base cue at 10s' }
  ];

  // Test positive delay (+2.0s): cue should appear 2s later (at 12s)
  const delayedPositive = applySubtitleDelay(baseCues, 2000);
  assert(delayedPositive[0].startMs === 12000 && delayedPositive[0].endMs === 17000, 'Positive delay (+2000ms) shifts cue startMs from 10s to 12s');

  // Test negative delay (-3.0s): cue should appear 3s earlier (at 7s)
  const delayedNegative = applySubtitleDelay(baseCues, -3000);
  assert(delayedNegative[0].startMs === 7000 && delayedNegative[0].endMs === 12000, 'Negative delay (-3000ms) shifts cue startMs from 10s to 7s');

  // Test lookup with delay: if user delayed by +2.0s, at video time 12.0s (12000ms),
  // effective subtitle time = 12000 - 2000 = 10000ms -> matches base cue at 10s!
  const activeDelayedAt12s = findCuesAtTime(baseCues, 12000 - 2000);
  assert(activeDelayedAt12s.length === 1 && activeDelayedAt12s[0].id === '1', 'Effective time (videoCurrentMs - delayMs) matches delayed cue at 12s');

  const activeDelayedAt10s = findCuesAtTime(baseCues, 10000 - 2000);
  assert(activeDelayedAt10s.length === 0, 'At video time 10s with +2.0s delay, subtitle has NOT appeared yet');

  // --- Category 8: Multi-Cue Overlap Support ---
  console.log('\n--- 8. Multi-Cue Overlap Support ---');
  const overlappingCues: SubtitleCue[] = [
    { id: 'c1', startMs: 2000, endMs: 8000, text: 'Speaker 1 (Bottom Dialogue)' },
    { id: 'c2', startMs: 4000, endMs: 6000, text: 'Sign translation: [LIBRARY]' },
    { id: 'c3', startMs: 5000, endMs: 9000, text: 'Speaker 2 (Overlapping remark)' }
  ];

  // At t = 1000ms: no cues
  assert(findCuesAtTime(overlappingCues, 1000).length === 0, 'No active cues at 1.0s');

  // At t = 3000ms: only Speaker 1
  const at3s = findCuesAtTime(overlappingCues, 3000);
  assert(at3s.length === 1 && at3s[0].id === 'c1', '1 active cue at 3.0s (Speaker 1)');

  // At t = 4500ms: Speaker 1 + Sign translation
  const at4_5s = findCuesAtTime(overlappingCues, 4500);
  assert(at4_5s.length === 2 && at4_5s[0].id === 'c1' && at4_5s[1].id === 'c2', '2 simultaneous active cues at 4.5s');

  // At t = 5500ms: All 3 cues active simultaneously!
  const at5_5s = findCuesAtTime(overlappingCues, 5500);
  assert(at5_5s.length === 3, `3 simultaneous active cues at 5.5s (actual: ${at5_5s.length})`);
  assert(at5_5s.map(c => c.id).join(',') === 'c1,c2,c3', 'All 3 overlapping cue IDs correctly returned');

  // At t = 7000ms: Speaker 1 + Speaker 2 (Sign ended at 6s)
  const at7s = findCuesAtTime(overlappingCues, 7000);
  assert(at7s.length === 2 && at7s[0].id === 'c1' && at7s[1].id === 'c3', '2 active cues at 7.0s after Sign cue expired');

  // At t = 10000ms: All cues expired
  assert(findCuesAtTime(overlappingCues, 10000).length === 0, 'No active cues at 10.0s');

  // --- Category 9: Unicode & International Character Support ---
  console.log('\n--- 9. Unicode & International Character Support ---');
  const unicodeSample = `
1
00:00:01,000 --> 00:00:04,000
Bengali: বাংলা সাবটাইটেল - স্বাগতম!

2
00:00:05,000 --> 00:00:08,000
Japanese: 日本語字幕：こんにちは、世界！

3
00:00:09,000 --> 00:00:12,000
Arabic: مرحبا بالعالم - الترجمة متزامنة

4
00:00:13,000 --> 00:00:16,000
French & Spanish: café, señor, naïve, Ça va? 🎬🍿✨
`;
  const unicodeCues = parseSubtitleToCues(unicodeSample, 'srt');
  assert(unicodeCues.length === 4, 'Parsed all 4 international unicode cues');
  assert(unicodeCues[0].text === 'Bengali: বাংলা সাবটাইটেল - স্বাগতম!', 'Bengali script preserved intact');
  assert(unicodeCues[1].text === 'Japanese: 日本語字幕：こんにちは、世界！', 'Japanese kanji & kana preserved intact');
  assert(unicodeCues[2].text === 'Arabic: مرحبا بالعالم - الترجمة متزامنة', 'Arabic script preserved intact');
  assert(unicodeCues[3].text === 'French & Spanish: café, señor, naïve, Ça va? 🎬🍿✨', 'Accents, cedillas, and emojis preserved intact');

  console.log('\n==============================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('==============================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSubtitleTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
