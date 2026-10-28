import { audioEngine, type AudioEngine, type PlayHandle } from './audio';
import { serverClock, type ServerClock } from './clock';
import type { Reporter } from './reporter';
import { decide, initialStates, nextPending, type CueState, type PlannedCue } from './scheduler';
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
}

const TICK_MS = 250;

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
  reporter: Reporter | null = null;

  constructor(
    private audio: AudioEngine = audioEngine,
    private clock: ServerClock = serverClock,
  ) {}

  arm(plan: PlannedCue[], mode: RunMode) {
    this.disarm();
    this.plan = plan;
    this.mode = mode;
    this.states = initialStates(plan, this.clock.now());
    const skipped = Object.values(this.states).filter((s) => s === 'skipped').length;
    this.push('info', `${mode === 'live' ? '실전' : '테스트'} 자동 방송 시작 (큐 ${plan.length}개)`);
    if (skipped) this.push('warn', `이미 지난 큐 ${skipped}개는 건너뜁니다`);
    this.stopTicker = startTicker(TICK_MS, () => this.tick());
    this.tick();
  }

  disarm() {
    this.stopTicker?.();
    this.stopTicker = null;
    if (this.mode !== 'idle') this.push('info', '자동 방송 중지');
    this.audio.stopAll();
    this.handles.clear();
    this.mode = 'idle';
    this.emit();
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
    const now = this.clock.now();
    let changed = false;
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
