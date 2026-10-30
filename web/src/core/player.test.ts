import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, PlayHandle } from './audio';
import type { ServerClock } from './clock';
import { PlayerController } from './player';
import type { PlannedCue } from './scheduler';

/** 소리 켜짐/꺼짐을 바꿀 수 있는 가짜 오디오. 예약·정지 기록을 남긴다. */
class FakeAudio {
  state: AudioContextState = 'running';
  played: { assetId: string; at: number }[] = [];
  stopped: string[] = [];
  private enders: (() => void)[] = [];
  /** 디코딩 완료된 음원 (기본: 즉시 디코딩됨) */
  ready = new Set<string>();
  broken = new Set<string>();
  autoDecode = true;
  prepareCalls: string[] = [];
  released: string[] = [];
  private waiters = new Map<string, () => void>();
  has(id: string) {
    return !this.broken.has(id);
  }
  isReady(id: string) {
    return this.ready.has(id);
  }
  decodeError(id: string) {
    return this.broken.has(id) ? '재생할 수 없는 음원 파일' : undefined;
  }
  prepare(id: string) {
    this.prepareCalls.push(id);
    if (this.broken.has(id)) return Promise.reject(new Error('broken'));
    if (this.autoDecode) {
      this.ready.add(id);
      return Promise.resolve();
    }
    return new Promise<void>((r) => this.waiters.set(id, () => (this.ready.add(id), r())));
  }
  /** autoDecode=false일 때 디코딩 완료 */
  finishDecode(id: string) {
    this.waiters.get(id)?.();
  }
  release(id: string) {
    this.ready.delete(id);
    this.released.push(id);
  }
  playAt(assetId: string, serverAt: number, serverNow: number): PlayHandle {
    this.played.push({ assetId, at: serverAt });
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    this.enders.push(end);
    return { startAt: Math.max(serverAt, serverNow), durationMs: 3000, ended, stop: () => (this.stopped.push(assetId), end()) };
  }
  stopAll() {}
  tryResume() {
    return Promise.resolve(this.state === 'running');
  }
  endAll() {
    this.enders.forEach((e) => e());
  }
}

class FakeClock {
  t = 0;
  now() {
    return this.t;
  }
  detectSuspend() {
    return 0;
  }
}

const cue = (id: string, kind: 'bell' | 'ment') => ({ id, time: '', period: '', label: id, kind, assetId: id });
// 타종 허용 지연 5초, 멘트 30초
const plan: PlannedCue[] = [
  { cue: cue('bell', 'bell'), at: 10_000 },
  { cue: cue('ment', 'ment'), at: 60_000 },
];

let audio: FakeAudio;
let clock: FakeClock;
let player: PlayerController;
const tick = () => (player as unknown as { tick(): void }).tick();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  audio = new FakeAudio();
  clock = new FakeClock();
  player = new PlayerController(audio as unknown as AudioEngine, clock as unknown as ServerClock);
});
afterEach(() => {
  player.disarm(false);
  vi.useRealTimers();
});

