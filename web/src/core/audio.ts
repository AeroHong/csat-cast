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
  private keepAlive: OscillatorNode | null = null;

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** 반드시 사용자 클릭 이벤트 안에서 호출해야 한다 (브라우저 자동재생 정책). */
  async unlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') await ctx.resume();
    if (!this.keepAlive) {
      const osc = ctx.createOscillator();
      const silent = ctx.createGain();
      silent.gain.value = 0;
      osc.connect(silent).connect(ctx.destination);
      osc.start();
      this.keepAlive = osc;
    }
    return this.unlocked;
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
    }
    return this.ctx;
  }
}

async function fetchWithCache(url: string, cache: Cache | null): Promise<ArrayBuffer> {
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  await cache?.put(url, res.clone());
  return res.arrayBuffer();
}

export const audioEngine = new AudioEngine();
