import { describe, expect, it } from 'vitest';
import { encodeMp3, safeFileName } from './mp3';

describe('encodeMp3', () => {
  it('모노 32kHz 샘플을 MPEG 프레임으로 인코딩한다', async () => {
    const sr = 32_000;
    const samples = new Float32Array(sr * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
    const blob = await encodeMp3(samples, sr);
    const b = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe('audio/mpeg');
    // 128kbps × 2초 ≈ 32KB
    expect(b.length).toBeGreaterThan(25_000);
    expect(b.length).toBeLessThan(40_000);
    // 프레임 동기 11비트
    expect(b[0]).toBe(0xff);
    expect(b[1] & 0xe0).toBe(0xe0);
  });
});

describe('safeFileName', () => {
  it('윈도우 파일 이름에 못 쓰는 글자를 뺀다', () => {
    expect(safeFileName('0840_본령: 1교시?')).toBe('0840_본령 1교시');
    expect(safeFileName('  ')).toBe('음원');
  });
});
