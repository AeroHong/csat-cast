import { audioEngine, type AudioEngine, type PlayEnd, type PlayHandle } from './audio';
import { serverClock, type ServerClock } from './clock';
import type { Reporter } from './reporter';
import { restoreStates } from './runStore';
import { applyExamDelays, decide, nextPending, type CueState, type ManualDelay, type PlannedCue } from './scheduler';
import { startTicker } from './ticker';
import type { RunMode } from './types';

export interface PlayerEvent {
  at: number;
  cueId?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * 끝까지 정상으로 나가지 않은 방송.
 * - cut: 중간에 끊김 (끝까지 안 나감 — 창 닫힘·새로고침·자동 방송 중지 등)
 * - gap: 끝까지 나갔지만 재생 중 소리가 끊겼다 이어짐 (오디오 출력 멈춤·출력 장치 바뀜)
 * - stopped: 담당자가 [정지]로 직접 멈춤
 */
export type IssueKind = 'cut' | 'gap' | 'stopped';

export interface CueIssue {
  kind: IssueKind;
  /** 실제로 재생한 길이 (모르면 null — 창이 닫혀 끊긴 경우) */
  playedMs: number | null;
  durationMs: number | null;
  gapMs: number;
  detail: string;
}

export const ISSUE_LABEL: Record<IssueKind, string> = { cut: '중간 끊김', gap: '끊김 있음', stopped: '담당자 정지' };

/** 음원 길이보다 이만큼 넘게 짧게 재생했으면 '끝까지 안 나감' (디코딩·시계 단위 오차 감안) */
export const CUT_TOLERANCE_MS = 300;
/** 재생 중 소리가 이만큼 이상 멈췄으면 '끊김' (오디오 시계 갱신 단위 오차 감안) */
export const GAP_TOLERANCE_MS = 700;

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}초`;

/** 재생 결과 → 문제가 있으면 판정, 끝까지 끊김 없이 나갔으면 null */
export function judgePlay(end: PlayEnd, byUser: boolean): CueIssue | null {
  const cut = end.durationMs - end.playedMs > CUT_TOLERANCE_MS;
  const gap = end.gapMs >= GAP_TOLERANCE_MS;
  const parts: string[] = [];
  if (cut) parts.push(`${sec(end.durationMs)} 중 ${sec(end.playedMs)}에서 멈춤`);
  if (gap) parts.push(`재생 중 ${sec(end.gapMs)} 동안 소리 멈춤`);
  for (const n of end.notes) if (!(gap && n.includes('멈춤'))) parts.push(n);
  if (!parts.length) return null;
  return {
    kind: cut ? (byUser ? 'stopped' : 'cut') : 'gap',
    playedMs: end.playedMs,
    durationMs: end.durationMs,
    gapMs: end.gapMs,
    detail: parts.join(', '),
  };
}

export interface PlayerSnapshot {
  armed: boolean;
  mode: RunMode | 'idle';
  plan: PlannedCue[];
  states: Record<string, CueState>;
  /** 본령이 실제로 울린 시각 (이어하기 저장용) */
  starts: Record<string, number>;
  /** 본령이 늦어 늦춘 시간(ms). 늦춘 큐만 들어 있다 (담당자가 직접 늦춘 시간 포함) */
  delays: Record<string, number>;
  /** 담당자가 직접 늦춘 시험 (종료령 큐 id → 늦춘 시간). 이어하기 저장용 */
  examDelays: Record<string, ManualDelay>;
  /** 큐별로 실제 소리가 시작된(시작될) 시각 — 관리자 화면의 송출 오차 */
  startedAt: Record<string, number>;
  /** 담당자가 [지금 재생]으로 직접 내보낸 큐 */
  manual: string[];
  /** 끝까지 정상으로 나가지 않은 방송 (큐 id → 판정). 상태는 '완료'라도 여기 있으면 정상이 아니다 */
  issues: Record<string, CueIssue>;
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
  /** 받은 계획 그대로 */
  private basePlan: PlannedCue[] = [];
  /** 본령 지연을 반영한 계획 (실제로 이 시각에 송출) */
  private plan: PlannedCue[] = [];
  private delays: Record<string, number> = {};
  private starts: Record<string, number> = {};
  private examDelays: Record<string, ManualDelay> = {};
  private startedAt: Record<string, number> = {};
  private manual = new Set<string>();
  private states: Record<string, CueState> = {};
  private handles = new Map<string, PlayHandle>();
  /** 재생 핸들 → 어느 큐의 재생인지 (수동 재생은 handles 키가 따로라서) */
  private handleCue = new Map<PlayHandle, { item: PlannedCue; manual: boolean }>();
  /** 담당자가 직접 멈춘 재생 */
  private userStopped = new WeakSet<PlayHandle>();
  /** 결과를 이미 확정한 재생 (정지 즉시 확정 + 늦게 오는 끝남 이벤트 중복 방지) */
  private settled = new WeakSet<PlayHandle>();
  private issues: Record<string, CueIssue> = {};
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
   * @param opts.starts 저장된 본령 송출 시각 (늦춘 시각을 이어받는다)
   */
  arm(
    plan: PlannedCue[],
    mode: RunMode,
    opts: {
      restore?: Record<string, CueState>;
      date?: string;
      starts?: Record<string, number>;
      examDelays?: Record<string, ManualDelay>;
      /** 저장된 재생 문제 판정 (이어하기) */
      issues?: Record<string, CueIssue>;
    } = {},
  ) {
    this.disarm(false);
    this.basePlan = plan;
    this.starts = { ...opts.starts };
    this.examDelays = { ...opts.examDelays };
    this.startedAt = {};
    this.manual.clear();
    this.applyDelays();
    this.mode = mode;
    this.runDate = opts.date ?? null;
    this.stoppedByUser = false;
    const now = this.clock.now();
    this.states = restoreStates(this.plan, opts.restore, now);
    this.issues = {};
    for (const { cue } of this.plan) {
      const saved = opts.issues?.[cue.id];
      if (saved && this.states[cue.id] === 'done') this.issues[cue.id] = saved;
      // 재생 중에 창이 닫히거나 새로고침되면 그 방송은 거기서 끊겼다 (이어하기에서는 다시 내지 않으므로 완료로 남는다)
      else if (opts.restore?.[cue.id] === 'playing' && this.states[cue.id] === 'done') {
        const detail = '재생 중 창이 닫히거나 새로고침되어 끊김';
        this.issues[cue.id] = { kind: 'cut', playedMs: null, durationMs: null, gapMs: 0, detail };
        this.push('error', `${ISSUE_LABEL.cut}: ${cue.label} — ${detail}`, cue.id);
      }
    }
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
    // 재생 중이던 방송은 여기서 끊긴다. 결과 기록이 바로 만들어지므로 지금 판정한다
    this.settleStarted(byUser);
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
    // 건너뜀·실패였던 큐를 직접 내보낸 경우도 '수동 송출'로 기록한다 (관리자 화면에서 빨강이 풀리도록).
    const prev = this.states[cueId];
    // 이미 송출했거나 송출 중·직전인 방송은 다시 내지 않는다 (같은 안내 두 번 송출 방지.
    // 본령을 다시 울리면 그때를 시험 시작으로 보고 종료령까지 늦춰 버리는 문제도 막는다)
    if (prev === 'done' || prev === 'playing' || prev === 'scheduled') {
      this.push('warn', `${prev === 'done' ? '이미 송출한' : '지금 송출 중인'} 방송이라 다시 재생하지 않습니다: ${item.cue.label}`, cueId);
      this.emit();
      return;
    }
    const counts = prev === 'pending' || prev === 'skipped' || prev === 'failed';
    if (counts) this.states[cueId] = 'done';
    try {
      this.prepared.add(item.cue.assetId);
      await this.audio.prepare(item.cue.assetId);
      const now = this.clock.now();
      const h = this.audio.playAt(item.cue.assetId, now, now);
      this.push('info', `수동 재생: ${item.cue.label}`, cueId);
      if (counts) {
        this.manual.add(cueId);
        this.startedAt[cueId] = now;
      }
      // 본령을 직접 울렸으면 그때 시험이 시작된 것이므로 뒤 방송을 그에 맞춘다
      this.recordStart(item, now);
      this.handles.set(`manual-${cueId}-${now}`, h);
      this.handleCue.set(h, { item, manual: true });
      void h.ended.then((end) => this.finishPlay(h, end));
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
      if (counts) this.states[cueId] = prev;
      this.push('error', `수동 재생 실패: ${(e as Error).message}`, cueId);
    }
    this.emit();
  }

  stopAll() {
    this.settleStarted(true);
    this.audio.stopAll();
    this.handles.clear();
    this.push('warn', '모든 재생 정지');
    this.emit();
  }

  /** 시간표 줄의 [정지]: 그 방송(같은 음원)의 재생을 담당자가 멈춤 */
  stopCue(cueId: string) {
    const item = this.plan.find((p) => p.cue.id === cueId);
    if (!item) return;
    for (const [h, info] of this.handleCue) if (info.item.cue.assetId === item.cue.assetId) this.userStopped.add(h);
    this.audio.stopAsset(item.cue.assetId);
  }

  /** 이미 소리가 나기 시작한 재생을 지금 위치로 판정한다 (곧 멈출 때) */
  private settleStarted(byUser: boolean) {
    const now = this.clock.now();
    for (const [h, info] of [...this.handleCue]) {
      if (byUser) this.userStopped.add(h);
      if (h.startAt > now || this.settled.has(h)) continue;
      if (!info.manual && this.states[info.item.cue.id] === 'scheduled') this.states[info.item.cue.id] = 'playing';
      this.finishPlay(h, h.progress());
    }
  }

  /** 재생 하나가 끝났을 때(또는 멈출 때) 결과 확정: 끝까지 끊김 없이 나갔을 때만 정상 */
  private finishPlay(h: PlayHandle, end: PlayEnd) {
    if (this.settled.has(h)) return;
    this.settled.add(h);
    const info = this.handleCue.get(h);
    this.handleCue.delete(h);
    if (!info) return;
    const { item, manual } = info;
    const id = item.cue.id;
    if (manual) {
      for (const [k, v] of this.handles) if (v === h) this.handles.delete(k);
    } else {
      // 취소된 예약의 종료 이벤트가 늦게 와서 새로 건 예약을 완료로 바꾸지 않도록 같은 예약인지 확인
      const current = this.handles.get(id);
      if (current && current !== h) return;
      this.handles.delete(id);
      const st = this.states[id];
      // 자동 방송을 멈춘 뒤 늦게 끝난 예약(소리 나기 전에 취소됨)은 송출로 치지 않는다
      if (this.mode === 'idle' || (st !== 'playing' && st !== 'scheduled')) {
        this.emit();
        return;
      }
      this.states[id] = 'done';
    }
    const issue = judgePlay(end, this.userStopped.has(h));
    if (issue) {
      this.issues[id] = issue;
      this.push(issue.kind === 'stopped' ? 'warn' : 'error', `${ISSUE_LABEL[issue.kind]}: ${item.cue.label} — ${issue.detail}`, id);
      this.report(item, issue.kind, h.startAt, issue.detail);
    } else if (!manual) {
      delete this.issues[id];
      this.push('info', `송출 완료: ${item.cue.label}`, id);
      this.report(item, 'played', h.startAt);
    }
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
      starts: { ...this.starts },
      delays: { ...this.delays },
      examDelays: { ...this.examDelays },
      startedAt: { ...this.startedAt },
      manual: [...this.manual],
      issues: { ...this.issues },
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
      const h = this.audio.playAt(cue.assetId, at, now);
      this.handles.set(cue.id, h);
      this.handleCue.set(h, { item, manual: false });
      this.states[cue.id] = 'scheduled';
      this.startedAt[cue.id] = h.startAt;
      this.recordStart(item, h.startAt);
      void h.ended.then((end) => this.finishPlay(h, end));
    } catch (e) {
      this.states[cue.id] = 'failed';
      this.push('error', `재생 실패: ${cue.label} (${(e as Error).message})`, cue.id);
      this.report(item, 'failed', null, (e as Error).message);
    }
  }

  /**
   * 지금 진행 중(또는 다음)인 시험: 아직 나가지 않은 다음 종료령과, 그 시험에서 아직 남은 방송들.
   * 이 시험의 종료를 담당자가 늦출 때 쓴다.
   */
  currentExam(): { end: PlannedCue; remaining: PlannedCue[]; delayMs: number } | null {
    const end = this.plan.find((p) => p.cue.examEnd && (this.states[p.cue.id] ?? 'pending') === 'pending');
    if (!end) return null;
    const idx = this.plan.indexOf(end);
    let from = idx;
    while (from > 0 && !this.plan[from - 1].cue.examEnd) from--;
    const remaining = this.plan.slice(from, idx + 1).filter((p) => (this.states[p.cue.id] ?? 'pending') === 'pending');
    return { end, remaining, delayMs: this.examDelays[end.cue.id]?.ms ?? 0 };
  }

  /**
   * 담당자가 이 시험의 종료를 늦춘다 (예: 영어 듣기평가가 늦게 시작됨 → +2분).
   * 아직 나가지 않은 이 시험의 방송(종료 n분 전·종료령)만 늦추고, 다음 교시는 원래 시각대로.
   * 곧 송출(예약됨) 중인 방송은 건드리지 않는다. deltaMs가 음수면 늦춘 만큼을 줄인다(0 아래로는 안 감).
   * @returns 바뀐 종료령 시각, 늦출 수 없으면 null
   */
  delayExam(endCueId: string, deltaMs: number): number | null {
    const cur = this.currentExam();
    if (!cur || cur.end.cue.id !== endCueId || !cur.remaining.length) return null;
    const baseOf = (id: string) => this.basePlan.find((b) => b.cue.id === id)!.at;
    const prev = this.examDelays[endCueId];
    const ms = Math.max(0, (prev?.ms ?? 0) + deltaMs);
    // 이미 나간 방송은 다시 늦추지 않도록, 처음 늦출 때 남아 있던 첫 방송부터 적용
    const fromAt = prev?.fromAt ?? Math.min(...cur.remaining.map((p) => baseOf(p.cue.id)));
    if (ms === 0) delete this.examDelays[endCueId];
    else this.examDelays[endCueId] = { ms, fromAt };
    this.applyDelays();
    const endAt = this.plan.find((p) => p.cue.id === endCueId)!.at;
    const min = Math.round(ms / 6000) / 10;
    this.push(
      'warn',
      ms === 0
        ? `담당자가 ${cur.end.cue.period} 종료 늦춤을 되돌림 → 종료령 원래 시각`
        : `담당자가 ${cur.end.cue.period} 종료를 ${min}분 늦춤 → 종료령 ${new Date(endAt).toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`,
    );
    this.emit();
    return endAt;
  }

  /** 본령이 실제로 울리는 시각을 기록하고, 늦었으면 이 시험의 뒤 방송을 늦춘다 */
  private recordStart(item: PlannedCue, startAt: number) {
    if (!item.cue.examStart) return;
    this.starts[item.cue.id] = startAt;
    const before = this.plan;
    this.applyDelays();
    const base = this.basePlan.find((b) => b.cue.id === item.cue.id)!;
    const late = Math.round((startAt - base.at) / 1000);
    if (late >= 1 && before.some((b, i) => b.at !== this.plan[i]?.at || b.cue.id !== this.plan[i]?.cue.id)) {
      this.push('warn', `${item.cue.label} ${late}초 늦게 송출 → 이 시험의 뒤 방송을 ${late}초 늦춥니다 (시험 시간 보장)`, item.cue.id);
    }
  }

  private applyDelays() {
    const r = applyExamDelays(this.basePlan, this.starts, this.examDelays);
    this.plan = r.plan;
    this.delays = r.delays;
  }

  private report(item: PlannedCue, result: 'played' | 'skipped' | 'failed' | IssueKind, startedAt: number | null, detail?: string) {
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
