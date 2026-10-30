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
/**
 * 이만큼 앞서 음원을 디코딩해 둔다. 실제 음원은 수 분 길이라 디코딩하면 파일 하나에 수십~100MB가 되므로
 * 전부 올려 두지 않고 곧 나갈 것만 준비했다가 끝나면 내린다.
 */
const PREPARE_AHEAD_MS = 3 * 60_000;

export const ALARM_AUDIO_OFF = '오디오 출력이 꺼져 있음 — 방송 PC 화면을 클릭하세요';

/**
 * 자동 방송 진행기. 계획(plan)을 받아 시각에 맞춰 음원을 재생하고 결과를 보고한다.
 * UI와 분리되어 있어 화면이 다시 그려져도 재생 상태가 유지된다.
 */
export class PlayerController {
  private plan: PlannedCue[] = [];
  private states: Record<string, CueState> = {};
  private handles = new Map<string, PlayHandle>();
  /** 이 진행기가 디코딩을 요청해 둔 음원 (필요 없어지면 메모리에서 내린다) */
  private prepared = new Set<string>();
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
    // 첫 방송이 한참 뒤여도 시작했다는 사실을 화면·저장소에 바로 알린다
    this.emit();
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
    for (const id of this.prepared) this.audio.release(id);
    this.prepared.clear();
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
  async playNow(cueId: string) {
    const item = this.plan.find((p) => p.cue.id === cueId);
    if (!item) return;
    // 수동으로 재생한 큐는 자동 재생 대상에서 뺀다 (중복 방지). 디코딩을 기다리는 사이 자동 재생되지 않도록 먼저 바꾼다.
    const wasPending = this.states[cueId] === 'pending';
    if (wasPending) this.states[cueId] = 'done';
    try {
      this.prepared.add(item.cue.assetId);
      await this.audio.prepare(item.cue.assetId);
      const now = this.clock.now();
      const h = this.audio.playAt(item.cue.assetId, now, now);
      this.push('info', `수동 재생: ${item.cue.label}`, cueId);
      this.handles.set(`manual-${cueId}-${now}`, h);
      void h.ended.then(() => this.emit());
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
      if (wasPending) this.states[cueId] = 'pending';
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
    // 소리가 꺼진 오디오에 걸어 둔 예약은 소리 없이 시각만 지나가고, 켜지는 순간 늦게 울린다.
    // 꺼져 있는 동안은 예약하지 않고 대기로 두어, 켜진 뒤 허용 지연 이내면 재생·넘었으면 건너뜀으로 처리한다.
    const audioOn = this.audio.state === 'running';
    if (!audioOn) {
      for (const [id, s] of Object.entries(this.states)) {
        if (s !== 'scheduled') continue;
        this.handles.get(id)?.stop();
        this.handles.delete(id);
        this.states[id] = 'pending';
        changed = true;
      }
    }
    this.prepareUpcoming(now);
    for (const d of decide(this.plan, this.states, now)) {
      const item = this.plan.find((p) => p.cue.id === d.cueId)!;
      const { assetId } = item.cue;
      if (d.type === 'skip') {
        changed = true;
        this.states[d.cueId] = 'skipped';
        const [reason, code] = !audioOn
          ? ['소리가 꺼져 있어 송출 못함', 'audio off, late']
          : this.audio.has(assetId) && !this.audio.isReady(assetId)
            ? ['음원 준비가 늦어 송출 못함', 'decode late']
            : ['시간 초과로 건너뜀', 'late'];
        this.push('warn', `${reason} (${Math.round(d.lateMs / 1000)}초 지연): ${item.cue.label}`, d.cueId);
        this.report(item, 'skipped', null, `${code} ${d.lateMs}ms`);
        continue;
      }
      if (!audioOn) continue;
      // 아직 디코딩 중이면 기다린다 (허용 지연을 넘기면 decide가 건너뜀으로 바꾼다). 실패했으면 schedule이 실패 처리.
      if (this.audio.has(assetId) && !this.audio.isReady(assetId)) continue;
      changed = true;
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

  /** 곧 나갈 큐의 음원은 미리 디코딩하고, 더 이상 필요 없는 음원은 메모리에서 내린다 */
  private prepareUpcoming(now: number) {
    const needed = new Set<string>();
    for (const { cue, at } of this.plan) {
      const s = this.states[cue.id];
      if (s === 'playing' || ((s === 'pending' || s === 'scheduled') && at - now <= PREPARE_AHEAD_MS)) needed.add(cue.assetId);
    }
    for (const id of needed) {
      if (this.prepared.has(id) || !this.audio.has(id)) continue;
      this.prepared.add(id);
      // 실패하면 audio가 사유를 기록하고 has()가 false가 되어 schedule에서 실패로 처리된다
      this.audio.prepare(id).catch(() => this.emit());
    }
    // 이미 재생 중인 소리는 내려도 끝까지 재생된다 (재생기가 음원을 따로 붙잡고 있음)
    for (const id of this.prepared) {
      if (needed.has(id)) continue;
      this.audio.release(id);
      this.prepared.delete(id);
    }
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
      const broken = this.audio.decodeError(cue.assetId);
      this.states[cue.id] = 'failed';
      this.push('error', `${broken ? '음원 파일 오류' : '음원 없음'}으로 재생 실패: ${cue.label}`, cue.id);
      this.report(item, 'failed', null, broken ?? 'asset not loaded');
      return;
    }
    try {
      const offset = cue.catchUp ? Math.max(0, now - at) : 0;
      const h = this.audio.playAt(cue.assetId, at, now, offset);
      this.handles.set(cue.id, h);
      this.states[cue.id] = 'scheduled';
      if (offset >= 1000) this.push('warn', `${Math.round(offset / 1000)}초 늦어 앞부분을 건너뛰고 이어서 송출: ${cue.label}`, cue.id);
      void h.ended.then(() => {
        // 취소된 예약의 종료 이벤트가 늦게 와서 새로 건 예약을 완료로 바꾸지 않도록 같은 예약인지 확인
        const current = this.handles.get(cue.id);
        if (current && current !== h) return;
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
