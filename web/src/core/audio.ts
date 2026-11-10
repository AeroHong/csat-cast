import { getDownloadURL, ref } from 'firebase/storage';
import { fb } from './firebase';
import type { Asset } from './types';

export const AUDIO_CACHE = 'csat-audio-v1';

export interface LoadResult {
  loaded: string[];
  failed: { id: string; error: string }[];
}

export interface NowPlaying {
  /** 재생마다 고유 (같은 음원을 두 번 틀어도 구분) */
  key: number;
  assetId: string;
  positionSec: number;
  durationSec: number;
}

/**
 * 재생 한 번이 실제로 어떻게 나갔는지 (오디오 시계 기준).
 * 음원은 미리 전부 디코딩해 두므로 네트워크 때문에 끊기지는 않는다. 끊김은 정지 조작과 오디오 출력 멈춤뿐이다.
 */
export interface PlayEnd {
  /** 음원 중 실제로 재생한 길이 (끝까지 나갔으면 durationMs와 같음) */
  playedMs: number;
  durationMs: number;
  /** 재생하는 동안 오디오 출력이 멈춰 소리가 나지 않은 시간 (멈췄다 이어진 만큼) */
  gapMs: number;
  /** 재생 중에 생긴 일 (오디오 출력 멈춤·출력 장치 바뀜 등) */
  notes: string[];
}

export interface PlayHandle {
  /** 실제 재생이 시작될 서버 시각 (epoch ms) */
  startAt: number;
  durationMs: number;
  ended: Promise<PlayEnd>;
  /** 지금까지의 재생 결과 (재생 중에 끊을 때 바로 판정하는 용도) */
  progress(): PlayEnd;
  stop(): void;
}

/** 재생 위치 계산용: 재생 시작 때의 오디오 시계·벽시계 짝. 둘의 차이가 벌어진 만큼 출력이 멈춰 있었다 */
interface Playback {
  key: number;
  assetId: string;
  /** 재생 시작 (AudioContext 시계, 초) */
  startCtx: number;
  /** 재생 시작 (performance.now 기준, ms) */
  startPerf: number;
  durationSec: number;
  /** stop()을 부른 순간의 오디오 시계 (끝까지 갔으면 null) */
  stopCtx: number | null;
  notes: string[];
  /** 끝남 처리 (정지 즉시 또는 onended 중 먼저 오는 쪽, 한 번만) */
  finish: () => void;
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
  /** 파형 표시용 요약 (구간별 최대 진폭, 0~1). 디코딩할 때 만들어 두고 음원을 내려도 남긴다. */
  private peaksById = new Map<string, Float32Array>();
  private active = new Set<AudioBufferSourceNode>();
  /** 재생 위치 표시용: 소스별 음원·시작 시각(AudioContext 시계)·길이 */
  private playbacks = new Map<AudioBufferSourceNode, Playback>();
  private playbackSeq = 0;
  private analyser: AnalyserNode | null = null;

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

  /**
   * 방송 소리를 보낼 출력 장치 ('' = 윈도우 기본 장치). Chrome·Edge(AudioContext.setSinkId)만 지원.
   * 예약해 둔 방송 시각은 그대로이고 소리만 다른 장치로 나간다.
   */
  async setOutput(deviceId: string): Promise<void> {
    const ctx = this.ensureContext() as AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string | object };
    if (!ctx.setSinkId) return;
    if ((typeof ctx.sinkId === 'string' ? ctx.sinkId : '') === deviceId) return;
    await ctx.setSinkId(deviceId);
    // 재생 도중에 출력 장치가 바뀌면 그 방송의 일부는 다른 장치(앰프가 아닌 곳)로 나갔을 수 있다
    this.noteSounding(deviceId ? '재생 중 출력 장치가 바뀜' : '재생 중 출력 장치가 기본 장치로 바뀜');
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

  /** 파형 요약 (디코딩한 적이 있는 음원만) */
  peaks(assetId: string): Float32Array | undefined {
    return this.peaksById.get(assetId);
  }

  /** 지금 소리가 나고 있는 음원들 (예약만 되고 아직 시작 전인 것은 제외) */
  nowPlaying(): NowPlaying[] {
    const ctx = this.ctx;
    if (!ctx) return [];
    const out: NowPlaying[] = [];
    for (const p of this.playbacks.values()) {
      const pos = ctx.currentTime - p.startCtx;
      if (pos >= 0 && pos <= p.durationSec) out.push({ key: p.key, assetId: p.assetId, positionSec: pos, durationSec: p.durationSec });
    }
    return out.sort((a, b) => a.key - b.key);
  }

  /** 실시간 주파수 스펙트럼 (0~255, 저음→고음). 오디오가 없으면 false */
  frequencyData(out: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(out);
    return true;
  }

