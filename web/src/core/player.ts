import { audioEngine, type AudioEngine, type PlayHandle } from './audio';
import { serverClock, type ServerClock } from './clock';
import type { Reporter } from './reporter';
import { restoreStates } from './runStore';
import { decide, nextPending, type CueState, type PlannedCue } from './scheduler';
import { startTicker } from './ticker';
import type { RunMode } from './types';

export interface PlayerEvent {
  at: number;
  cueId?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PlayerSnapshot {
  armed: boolean;
  mode: RunMode | 'idle';
  plan: PlannedCue[];
  states: Record<string, CueState>;
  playing: string[];
  events: PlayerEvent[];
  /** 지금 해결이 필요한 문제 (상태판에 빨간색으로 표시) */
  alarms: string[];
  /** 자동 방송 중인 날짜 (KST). 리허설은 null */
  runDate: string | null;
}

const TICK_MS = 250;
const WATCHDOG_MS = 1_000;
/** 타이머가 이보다 오래 멈췄으면 경고 (PC 과부하·절전 등) */
const STALL_WARN_MS = 3_000;

export const ALARM_AUDIO_OFF = '오디오 출력이 꺼져 있음 — 방송 PC 화면을 클릭하세요';

/**
 * 자동 방송 진행기. 계획(plan)을 받아 시각에 맞춰 음원을 재생하고 결과를 보고한다.
 * UI와 분리되어 있어 화면이 다시 그려져도 재생 상태가 유지된다.
 */
export class PlayerController {
  private plan: PlannedCue[] = [];
  private states: Record<string, CueState> = {};
  private handles = new Map<string, PlayHandle>();
  private events: PlayerEvent[] = [];
  private mode: RunMode | 'idle' = 'idle';
  private stopTicker: (() => void) | null = null;
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private alarms = new Set<string>();
  private runDate: string | null = null;
  private lastTick = 0;
  private lastWatchdog = 0;
  private stoppedByUser = false;
  reporter: Reporter | null = null;

  constructor(
    private audio: AudioEngine = audioEngine,
    private clock: ServerClock = serverClock,
  ) {}

  /**
   * 자동 방송 시작.
   * @param opts.restore 저장된 진행 상태 (새로고침 후 이어하기)
   * @param opts.date 실제 날짜 자동 방송이면 그 날짜, 리허설이면 생략
   */
  arm(plan: PlannedCue[], mode: RunMode, opts: { restore?: Record<string, CueState>; date?: string } = {}) {
    this.disarm(false);
    this.plan = plan;
    this.mode = mode;
    this.runDate = opts.date ?? null;
    this.stoppedByUser = false;
    const now = this.clock.now();
    this.states = restoreStates(plan, opts.restore, now);
    const v = Object.values(this.states);
    const label = mode === 'live' ? '실전' : '테스트';
    if (opts.restore) {
      this.push('warn', `${label} 자동 방송 이어서 진행 (이미 송출 ${v.filter((s) => s === 'done').length}개 유지)`);
    } else {
      this.push('info', `${label} 자동 방송 시작 (방송 ${plan.length}개)`);
    }
    const skipped = plan.filter(({ cue }) => this.states[cue.id] === 'skipped' && opts.restore?.[cue.id] !== 'skipped').length;
    if (skipped) this.push('warn', `이미 시각이 지난 방송 ${skipped}개는 건너뜁니다`);
    this.lastTick = performance.now();
    this.stopTicker = startTicker(TICK_MS, () => this.tick());
    this.tick();
  }

  /** @param byUser 담당자가 직접 중지한 경우 true (같은 날 자동 재시작 안 함) */
  disarm(byUser = true) {
    this.stopTicker?.();
    this.stopTicker = null;
    if (this.mode !== 'idle') {
      this.push(byUser ? 'warn' : 'info', '자동 방송 중지');
      this.stoppedByUser = byUser;
    }
    this.audio.stopAll();
    this.handles.clear();
    this.alarms.clear();
    this.mode = 'idle';
    this.emit();
  }

  get wasStoppedByUser() {
    return this.stoppedByUser;
  }

  get armed() {
    return this.stopTicker !== null;
  }

  /** 수동 비상 재생: 해당 큐 음원을 지금 즉시 재생 */
  playNow(cueId: string) {
    const item = this.plan.find((p) => p.cue.id === cueId);
    if (!item) return;
    const now = this.clock.now();
    try {
      const h = this.audio.playAt(item.cue.assetId, now, now);
      this.push('info', `수동 재생: ${item.cue.label}`, cueId);
      this.handles.set(`manual-${cueId}-${now}`, h);
      void h.ended.then(() => this.emit());
      // 수동으로 재생한 큐는 자동 재생 대상에서 뺀다 (중복 방지)
      if (this.states[cueId] === 'pending') this.states[cueId] = 'done';
      this.reporter?.log({
        cueId,
        label: item.cue.label,
        mode: this.mode === 'idle' ? 'test' : this.mode,
        scheduledAt: item.at,
        startedAt: now,
        driftMs: now - item.at,
        result: 'manual',
      });
    } catch (e) {
      this.push('error', `수동 재생 실패: ${(e as Error).message}`, cueId);
    }
    this.emit();
  }

  stopAll() {
    this.audio.stopAll();
    this.handles.clear();
    this.push('warn', '모든 재생 정지');
    this.emit();
  }

