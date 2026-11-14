/**
 * 학교 방송 프로그램에 넣을 MP3 만들기·내려받기.
 * 인코더(lamejs)는 내려받을 때만 불러온다 (방송 화면 첫 로딩에는 넣지 않는다).
 */

const KBPS = 128;
/** 한 번에 인코더에 넣는 샘플 수 (1152의 배수) */
const CHUNK = 1152 * 32;

/** 모노 float 샘플(−1~1)을 MP3로. sampleRate는 MPEG가 허용하는 값(32000·44100·48000 등) */
export async function encodeMp3(samples: Float32Array, sampleRate: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const enc = new Mp3Encoder(1, sampleRate, KBPS);
  const parts: Uint8Array[] = [];
  const pcm = new Int16Array(CHUNK);
  for (let i = 0; i < samples.length; i += CHUNK) {
    const n = Math.min(CHUNK, samples.length - i);
    for (let j = 0; j < n; j++) {
      const s = Math.max(-1, Math.min(1, samples[i + j]));
      pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const out = enc.encodeBuffer(n === CHUNK ? pcm : pcm.subarray(0, n));
    if (out.length) parts.push(out.slice());
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail.slice());
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** 윈도우 파일 이름에 못 쓰는 글자를 뺀다 */
export function safeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  return s || '음원';
}

/** 브라우저 내려받기 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 내려받기가 시작된 뒤에 놓아준다
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 여러 파일을 차례로 내려받을 때 브라우저가 막지 않도록 사이를 둔다 */
export const nextDownload = () => new Promise((r) => setTimeout(r, 400));

/** 음원 이름순 정렬 (한글, 숫자는 크기순: 0805_… < 1045_…) */
export const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'ko', { numeric: true });
