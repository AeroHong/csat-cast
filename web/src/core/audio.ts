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
  /** 내려받은 음원 원본(압축 상태). 디코딩한 PCM은 원본의 10배 이상이라 전부 올려 두지 않는다. */
  private bytes = new Map<string, ArrayBuffer>();
  /** 곧 재생할 음원만 디코딩해 둔다 (prepare → 재생 → release) */
  private buffers = new Map<string, AudioBuffer>();
  private decoding = new Map<string, Promise<AudioBuffer>>();
  private decodeErrors = new Map<string, string>();
  private durations = new Map<string, number>();
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

  /** 음원을 내려받아 두었는가 (재생하려면 prepare로 디코딩까지 끝나야 함) */
  has(assetId: string) {
    return this.bytes.has(assetId) && !this.decodeErrors.has(assetId);
  }

  /** 디코딩까지 끝나 바로 재생할 수 있는가 */
  isReady(assetId: string) {
    return this.buffers.has(assetId);
  }

  /** 디코딩 실패 사유 (깨진 파일 등) */
  decodeError(assetId: string): string | undefined {
    return this.decodeErrors.get(assetId);
  }

  durationMs(assetId: string): number {
    return this.durations.get(assetId) ?? 0;
  }

  /**
   * 음원 원본을 내려받는다 (캐시에 있으면 캐시에서). 디코딩은 하지 않으므로 캐시에 있으면 금방 끝난다.
   * 새로고침 직후 곧 울릴 방송을 놓치지 않도록, 파일이 정상인지 확인(verify)은 따로 한다.
   */
  async load(assets: Asset[], onProgress?: (done: number, total: number) => void): Promise<LoadResult> {
    this.ensureContext();
    const cache = 'caches' in globalThis ? await caches.open(AUDIO_CACHE).catch(() => null) : null;
    const result: LoadResult = { loaded: [], failed: [] };
    let done = 0;
    await Promise.all(
      assets.map(async (a) => {
        try {
          if (!this.bytes.has(a.id)) this.bytes.set(a.id, await fetchWithCache(a.url, cache));
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
   * 내려받은 음원을 하나씩 디코딩해 정상인지 확인하고 길이를 기록한다 (메모리를 아끼려 결과는 바로 버림).
   * 이미 재생 준비된 음원은 다시 디코딩하지 않는다. 실패한 음원 목록을 반환한다.
   */
  async verify(ids: string[], onProgress?: (done: number, total: number) => void): Promise<LoadResult['failed']> {
    const failed: LoadResult['failed'] = [];
    let done = 0;
    for (const id of ids) {
      try {
        if (!this.buffers.has(id) && !this.durations.has(id)) await this.decode(id);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(++done, ids.length);
    }
    return failed;
  }

  /** 곧 재생할 음원을 디코딩해 둔다. 이미 했거나 하는 중이면 그 결과를 기다린다. */
  async prepare(assetId: string): Promise<void> {
    if (this.buffers.has(assetId)) return;
    this.buffers.set(assetId, await this.decode(assetId));
  }

  /** 재생이 끝난 음원의 디코딩 결과를 메모리에서 내린다 (원본은 남겨 다시 준비할 수 있음) */
  release(assetId: string) {
    this.buffers.delete(assetId);
  }

  /** 즉시 재생 (수동 재생·시험 재생용). 디코딩이 안 되어 있으면 먼저 한다. */
  async playNow(assetId: string): Promise<PlayHandle> {
    await this.prepare(assetId);
    return this.playAt(assetId, 0, 0);
  }

  private decode(assetId: string): Promise<AudioBuffer> {
    const pending = this.decoding.get(assetId);
    if (pending) return pending;
    const bytes = this.bytes.get(assetId);
    if (!bytes) return Promise.reject(new Error(`음원을 내려받지 못했습니다: ${assetId}`));
    // decodeAudioData는 넘긴 ArrayBuffer를 비우므로 복사본을 넘긴다
    const p = this.ensureContext()
      .decodeAudioData(bytes.slice(0))
      .then((buf) => {
        this.durations.set(assetId, Math.round(buf.duration * 1000));
        this.decodeErrors.delete(assetId);
        return buf;
      })
      .catch((e: unknown) => {
        const msg = `재생할 수 없는 음원 파일 (${e instanceof Error ? e.message : String(e)})`;
        this.decodeErrors.set(assetId, msg);
        throw new Error(msg);
      })
      .finally(() => this.decoding.delete(assetId));
    this.decoding.set(assetId, p);
    return p;
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
