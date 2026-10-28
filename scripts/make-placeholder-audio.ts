/**
 * 개발용 임시 음원 생성기. 실제 mp3를 받기 전까지 시간표의 모든 큐에 대해
 * 구별 가능한 신호음(WAV)과 manifest.json을 만든다.
 *
 *   node scripts/make-placeholder-audio.ts
 *
 * 실제 음원으로 교체할 때는 web/public/audio/builtin/ 에 mp3를 넣고 manifest.json의 file만 바꾸면 된다.
 * 이미 manifest에 mp3로 등록된 항목은 덮어쓰지 않는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TEMPLATES } from '../web/src/data/templates.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../web/public/audio/builtin');
const RATE = 22050;

type Tone = { freq: number; sec: number };

function wav(tones: Tone[]): Buffer {
  const samples: number[] = [];
  for (const { freq, sec } of tones) {
    const n = Math.round(sec * RATE);
    for (let i = 0; i < n; i++) {
      const env = freq ? Math.min(1, i / 200, (n - i) / 2000) : 0;
      samples.push(Math.sin((2 * Math.PI * freq * i) / RATE) * env * 0.5);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const BELL: Tone[] = [
  { freq: 784, sec: 0.6 },
  { freq: 659, sec: 0.6 },
  { freq: 523, sec: 1.2 },
];
const MENT: Tone[] = [
  { freq: 440, sec: 0.25 },
  { freq: 0, sec: 0.1 },
  { freq: 440, sec: 0.25 },
  { freq: 0, sec: 0.4 },
  { freq: 330, sec: 2.0 },
];

mkdirSync(OUT, { recursive: true });
const manifestPath = join(OUT, 'manifest.json');
const manifest: Record<string, { file: string; label: string }> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {};

const cues = new Map(BUILTIN_TEMPLATES.flatMap((t) => t.cues).map((c) => [c.assetId, c]));
let made = 0;
for (const [assetId, cue] of cues) {
  if (manifest[assetId] && !manifest[assetId].file.endsWith('.wav')) continue;
  const file = `${assetId}.wav`;
  writeFileSync(join(OUT, file), wav(cue.kind === 'bell' ? BELL : MENT));
  manifest[assetId] = { file, label: `[임시] ${cue.period} ${cue.label}` };
  made++;
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`임시 음원 ${made}개 생성 → ${OUT}`);