  get frequencyBins(): number {
    return this.analyser?.frequencyBinCount ?? 0;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
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
          if (!this.bytes.has(a.id)) this.bytes.set(a.id, await fetchWithCache(a, cache));
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
        if (!this.peaksById.has(assetId)) this.peaksById.set(assetId, computePeaks(buf, PEAK_BUCKETS));
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
    const startCtx = ctx.currentTime + delaySec;
    const pb: Playback = {
      key: ++this.playbackSeq,
      assetId,
      startCtx,
      startPerf: performance.now() + delaySec * 1000,
      durationSec: buffer.duration,
      stopCtx: null,
      notes: [],
      finish: () => undefined,
    };
    const ended = new Promise<PlayEnd>((resolve) => {
      let done = false;
      pb.finish = () => {
        if (done) return;
        done = true;
        resolve(this.measure(pb));
        this.active.delete(src);
        this.playbacks.delete(src);
      };
    });
    src.onended = () => pb.finish();
    src.start(startCtx);
    this.active.add(src);
    this.playbacks.set(src, pb);
    return {
      startAt: serverNow + delaySec * 1000,
      durationMs: Math.round(buffer.duration * 1000),
      ended,
      progress: () => this.measure(pb),
      stop: () => this.stopSource(src),
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

  /** 특정 음원의 재생만 정지 (시간표 줄의 [정지] 버튼) */
  stopAsset(assetId: string) {
    for (const [src, p] of this.playbacks) if (p.assetId === assetId) this.stopSource(src);
  }

  stopAll() {
    // 끝남 처리(onended)에서 재생 결과를 계산하므로 목록은 각 소스가 끝날 때 지운다
    for (const s of [...this.active]) this.stopSource(s);
  }

  /**
   * 정지한 순간의 재생 위치를 남기고 멈춘다. 끝남 이벤트(onended)는 늦게 오고,
   * 오디오 출력이 멈춰 있으면 아예 오지 않으므로 결과는 바로 확정한다.
   */
  private stopSource(src: AudioBufferSourceNode) {
    const pb = this.playbacks.get(src);
    if (pb && pb.stopCtx === null && this.ctx) pb.stopCtx = this.ctx.currentTime;
    try {
      src.stop();
    } catch {
      /* 아직 시작 전이거나 이미 끝난 소스 */
    }
    pb?.finish();
  }

  /**
   * 재생 결과 계산. 오디오 시계는 출력이 멈추면 같이 멈추므로
   * - 재생 위치 = 오디오 시계 경과 (정지했으면 정지 순간까지, 음원 길이를 넘지 않음)
   * - 멈춘 시간 = 벽시계 경과 − 오디오 시계 경과 (출력이 멈췄다 이어진 만큼 벌어짐)
   */
  private measure(pb: Playback): PlayEnd {
    const ctx = this.ctx;
    const durationMs = Math.round(pb.durationSec * 1000);
    if (!ctx) return { playedMs: 0, durationMs, gapMs: 0, notes: [...pb.notes] };
    const nowCtx = ctx.currentTime;
    const endCtx = Math.min(pb.stopCtx ?? nowCtx, pb.startCtx + pb.durationSec);
    const playedMs = Math.round(Math.max(0, endCtx - pb.startCtx) * 1000);
    // 출력이 멈춘 시간: 재생이 시작된 뒤 지금까지 벽시계와 오디오 시계의 차이 (시작 전이면 0)
    const wallMs = performance.now() - pb.startPerf;
    const ctxMs = (nowCtx - pb.startCtx) * 1000;
    const gapMs = wallMs > 0 ? Math.max(0, Math.round(wallMs - Math.max(0, ctxMs))) : 0;
    return { playedMs, durationMs, gapMs, notes: [...pb.notes] };
  }

  /** 지금 소리가 나는 재생에 사건을 적어 둔다 (재생 결과 판정에 씀) */
  private noteSounding(note: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const pb of this.playbacks.values()) {
      const pos = ctx.currentTime - pb.startCtx;
      if (pos >= 0 && pos < pb.durationSec && pb.stopCtx === null && !pb.notes.includes(note)) pb.notes.push(note);
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      // 재생 도중 오디오 출력이 멈추면(절전·장치 분리·다른 프로그램이 장치를 가져감) 그 방송에 적어 둔다
      const ctx = this.ctx;
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running') this.noteSounding('재생 중 오디오 출력이 멈춤');
      });
      // 화면의 스펙트럼 표시용 분석기. 송출 경로와 따로 갈라 두어 표시 쪽 문제가 방송 소리에 영향을 주지 않게 한다.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.75;
      this.master.connect(this.analyser);
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

const PEAK_BUCKETS = 800;

/** 파형 표시용: 전체를 n구간으로 나눠 구간별 최대 진폭(모든 채널 중 큰 값)을 구한다 */
export function computePeaks(buf: AudioBuffer, n: number): Float32Array {
  const peaks = new Float32Array(n);
  const size = Math.max(1, Math.floor(buf.length / n));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let b = 0; b < n; b++) {
      let max = peaks[b];
      const end = Math.min(data.length, (b + 1) * size);
      for (let i = b * size; i < end; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
  }
  return peaks;
}

/** 캐시 이름은 asset.url. Storage 음원은 캐시에 없을 때만 다운로드 주소를 받아 온다 (오프라인이면 캐시로만 동작) */
async function fetchWithCache(asset: Asset, cache: Cache | null): Promise<ArrayBuffer> {
  const url = asset.url;
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  if (asset.storagePath && !fb) throw new Error('서버 설정 없음');
  const res = await fetch(asset.storagePath ? await getDownloadURL(ref(fb!.storage, asset.storagePath)) : url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  try {
    await cache?.put(url, res.clone());
  } catch {
    /* 캐시 저장 실패(브라우저 저장소 오류 등): 오프라인 대비만 안 될 뿐 이번 재생에는 지장 없음 */
  }
  return res.arrayBuffer();
}

/** 음원 원본 내려받기 (재생 엔진과 같은 캐시 사용). 음원 합치기 편집기에서 쓴다 */
export async function fetchAssetBytes(asset: Asset): Promise<ArrayBuffer> {
  const cache = 'caches' in globalThis ? await caches.open(AUDIO_CACHE).catch(() => null) : null;
  return fetchWithCache(asset, cache);
}

export const audioEngine = new AudioEngine();
