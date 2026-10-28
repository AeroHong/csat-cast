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

export type SyncSource = 'api' | 'http-date' | 'none';

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

  constructor(private timeUrl = '/api/time') {}

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
      this.status = { ...this.status, error: '시각 서버에 연결할 수 없습니다 (마지막 동기화 값 사용 중)' };
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

export const serverClock = new ServerClock();
