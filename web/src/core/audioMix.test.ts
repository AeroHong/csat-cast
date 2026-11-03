import { describe, expect, it } from 'vitest';
import { clipGain, encodeWav, findSoundBounds, planMix } from './audioMix';

const SR = 1000;
/** 앞 1초 무음, 0.5초 소리(진폭 amp), 뒤 1초 무음 */
function padded(amp = 0.5) {
  const s = new Float32Array(2500);
  for (let i = 1000; i < 1500; i++) s[i] = i % 2 ? amp : -amp;
  return s;
}

describe('음원 이어 붙이기', () => {
  it('앞뒤 무음을 잘라 내고 소리 앞뒤로 여유를 남긴다', () => {
    expect(findSoundBounds(padded(), SR, { padMs: 100 })).toEqual({ start: 900, end: 1600 });
  });

  it('전부 무음이면 자르지 않는다', () => {
    expect(findSoundBounds(new Float32Array(300), SR)).toEqual({ start: 0, end: 300 });
  });

  it('작은 소리는 키우되 가장 큰 소리가 -1dB를 넘지 않게 한다', () => {
    const quiet = new Float32Array(100).fill(0.01);
    expect(clipGain(quiet)).toBeCloseTo(8); // 최대 8배
    const loud = new Float32Array(100).fill(0.9);
    expect(clipGain(loud) * 0.9).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-9);
    expect(clipGain(new Float32Array(10))).toBe(1);
  });

  it('블록을 순서대로 놓고 블록 사이에만 간격을 둔다', () => {
    const { placements, totalSec } = planMix([
      { startSec: 0.2, endSec: 5.2, gain: 1, gapAfterSec: 1 },
      { startSec: 0, endSec: 30, gain: 2, gapAfterSec: 3 }, // 마지막 간격은 무시
    ]);
    expect(placements).toEqual([
      { atSec: 0, offsetSec: 0.2, durationSec: 5, gain: 1 },
      { atSec: 6, offsetSec: 0, durationSec: 30, gain: 2 },
    ]);
    expect(totalSec).toBe(36);
  });

  it('16bit 모노 WAV로 저장한다', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 32000);
    const v = new DataView(wav);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(32000);
    expect(v.getUint32(40, true)).toBe(8);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });
});