describe('소리가 꺼져 있을 때 (자동재생 차단·오디오 장치 끊김)', () => {
  it('꺼져 있는 동안은 예약하지 않고, 허용 지연 이내에 켜지면 그때 송출한다', () => {
    audio.state = 'suspended';
    player.arm(plan, 'test');
    clock.t = 11_000;
    tick();
    expect(audio.played).toHaveLength(0);
    expect(player.snapshot().states.bell).toBe('pending');

    audio.state = 'running';
    clock.t = 13_000; // 3초 지연 (타종 허용 5초 이내)
    tick();
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell']);
    expect(player.snapshot().states.bell).toBe('playing');
  });

  it('허용 지연을 넘겨 켜지면 늦게 울리지 않고 건너뜀으로 남긴다 (송출 완료로 기록하지 않음)', () => {
    audio.state = 'suspended';
    player.arm(plan, 'test');
    clock.t = 16_000; // 6초 지연
    tick();
    expect(player.snapshot().states.bell).toBe('skipped');
    expect(player.snapshot().events[0].message).toContain('소리가 꺼져 있어 송출 못함');

    audio.state = 'running';
    tick();
    expect(audio.played).toHaveLength(0);
  });

  it('예약 뒤 시작 전에 소리가 꺼지면 예약을 취소하고, 다시 켜지면 새로 예약한다', async () => {
    player.arm(plan, 'test');
    clock.t = 8_500; // 2초 앞서 예약됨
    tick();
    expect(player.snapshot().states.bell).toBe('scheduled');

    audio.state = 'suspended';
    clock.t = 9_000;
    tick();
    expect(audio.stopped).toEqual(['bell']);
    expect(player.snapshot().states.bell).toBe('pending');
    await flush(); // 취소된 예약의 종료 이벤트

    audio.state = 'running';
    clock.t = 10_500;
    tick();
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell', 'bell']);
    expect(player.snapshot().states.bell).toBe('playing');
  });

  it('취소된 예약의 종료 이벤트가 늦게 와도 새로 건 예약을 완료로 바꾸지 않는다', async () => {
    player.arm(plan, 'test');
    clock.t = 8_500;
    tick();
    audio.state = 'suspended';
    clock.t = 9_000;
    tick(); // 취소 (종료 이벤트는 아직 처리 전)
    audio.state = 'running';
    clock.t = 9_500;
    tick(); // 새 예약
    await flush();
    expect(player.snapshot().states.bell).toBe('scheduled');
  });

  it('소리가 켜져 있으면 기존처럼 예약 → 재생 → 완료', async () => {
    player.arm(plan, 'test');
    clock.t = 8_500;
    tick();
    clock.t = 10_000;
    tick();
    expect(player.snapshot().states.bell).toBe('playing');
    audio.endAll();
    await flush();
    expect(player.snapshot().states.bell).toBe('done');
  });
});

describe('음원 미리 준비 (디코딩) 와 메모리 해제', () => {
  // 3분 전부터 준비: bell(10초)은 시작하자마자, ment(60초)도 준비 대상
  const longPlan: PlannedCue[] = [
    { cue: cue('bell', 'bell'), at: 10_000 },
    { cue: cue('ment', 'ment'), at: 400_000 },
  ];

  it('송출 3분 전 안에 든 음원만 준비하고, 끝난 음원은 메모리에서 내린다', async () => {
    player.arm(longPlan, 'test');
    expect(audio.prepareCalls).toEqual(['bell']);

    clock.t = 8_500;
    tick();
    clock.t = 10_000;
    tick();
    audio.endAll();
    await flush();
    expect(player.snapshot().states.bell).toBe('done');

    clock.t = 230_000; // ment 2분 50초 전
    tick();
    expect(audio.prepareCalls).toEqual(['bell', 'ment']);
    expect(audio.released).toEqual(['bell']);
  });

  it('디코딩이 늦으면 기다렸다가 허용 지연 이내에 끝나면 송출한다', async () => {
    audio.autoDecode = false;
    player.arm(plan, 'test');
    clock.t = 10_000;
    tick();
    expect(audio.played).toHaveLength(0);
    expect(player.snapshot().states.bell).toBe('pending');

    audio.finishDecode('bell');
    await flush();
    clock.t = 11_000;
    tick();
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell']);
  });

  it('디코딩이 허용 지연을 넘기면 건너뜀으로 남기고 사유를 알린다', () => {
    audio.autoDecode = false;
    player.arm(plan, 'test');
    clock.t = 16_000;
    tick();
    expect(player.snapshot().states.bell).toBe('skipped');
    expect(player.snapshot().events[0].message).toContain('음원 준비가 늦어 송출 못함');
  });

  it('깨진 음원 파일은 재생 실패로 표시한다', async () => {
    audio.broken.add('bell');
    player.arm(plan, 'test');
    await flush();
    clock.t = 9_000;
    tick();
    expect(player.snapshot().states.bell).toBe('failed');
    expect(player.snapshot().events[0].message).toContain('음원 파일 오류');
  });

  it('수동 재생은 디코딩을 기다리는 동안에도 자동 재생과 겹치지 않는다', async () => {
    audio.autoDecode = false;
    player.arm(plan, 'test');
    const manual = player.playNow('bell');
    expect(player.snapshot().states.bell).toBe('done');
    clock.t = 10_000;
    tick();
    audio.finishDecode('bell');
    await manual;
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell']);
  });
});