  subscribe(fn: (s: PlayerSnapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): PlayerSnapshot {
    return {
      armed: this.armed,
      mode: this.mode,
      plan: this.plan,
      states: { ...this.states },
      playing: Object.entries(this.states)
        .filter(([, s]) => s === 'playing')
        .map(([id]) => id),
      events: this.events,
      alarms: [...this.alarms],
      runDate: this.runDate,
    };
  }

  next() {
    return nextPending(this.plan, this.states);
  }

  counts() {
    const v = Object.values(this.states);
    return {
      done: v.filter((s) => s === 'done').length,
      failed: v.filter((s) => s === 'failed').length,
      skipped: v.filter((s) => s === 'skipped').length,
    };
  }

  private tick() {
    const perf = performance.now();
    let changed = false;
    if (perf - this.lastTick > STALL_WARN_MS) {
      this.push('warn', `방송 프로그램이 ${Math.round((perf - this.lastTick) / 1000)}초간 멈춰 있었습니다 (PC 절전·과부하 확인)`);
      changed = true;
    }
    this.lastTick = perf;
    if (perf - this.lastWatchdog >= WATCHDOG_MS) {
      this.lastWatchdog = perf;
      changed = this.watchdog() || changed;
    }
    const now = this.clock.now();
    for (const d of decide(this.plan, this.states, now)) {
      const item = this.plan.find((p) => p.cue.id === d.cueId)!;
      changed = true;
      if (d.type === 'skip') {
        this.states[d.cueId] = 'skipped';
        this.push('warn', `시간 초과로 건너뜀 (${Math.round(d.lateMs / 1000)}초 지연): ${item.cue.label}`, d.cueId);
        this.report(item, 'skipped', null, `late ${d.lateMs}ms`);
        continue;
      }
      this.schedule(item, now);
    }
    // 예약된 큐가 시작 시각에 도달하면 playing으로 표시
    for (const [id, s] of Object.entries(this.states)) {
      const h = this.handles.get(id);
      if (s === 'scheduled' && h && now >= h.startAt) {
        this.states[id] = 'playing';
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** 1초마다: 오디오 출력과 시계 상태 점검. 상태가 바뀌었으면 true */
  private watchdog(): boolean {
    let changed = false;
    const gap = this.clock.detectSuspend();
    if (gap) {
      this.push('warn', `PC 절전/일시정지 감지 (${Math.round(gap / 1000)}초) — 시각을 다시 맞춥니다`);
      changed = true;
    }
    const audioOk = this.audio.state === 'running';
    if (!audioOk) {
      if (!this.alarms.has(ALARM_AUDIO_OFF)) {
        this.alarms.add(ALARM_AUDIO_OFF);
        this.push('error', '오디오 출력이 꺼졌습니다. 다시 켜는 중…');
        this.reporter?.update({ audioUnlocked: false, alarms: [...this.alarms] });
        changed = true;
      }
      void this.audio.tryResume(300);
    } else if (this.alarms.delete(ALARM_AUDIO_OFF)) {
      this.push('info', '오디오 출력 복구됨');
      this.reporter?.update({ audioUnlocked: true, alarms: [...this.alarms] });
      changed = true;
    }
    return changed;
  }

  private schedule(item: PlannedCue, now: number) {
    const { cue, at } = item;
    if (!this.audio.has(cue.assetId)) {
      this.states[cue.id] = 'failed';
      this.push('error', `음원 없음으로 재생 실패: ${cue.label}`, cue.id);
      this.report(item, 'failed', null, 'asset not loaded');
      return;
    }
    try {
      const h = this.audio.playAt(cue.assetId, at, now);
      this.handles.set(cue.id, h);
      this.states[cue.id] = 'scheduled';
      void h.ended.then(() => {
        if (this.states[cue.id] === 'playing' || this.states[cue.id] === 'scheduled') {
          this.states[cue.id] = 'done';
          this.push('info', `송출 완료: ${cue.label}`, cue.id);
          this.report(item, 'played', h.startAt);
          this.emit();
        }
        this.handles.delete(cue.id);
      });
    } catch (e) {
      this.states[cue.id] = 'failed';
      this.push('error', `재생 실패: ${cue.label} (${(e as Error).message})`, cue.id);
      this.report(item, 'failed', null, (e as Error).message);
    }
  }

  private report(item: PlannedCue, result: 'played' | 'skipped' | 'failed', startedAt: number | null, detail?: string) {
    if (this.mode === 'idle') return;
    this.reporter?.log({
      cueId: item.cue.id,
      label: item.cue.label,
      mode: this.mode,
      scheduledAt: item.at,
      startedAt,
      driftMs: startedAt === null ? null : Math.round(startedAt - item.at),
      result,
      ...(detail ? { detail } : {}),
    });
    const c = this.counts();
    this.reporter?.update({
      lastCue: { id: item.cue.id, label: item.cue.label, result, at: item.at },
      doneCount: c.done,
      failedCount: c.failed,
      skippedCount: c.skipped,
    });
  }

  private push(level: PlayerEvent['level'], message: string, cueId?: string) {
    this.events = [{ at: this.clock.now(), level, message, cueId }, ...this.events].slice(0, 200);
  }

  private emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}

export const player = new PlayerController();
