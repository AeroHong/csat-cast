/**
 * 서버 시각 동기화.
 *
 * 시각은 performance.timeOrigin + performance.now() (단조 증가) 위에 서버와의 차이(offset)를 더해 계산한다.
 * 그래서 방송 도중 누군가 PC 시계를 바꿔도 재생 시각은 흔들리지 않는다.
 */

export interface TimeSample {
  /** 요청 보낸 시각 (로컬 단조 시계 ms) */
  t0: number;
  /** 서버가 응답한 시각 (epoch ms) */
  server: number;
  /** 응답 받은 시각 (로컬 단조 시계 ms) */
  t1: number;
}

/** NTP 방식: 왕복시간(RTT)이 가장 짧은 샘플이 가장 정확하다. */
export function bestOffset(samples: TimeSample[]): { offset: number; rtt: number } | null {
  if (samples.length === 0) return null;
  let best = samples[0];
  for (const s of samples) if (s.t1 - s.t0 < best.t1 - best.t0) best = s;
  const rtt = best.t1 - best.t0;
  return { offset: best.server - (best.t0 + rtt / 2), rtt };
}

export const monotonicNow = (): number => performance.timeOrigin + performance.now();

/** cached: 서버 연결 없이 마지막으로 저장한 보정값을 사용 중 (PC 시계를 바꾸지 않았다면 정확) */
export type SyncSource = 'api' | 'http-date' | 'cached' | 'none';

export interface ClockStatus {
  synced: boolean;
  source: SyncSource;
  offsetMs: number;
  rttMs: number;
  /** 마지막 동기화 성공 시각 (서버 epoch ms) */
  lastSyncAt: number | null;
  /** PC 시계(Date.now)와 서버 시각의 차이 */
  osClockDriftMs: number;
  error?: string;
}

export const OS_DRIFT_WARN_MS = 30_000;
export const OFFSET_JUMP_WARN_MS = 1_000;
/** 벽시계가 단조 시계보다 이만큼 더 흘렀으면 PC가 절전/일시정지되었던 것으로 본다 */
export const SUSPEND_DETECT_MS = 2_000;

const CACHE_KEY = 'csat-cast:clock';

/** 저장 형식: 서버시각 - PC시각. PC 시계를 바꾸지 않는 한 재시작 후에도 유효하다. */
interface ClockCache {
  serverMinusWall: number;
  savedAt: number;
}

export class ServerClock {
  private offset = 0;
  private status: ClockStatus = {
    synced: false,
    source: 'none',
    offsetMs: 0,
    rttMs: 0,
    lastSyncAt: null,
    osClockDriftMs: 0,
  };
  private listeners = new Set<(s: ClockStatus) => void>();
  private lastWall = Date.now();
  private lastMono = monotonicNow();

  constructor(private timeUrl = '/api/time') {
    const cache = readCache();
    if (cache) {
      // 단조 시계 기준 offset으로 환산
      this.offset = Date.now() + cache.serverMinusWall - monotonicNow();
      this.status = { ...this.status, source: 'cached', offsetMs: Math.round(this.offset), lastSyncAt: cache.savedAt };
    }
  }

  /** 서버 시각으로 믿고 쓸 수 있는 상태인가 (실시간 동기화 또는 저장된 보정값) */
  get usable(): boolean {
    return this.status.synced || this.status.source === 'cached';
  }

  /**
   * PC 절전·일시정지 감지. 주기적으로 호출하면, 벽시계가 단조 시계보다 크게 앞서 나간 경우
   * (일부 환경에서 절전 중 performance.now()가 멈춤) 그 차이(ms)를 반환하고 즉시 재동기화한다.
   */
  detectSuspend(): number {
    const wall = Date.now();
    const mono = monotonicNow();
    const gap = wall - this.lastWall - (mono - this.lastMono);
    this.lastWall = wall;
    this.lastMono = mono;
    if (Math.abs(gap) <= SUSPEND_DETECT_MS) return 0;
    // 저장된 보정값으로 즉시 복구한 뒤 서버와 다시 맞춘다
    const cache = readCache();
    if (cache) this.offset = Date.now() + cache.serverMinusWall - monotonicNow();
    void this.sync();
    return gap;
  }

  /** 서버 기준 현재 시각 (epoch ms) */
  now(): number {
    return monotonicNow() + this.offset;
  }

  getStatus(): ClockStatus {
    return { ...this.status, osClockDriftMs: Date.now() - this.now() };
  }

  subscribe(fn: (s: ClockStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 오프셋이 이만큼 급변했으면 경고 (true 반환) */
  async sync(samples = 8): Promise<{ jumpWarning: boolean }> {
    const prev = this.status.synced ? this.offset : null;
    let result = await this.syncFromApi(samples).catch(() => null);
    let source: SyncSource = 'api';
    if (!result) {
      result = await this.syncFromHttpDate().catch(() => null);
      source = 'http-date';
    }
    if (!result) {
      // 오프라인: 마지막 offset을 유지하고 상태만 갱신
      this.status = {
        ...this.status,
        error: this.usable
          ? '시각 서버에 연결할 수 없습니다 (저장된 보정값 사용 중)'
          : '시각 서버에 연결할 수 없습니다 (PC 시계 사용 중)',
      };
      this.emit();
      return { jumpWarning: false };
    }
    this.offset = result.offset;
    this.status = {
      synced: true,
      source,
      offsetMs: Math.round(result.offset),
      rttMs: Math.round(result.rtt),
      lastSyncAt: this.now(),
      osClockDriftMs: 0,
    };
    writeCache({ serverMinusWall: this.now() - Date.now(), savedAt: this.now() });
    this.emit();
    return { jumpWarning: prev !== null && Math.abs(prev - result.offset) > OFFSET_JUMP_WARN_MS };
  }

  private async syncFromApi(n: number) {
    const samples: TimeSample[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = monotonicNow();
      const res = await fetch(`${this.timeUrl}?_=${Math.random()}`, { cache: 'no-store' });
      const t1 = monotonicNow();
      if (!res.ok) throw new Error(`time api ${res.status}`);
      const body = (await res.json()) as { now: number };
      if (typeof body.now !== 'number') throw new Error('bad time payload');
      samples.push({ t0, server: body.now, t1 });
    }
    return bestOffset(samples);
  }

  /** 대체 수단: 웹서버 응답의 Date 헤더 (초 단위 정밀도) */
  private async syncFromHttpDate() {
    const t0 = monotonicNow();
    const res = await fetch(`/?_=${Math.random()}`, { method: 'HEAD', cache: 'no-store' });
    const t1 = monotonicNow();
    const date = res.headers.get('date');
    if (!date) throw new Error('no date header');
    // 초 단위로 잘린 값이므로 평균 +500ms 보정
    return bestOffset([{ t0, server: Date.parse(date) + 500, t1 }]);
  }

  private emit() {
    const s = this.getStatus();
    for (const fn of this.listeners) fn(s);
  }
}

function readCache(): ClockCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as ClockCache) : null;
    return c && Number.isFinite(c.serverMinusWall) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(c: ClockCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* 저장소 사용 불가 */
  }
}

export const serverClock = new ServerClock();
