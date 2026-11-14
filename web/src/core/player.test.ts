import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, PlayEnd, PlayHandle } from './audio';
import type { ServerClock } from './clock';
import { judgePlay, PlayerController } from './player';
import { outcomesFrom, summarize } from './runReports';
import type { PlannedCue } from './scheduler';

/** 소리 켜짐/꺼짐을 바꿀 수 있는 가짜 오디오. 예약·정지 기록을 남긴다. */
class FakeAudio {
  state: AudioContextState = 'running';
  played: { assetId: string; at: number }[] = [];
  stopped: string[] = [];
  /** 진행 중인 재생 (끝내면 결과를 넘긴다) */
  private plays: { assetId: string; end: (e: PlayEnd) => void; done: boolean }[] = [];
  /** 정지하거나 중간 판정할 때의 재생 위치(ms). 음원 길이는 3000ms */
  position = 1000;
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
    let resolve!: (e: PlayEnd) => void;
    const ended = new Promise<PlayEnd>((r) => (resolve = r));
    const play = {
      assetId,
      done: false,
      end: (e: PlayEnd) => {
        if (play.done) return;
        play.done = true;
        resolve(e);
      },
    };
    this.plays.push(play);
    const progress = (): PlayEnd => ({ playedMs: this.position, durationMs: 3000, gapMs: 0, notes: [] });
    return {
      startAt: Math.max(serverAt, serverNow),
      durationMs: 3000,
      ended,
      progress,
      stop: () => {
        this.stopped.push(assetId);
        play.end(progress());
      },
    };
  }
  stopAsset(assetId: string) {
    for (const p of this.plays) if (p.assetId === assetId && !p.done) (this.stopped.push(assetId), p.end({ playedMs: this.position, durationMs: 3000, gapMs: 0, notes: [] }));
  }
  stopAll() {
    for (const p of this.plays) if (!p.done) p.end({ playedMs: this.position, durationMs: 3000, gapMs: 0, notes: [] });
  }
  tryResume() {
    return Promise.resolve(this.state === 'running');
  }
  /** 대기 중 출력 쉬기 */
  resting = false;
  busy = false;
  restCalls = 0;
  /** false면 다시 켜기에 실패한다 (자동재생 차단 등) */
  wakeWorks = true;
  rest() {
    if (this.resting || this.busy || this.state !== 'running') return Promise.resolve(false);
    this.restCalls++;
    this.resting = true;
    this.state = 'suspended';
    return Promise.resolve(true);
  }
  wake() {
    if (!this.resting) return Promise.resolve(this.state === 'running');
    this.resting = false;
    if (this.wakeWorks) this.state = 'running';
    return Promise.resolve(this.state === 'running');
  }
  /** 진행 중인 재생을 모두 끝낸다 (기본: 끝까지 끊김 없이) */
  endAll(over: Partial<PlayEnd> = {}) {
    for (const p of this.plays) if (!p.done) p.end({ playedMs: 3000, durationMs: 3000, gapMs: 0, notes: [], ...over });
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

describe('자동 방송 시작 알림', () => {
  it('첫 방송이 한참 뒤여도 시작하자마자 구독자에게 진행 중 상태를 알린다', () => {
    const seen: boolean[] = [];
    player.subscribe((s) => seen.push(s.armed));
    player.arm([{ cue: cue('later', 'ment'), at: 3_600_000 }], 'test', { date: '2026-11-10' });
    expect(seen.at(-1)).toBe(true);
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

describe('본령이 늦으면 그 시험의 뒤 방송을 늦춘다 (시험 시간 보장)', () => {
  // 0초 본령 → 60초 종료 5분 전 → 120초 종료령 → 200초 다음 교시 예비령
  const exam: PlannedCue[] = [
    { cue: { ...cue('start', 'bell'), examStart: true }, at: 0 },
    { cue: cue('5min', 'ment'), at: 60_000 },
    { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
    { cue: cue('next', 'ment'), at: 200_000 },
  ];
  const at = (id: string) => player.snapshot().plan.find((p) => p.cue.id === id)!.at;

  it('본령이 3초 늦게 울리면 종료령까지 3초 늦추고, 다음 교시는 그대로', () => {
    audio.state = 'suspended';
    player.arm(exam, 'test');
    audio.state = 'running';
    clock.t = 3_000;
    tick();
    expect(audio.played).toEqual([{ assetId: 'start', at: 0 }]);
    expect([at('5min'), at('end'), at('next')]).toEqual([63_000, 123_000, 200_000]);
    expect(player.snapshot().delays).toEqual({ '5min': 3_000, end: 3_000 });
    expect(player.snapshot().events[0].message).toContain('3초 늦춥니다');
  });

  it('제시각에 울리면 아무것도 늦추지 않는다', () => {
    player.arm(exam, 'test');
    tick();
    expect(at('end')).toBe(120_000);
    expect(player.snapshot().delays).toEqual({});
  });

  it('본령을 놓쳐 담당자가 [지금 재생]으로 울리면 그때를 시험 시작으로 본다', async () => {
    audio.state = 'suspended';
    player.arm(exam, 'test');
    audio.state = 'running';
    clock.t = 20_000; // 타종 허용 5초를 넘겨 자동 송출은 건너뜀
    tick();
    expect(player.snapshot().states.start).toBe('skipped');
    await player.playNow('start');
    expect(at('end')).toBe(140_000);
  });

  it('새로고침해도 늦춘 시각을 이어받는다', () => {
    player.arm(exam, 'test', { restore: { start: 'done' }, starts: { start: 3_000 } });
    expect(at('end')).toBe(123_000);
  });

  it('합본(첫 번째 종료 + 두 번째 시작)이 늦으면 두 번째 시험의 뒤 방송도 늦춘다', () => {
    const two: PlannedCue[] = [
      { cue: { ...cue('t1', 'bell'), examStart: true }, at: 0 },
      { cue: { ...cue('combo', 'bell'), examEnd: true, examStart: true, lateToleranceSec: 600 }, at: 100_000 },
      { cue: cue('t2-5min', 'ment'), at: 200_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 300_000 },
    ];
    audio.state = 'suspended';
    player.arm(two, 'test');
    audio.state = 'running';
    clock.t = 2_000;
    tick(); // 첫 번째 본령 2초 늦음 → 합본도 102초로
    expect(at('combo')).toBe(102_000);
    audio.state = 'suspended';
    clock.t = 150_000;
    tick();
    audio.state = 'running';
    tick(); // 합본이 48초 더 늦게(150초) 처음부터 송출 → 두 번째 시험 뒤 방송 50초 늦춤
    expect(audio.played.at(-1)).toEqual({ assetId: 'combo', at: 102_000 });
    expect(player.snapshot().states.combo).toBe('playing');
    expect([at('t2-5min'), at('end')]).toEqual([250_000, 350_000]);
  });
});

describe('관리자 화면 보고용 기록 (실제 시작 시각·수동 송출)', () => {
  it('자동 송출은 실제 시작 시각을 남긴다', async () => {
    player.arm(plan, 'test');
    await flush();
    clock.t = 9_000;
    tick();
    expect(player.snapshot().startedAt.bell).toBe(10_000);
    expect(player.snapshot().manual).toEqual([]);
  });

  it('건너뛴 방송을 [지금 재생]으로 내보내면 수동 송출로 바뀐다', async () => {
    player.arm(plan, 'test');
    clock.t = 20_000; // 타종 허용 5초 초과 → 건너뜀
    tick();
    expect(player.snapshot().states.bell).toBe('skipped');
    await player.playNow('bell');
    const s = player.snapshot();
    expect(s.states.bell).toBe('done');
    expect(s.manual).toEqual(['bell']);
    expect(s.startedAt.bell).toBe(20_000);
  });

  it('이미 송출된 방송은 [지금 재생]으로도 다시 나가지 않고, 송출 기록도 그대로', async () => {
    player.arm(plan, 'test');
    await flush();
    clock.t = 9_000;
    tick();
    audio.endAll();
    await flush();
    expect(player.snapshot().states.bell).toBe('done');
    const played = audio.played.length;
    clock.t = 30_000;
    await player.playNow('bell');
    expect(audio.played.length).toBe(played);
    expect(player.snapshot().events[0].message).toContain('이미 송출한 방송');
    expect(player.snapshot().manual).toEqual([]);
    expect(player.snapshot().startedAt.bell).toBe(10_000);
  });

  it('이미 울린 본령을 다시 눌러도 시험 시간(종료령)을 늦추지 않는다', async () => {
    const exam: PlannedCue[] = [
      { cue: { ...cue('start', 'bell'), examStart: true }, at: 0 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
    ];
    player.arm(exam, 'test');
    tick();
    audio.endAll();
    await flush();
    clock.t = 30_000;
    await player.playNow('start');
    expect(player.snapshot().plan.find((p) => p.cue.id === 'end')!.at).toBe(120_000);
  });
});

describe('담당자가 시험 종료를 늦춘다 (영어 듣기평가가 늦게 시작된 경우 등)', () => {
  const at = (id: string) => player.snapshot().plan.find((p) => p.cue.id === id)!.at;

  it('본령 타종이 없는 시험(영어): 남은 종료 10분 전·종료령만 늦추고 다음 교시는 그대로', async () => {
    const eng: PlannedCue[] = [
      { cue: cue('ready', 'ment'), at: 0 }, // 준비령 → 듣기평가로 이어짐 (본령 타종 없음)
      { cue: cue('10min', 'ment'), at: 60_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
      { cue: cue('next', 'ment'), at: 400_000 },
    ];
    player.arm(eng, 'test');
    tick();
    audio.endAll();
    await flush();
    expect(player.currentExam()!.end.cue.id).toBe('end');
    expect(player.delayExam('end', 120_000)).toBe(240_000);
    expect([at('ready'), at('10min'), at('end'), at('next')]).toEqual([0, 180_000, 240_000, 400_000]);
    expect(player.snapshot().examDelays.end.ms).toBe(120_000);
    expect(player.snapshot().events[0].message).toContain('2분 늦춤');
    // 원래 시각(120초)에는 종료령이 나가지 않는다
    clock.t = 125_000;
    tick();
    expect(audio.played.map((p) => p.assetId)).not.toContain('end');
  });

  it('여러 번 누르면 더해지고, 되돌리면 원래 시각으로', () => {
    const exam: PlannedCue[] = [
      { cue: cue('10min', 'ment'), at: 60_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
    ];
    player.arm(exam, 'test');
    player.delayExam('end', 60_000);
    player.delayExam('end', 30_000);
    expect(at('end')).toBe(210_000);
    player.delayExam('end', -90_000);
    expect(at('end')).toBe(120_000);
    expect(player.snapshot().examDelays).toEqual({});
  });

  it('본령 전에 늦추면 본령도 늦게 울리고, 그 때문에 종료령을 한 번 더 늦추지는 않는다', () => {
    const exam: PlannedCue[] = [
      { cue: { ...cue('start', 'bell'), examStart: true }, at: 10_000 },
      { cue: cue('5min', 'ment'), at: 60_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
    ];
    player.arm(exam, 'test');
    player.delayExam('end', 60_000);
    expect([at('start'), at('5min'), at('end')]).toEqual([70_000, 120_000, 180_000]);
    clock.t = 70_000;
    tick(); // 늦춘 시각에 제대로 울림
    expect(audio.played.at(-1)).toEqual({ assetId: 'start', at: 70_000 });
    expect(at('end')).toBe(180_000);
  });

  it('합본(첫 번째 종료 + 두 번째 시작)까지 늦추면 두 번째 시험도 같이 늦춘다', () => {
    const two: PlannedCue[] = [
      { cue: cue('t1-5min', 'ment'), at: 60_000 },
      { cue: { ...cue('combo', 'bell'), examEnd: true, examStart: true, lateToleranceSec: 600 }, at: 100_000 },
      { cue: cue('t2-5min', 'ment'), at: 200_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 300_000 },
    ];
    player.arm(two, 'test');
    player.delayExam('combo', 30_000);
    expect([at('t1-5min'), at('combo'), at('t2-5min'), at('end')]).toEqual([90_000, 130_000, 230_000, 330_000]);
  });

  it('이미 나간 종료령의 시험은 늦출 수 없고, 다음 시험이 대상이 된다', async () => {
    const exam: PlannedCue[] = [
      { cue: { ...cue('end1', 'bell'), examEnd: true }, at: 0 },
      { cue: { ...cue('end2', 'bell'), examEnd: true }, at: 100_000 },
    ];
    player.arm(exam, 'test');
    tick();
    audio.endAll();
    await flush();
    expect(player.delayExam('end1', 60_000)).toBeNull();
    expect(player.currentExam()!.end.cue.id).toBe('end2');
  });

  it('새로고침(이어하기)해도 늦춘 시각을 이어받는다', () => {
    const exam: PlannedCue[] = [
      { cue: cue('10min', 'ment'), at: 60_000 },
      { cue: { ...cue('end', 'bell'), examEnd: true }, at: 120_000 },
    ];
    player.arm(exam, 'test', { examDelays: { end: { ms: 60_000, fromAt: 60_000 } } });
    expect([at('10min'), at('end')]).toEqual([120_000, 180_000]);
  });
});

describe('끝까지 정상으로 나갔는지 판정 (중간 끊김·끊김 있음·담당자 정지)', () => {
  /** bell(10초) 재생을 시작시킨다 */
  async function startBell() {
    player.arm(plan, 'test');
    await flush();
    clock.t = 9_000;
    tick();
    clock.t = 10_500;
    tick();
    expect(player.snapshot().states.bell).toBe('playing');
  }

  it('음원 끝까지 끊김 없이 나가야 정상', async () => {
    await startBell();
    audio.endAll();
    await flush();
    const s = player.snapshot();
    expect(s.states.bell).toBe('done');
    expect(s.issues).toEqual({});
    expect(s.events[0].message).toContain('송출 완료');
  });

  it('재생 중 소리가 멈췄다 이어지면 끝까지 나갔어도 "끊김 있음"', async () => {
    await startBell();
    audio.endAll({ gapMs: 2_400, notes: ['재생 중 오디오 출력이 멈춤'] });
    await flush();
    const s = player.snapshot();
    expect(s.issues.bell.kind).toBe('gap');
    expect(s.issues.bell.detail).toContain('2.4초 동안 소리 멈춤');
    expect(s.events[0].message).not.toContain('송출 완료');
    expect(outcomesFrom(s, false)[0].outcome).toBe('gap');
  });

  it('재생 중 출력 장치가 바뀌면 "끊김 있음"으로 남긴다', async () => {
    await startBell();
    audio.endAll({ notes: ['재생 중 출력 장치가 기본 장치로 바뀜'] });
    await flush();
    expect(player.snapshot().issues.bell.kind).toBe('gap');
  });

  it('시간표 [정지]로 멈추면 "담당자 정지" — 송출 완료로 기록하지 않고, 사고로 세지도 않는다', async () => {
    await startBell();
    audio.position = 1_200;
    player.stopCue('bell');
    await flush();
    const s = player.snapshot();
    expect(s.states.bell).toBe('done');
    expect(s.issues.bell).toMatchObject({ kind: 'stopped', playedMs: 1_200 });
    expect(s.issues.bell.detail).toContain('3.0초 중 1.2초에서 멈춤');
    const out = outcomesFrom(s, true, true);
    expect(out[0].outcome).toBe('userCut');
    expect(summarize({ id: '1', mode: 'test', label: '', startedAt: 0, endedAt: 1, cues: out.slice(0, 1), incidents: [] }).ok).toBe(true);
  });

  it('[모든 재생 정지]도 담당자 정지', async () => {
    await startBell();
    player.stopAll();
    await flush();
    expect(player.snapshot().issues.bell.kind).toBe('stopped');
  });

  it('재생 중 자동 방송을 중지하면 그 자리에서 판정한다 (결과 기록이 바로 만들어지므로)', async () => {
    await startBell();
    player.disarm(true);
    const s = player.snapshot();
    expect(s.states.bell).toBe('done');
    expect(s.issues.bell.kind).toBe('stopped');
    expect(outcomesFrom(s, true, true)[0].outcome).toBe('userCut');
  });

  it('담당자 조작이 아닌 이유로 멈추면(날짜 바뀜 등) "중간 끊김"', async () => {
    await startBell();
    player.disarm(false);
    expect(player.snapshot().issues.bell.kind).toBe('cut');
  });

  it('재생 중 창이 닫히거나 새로고침되면, 이어하기에서 그 방송을 "중간 끊김"으로 남긴다', () => {
    clock.t = 11_000;
    player.arm(plan, 'test', { restore: { bell: 'playing' } });
    const s = player.snapshot();
    expect(s.states.bell).toBe('done');
    expect(s.issues.bell.kind).toBe('cut');
    expect(outcomesFrom(s, false)[0].outcome).toBe('cut');
  });

  it('이어하기에서 저장된 판정을 그대로 이어받는다 (새로고침해도 정상으로 바뀌지 않음)', () => {
    clock.t = 20_000;
    const issue = { kind: 'gap' as const, playedMs: 3000, durationMs: 3000, gapMs: 1500, detail: 'x' };
    player.arm(plan, 'test', { restore: { bell: 'done' }, issues: { bell: issue } });
    expect(player.snapshot().issues.bell).toEqual(issue);
  });

  it('[지금 재생]으로 내보낸 방송도 끝까지 나갔는지 본다', async () => {
    player.arm(plan, 'test');
    clock.t = 20_000; // 타종 허용 5초 초과 → 건너뜀
    tick();
    await player.playNow('bell');
    audio.position = 500;
    player.stopCue('bell');
    await flush();
    const s = player.snapshot();
    expect(s.issues.bell.kind).toBe('stopped');
    expect(outcomesFrom(s, true)[0].outcome).toBe('userCut');
  });

  it('소리 나기 전에 취소된 예약(소리 꺼짐)은 판정하지 않고 다시 예약한다', async () => {
    player.arm(plan, 'test');
    clock.t = 8_500;
    tick();
    audio.state = 'suspended';
    tick();
    await flush();
    expect(player.snapshot().states.bell).toBe('pending');
    expect(player.snapshot().issues).toEqual({});
  });
});

describe('judgePlay', () => {
  const end = (o: Partial<PlayEnd>): PlayEnd => ({ playedMs: 60_000, durationMs: 60_000, gapMs: 0, notes: [], ...o });
  it('시계 단위 오차(0.3초·0.7초 미만)는 정상', () => {
    expect(judgePlay(end({ playedMs: 59_800, gapMs: 600 }), false)).toBeNull();
  });
  it('끝까지 안 나가면 중간 끊김(담당자가 멈췄으면 담당자 정지)', () => {
    expect(judgePlay(end({ playedMs: 30_000 }), false)!.kind).toBe('cut');
    expect(judgePlay(end({ playedMs: 30_000 }), true)!.kind).toBe('stopped');
  });
  it('소리가 멈췄던 시간이 있으면 끊김 있음', () => {
    expect(judgePlay(end({ gapMs: 700 }), false)!.kind).toBe('gap');
  });
});

describe('대기 중 출력 쉬기', () => {
  // 다음 방송까지 5분씩 비는 계획
  const sparse: PlannedCue[] = [
    { cue: cue('bell', 'bell'), at: 300_000 },
    { cue: cue('ment', 'ment'), at: 600_000 },
  ];
  const watchdog = () => (player as unknown as { watchdog(): boolean }).watchdog();
  const pastGrace = () => ((player as unknown as { wokeAt: number }).wokeAt = -Infinity);

  it('설정이 꺼져 있으면 쉬지 않는다 (기존 동작)', async () => {
    player.arm(sparse, 'test');
    tick();
    await flush();
    expect(audio.restCalls).toBe(0);
    expect(player.snapshot().outputResting).toBe(false);
  });

  it('다음 방송까지 2분 넘게 남으면 쉬고, 60초 전에 다시 켜서 정시에 송출한다', async () => {
    player.setIdleRest(true);
    player.arm(sparse, 'test');
    tick();
    await flush();
    expect(audio.resting).toBe(true);
    expect(player.snapshot().outputResting).toBe(true);
    // 쉬는 중에는 '출력 꺼짐' 경보를 띄우지 않는다
    watchdog();
    expect(player.snapshot().alarms).toEqual([]);

    clock.t = 239_000; // 다음 방송 61초 전: 아직 쉼
    tick();
    expect(audio.resting).toBe(true);
    clock.t = 240_000; // 60초 전: 다시 켬
    tick();
    await flush();
    expect(audio.resting).toBe(false);
    expect(audio.state).toBe('running');

    clock.t = 298_500;
    tick();
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell']);
    expect(player.snapshot().alarms).toEqual([]);
  });

  it('다음 방송이 2분 안이면 쉬지 않는다', async () => {
    player.setIdleRest(true);
    player.arm([{ cue: cue('bell', 'bell'), at: 100_000 }], 'test');
    tick();
    await flush();
    expect(audio.restCalls).toBe(0);
  });

  it('소리가 나는 중에는 쉬지 않는다', async () => {
    player.setIdleRest(true);
    audio.busy = true;
    player.arm(sparse, 'test');
    tick();
    await flush();
    expect(audio.restCalls).toBe(0);
  });

  it('다시 켜기에 실패하면 잠깐 기다린 뒤 출력 꺼짐 경보를 띄운다', async () => {
    player.setIdleRest(true);
    player.arm(sparse, 'test');
    tick();
    await flush();
    audio.wakeWorks = false;
    clock.t = 240_000;
    tick();
    await flush();
    watchdog();
    expect(player.snapshot().alarms).toEqual([]); // 켜지기를 기다리는 중
    pastGrace();
    watchdog();
    expect(player.snapshot().alarms.length).toBe(1);
  });

  it('설정을 끄거나 자동 방송을 멈추면 바로 다시 켠다', async () => {
    player.setIdleRest(true);
    player.arm(sparse, 'test');
    tick();
    await flush();
    player.setIdleRest(false);
    await flush();
    expect(audio.resting).toBe(false);

    player.setIdleRest(true);
    await flush();
    expect(audio.resting).toBe(true);
    player.disarm();
    await flush();
    expect(audio.resting).toBe(false);
  });

  it('쉬는 중에 수동 재생하면 출력을 켜고 재생한다', async () => {
    player.setIdleRest(true);
    player.arm(sparse, 'test');
    tick();
    await flush();
    await player.playNow('bell');
    expect(audio.resting).toBe(false);
    expect(audio.played.map((p) => p.assetId)).toEqual(['bell']);
  });
});
