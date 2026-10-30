import type { Asset } from './types';

const AUDIO_CACHE = 'csat-audio-v1';

export interface LoadResult {
  loaded: string[];
  failed: { id: string; error: string }[];
}

export interface PlayHandle {
  /** 실제 재생이 시작될 서버 시각 (epoch ms) */
  startAt: number;
  durationMs: number;
  ended: Promise<void>;
  stop(): void;
}

/**
 * Web Audio 기반 재생기.
 * - 모든 음원을 미리 내려받아 디코딩(AudioBuffer)해 두므로 재생 순간에 네트워크가 필요 없다.
 * - AudioContext 시계로 예약 재생하여 수 ms 단위로 정확하다.
 * - 무음 신호를 계속 흘려 브라우저가 탭을 절전/스로틀링하지 않게 한다.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private active = new Set<AudioBufferSourceNode>();

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /** 사용자 클릭 이벤트 안에서 호출하면 확실히 켜진다 (브라우저 자동재생 정책). */
  async unlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') await ctx.resume();
    return this.unlocked;
  }

  /**
   * 클릭 없이 켜기 시도. 전용 실행 아이콘(자동재생 허용 옵션)으로 열었거나
   * 브라우저가 이 사이트의 자동재생을 허용하면 성공한다. 막혀 있으면 resume()이 끝나지 않으므로 시간 제한을 둔다.
   */
  async tryResume(timeoutMs = 800): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state === 'running') return true;
    await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
    return this.unlocked;
  }

  /** 오디오 출력 상태 변화(장치 분리, 시스템에 의한 중단 등) 감시 */
  onStateChange(fn: () => void): () => void {
    const ctx = this.ensureContext();
    ctx.addEventListener('statechange', fn);
    return () => ctx.removeEventListener('statechange', fn);
  }

  setVolume(v: number) {
    if (this.master) this.master.gain.value = v;
  }

  has(assetId: string) {
    return this.buffers.has(assetId);
  }

  durationMs(assetId: string): number {
    const b = this.buffers.get(assetId);
    return b ? Math.round(b.duration * 1000) : 0;
  }

  async load(assets: Asset[], onProgress?: (done: number, total: number) => void): Promise<LoadResult> {
    const ctx = this.ensureContext();
    const cache = 'caches' in globalThis ? await caches.open(AUDIO_CACHE) : null;
    const result: LoadResult = { loaded: [], failed: [] };
    let done = 0;
    await Promise.all(
      assets.map(async (a) => {
        try {
          if (!this.buffers.has(a.id)) {
            const bytes = await fetchWithCache(a.url, cache);
            this.buffers.set(a.id, await ctx.decodeAudioData(bytes));
          }
          result.loaded.push(a.id);
        } catch (e) {
          result.failed.push({ id: a.id, error: e instanceof Error ? e.message : String(e) });
        } finally {
          onProgress?.(++done, assets.length);
        }
      }),
    );
    return result;
  }

  /**
   * serverAt(서버 시각)에 재생되도록 예약. serverNow는 현재 서버 시각.
   * 이미 지난 시각이면 즉시 재생한다.
   */
  playAt(assetId: string, serverAt: number, serverNow: number): PlayHandle {
    const ctx = this.ensureContext();
    const buffer = this.buffers.get(assetId);
    if (!buffer) throw new Error(`음원이 준비되지 않았습니다: ${assetId}`);
    const delaySec = Math.max(0, (serverAt - serverNow) / 1000);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master!);
    src.start(ctx.currentTime + delaySec);
    this.active.add(src);
    const ended = new Promise<void>((resolve) => {
      src.onended = () => {
        this.active.delete(src);
        resolve();
      };
    });
    return {
      startAt: serverNow + delaySec * 1000,
      durationMs: Math.round(buffer.duration * 1000),
      ended,
      stop: () => src.stop(),
    };
  }

  /** 볼륨 확인용 짧은 테스트 톤 */
  testTone(durationSec = 1.5) {
    const ctx = this.ensureContext();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + durationSec);
    osc.connect(g).connect(this.master!);
    osc.start();
    osc.stop(ctx.currentTime + durationSec);
  }

  stopAll() {
    for (const s of this.active) {
      try {
        s.stop();
      } catch {
        /* 아직 시작 전이거나 이미 끝난 소스 */
      }
    }
    this.active.clear();
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      // 무음 신호를 계속 흘려 브라우저가 오디오 출력을 멈추거나 탭을 절전시키지 않게 한다
      const osc = this.ctx.createOscillator();
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      osc.connect(silent).connect(this.ctx.destination);
      osc.start();
    }
    return this.ctx;
  }
}

async function fetchWithCache(url: string, cache: Cache | null): Promise<ArrayBuffer> {
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  try {
    await cache?.put(url, res.clone());
  } catch {
    /* 캐시 저장 실패(브라우저 저장소 오류 등): 오프라인 대비만 안 될 뿐 이번 재생에는 지장 없음 */
  }
  return res.arrayBuffer();
}

export const audioEngine = new AudioEngine();
