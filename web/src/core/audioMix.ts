/**
 * 음원 이어 붙이기 (학교가 TTS로 만든 멘트 앞뒤에 타종을 붙이는 용도).
 * 분석·배치·WAV 저장은 순수 함수, 실제 합치기는 브라우저 OfflineAudioContext가 한다 (재샘플링·스테레오→모노 포함).
 */

/** 결과 음원: 모노 32kHz 16bit WAV — 말소리·타종에 충분하고 1분에 약 3.8MB (업로드 제한 20MB 안에서 5분 남짓) */
export const MIX_SAMPLE_RATE = 32_000;

const dbToAmp = (db: number) => Math.pow(10, db / 20);

/** 여러 채널을 평균한 모노 신호 (분석용) */
export function mixdown(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/**
 * 앞뒤 무음을 뺀 소리 구간 [start, end) (샘플 위치). 소리 앞뒤로 padMs만큼 여유를 남긴다.
 * 전부 무음이면 전체를 돌려준다.
 */
export function findSoundBounds(
  samples: Float32Array,
  sampleRate: number,
  { thresholdDb = -45, padMs = 80 }: { thresholdDb?: number; padMs?: number } = {},
): { start: number; end: number } {
  const thr = dbToAmp(thresholdDb);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { start: 0, end: samples.length };
  const pad = Math.round((padMs * sampleRate) / 1000);
  return { start: Math.max(0, first - pad), end: Math.min(samples.length, last + 1 + pad) };
}

/**
 * 음량 맞추기 배율: 평균 음량(RMS)을 targetRmsDb에 맞추되, 가장 큰 소리가 peakDb를 넘지 않게 한다.
 * TTS 멘트와 타종의 크기 차이를 줄이기 위함. 무음이면 1.
 */
export function clipGain(
  samples: Float32Array,
  { targetRmsDb = -20, peakDb = -1, maxGain = 8 }: { targetRmsDb?: number; peakDb?: number; maxGain?: number } = {},
): number {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  if (peak === 0) return 1;
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(dbToAmp(targetRmsDb) / rms, dbToAmp(peakDb) / peak, maxGain);
}

export interface MixBlock {
  /** 원본에서 쓸 구간 (초) */
  startSec: number;
  endSec: number;
  /** 음량 배율 (자동 맞추기 × 담당자가 정한 음량) */
  gain: number;
  /** 이 블록 뒤 간격 (초). 마지막 블록은 무시 */
  gapAfterSec: number;
}

export interface MixPlacement {
  /** 결과 음원에서 시작 위치 (초) */
  atSec: number;
  offsetSec: number;
  durationSec: number;
  gain: number;
}

/** 블록을 순서대로 이어 붙일 배치표와 전체 길이 */
export function planMix(blocks: MixBlock[]): { placements: MixPlacement[]; totalSec: number } {
  const placements: MixPlacement[] = [];
  let t = 0;
  blocks.forEach((b, i) => {
    const durationSec = Math.max(0, b.endSec - b.startSec);
    placements.push({ atSec: t, offsetSec: b.startSec, durationSec, gain: b.gain });
    t += durationSec;
    if (i < blocks.length - 1) t += Math.max(0, b.gapAfterSec);
  });
  return { placements, totalSec: t };
}

/** 배치표대로 합친 모노 음원을 만든다 (브라우저 전용) */
export async function renderMix(buffers: AudioBuffer[], placements: MixPlacement[], totalSec: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(totalSec * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE);
  placements.forEach((p, i) => {
    const src = ctx.createBufferSource();
    src.buffer = buffers[i];
    const g = ctx.createGain();
    g.gain.value = p.gain;
    src.connect(g).connect(ctx.destination);
    src.start(p.atSec, p.offsetSec, p.durationSec);
  });
  return ctx.startRendering();
}

/** 16bit PCM 모노 WAV 파일 내용 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt 크기
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // 초당 바이트
  v.setUint16(32, 2, true); // 샘플당 바이트
  v.setUint16(34, 16, true); // 비트
  str(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
