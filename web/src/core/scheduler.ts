import type { ChannelConfig, Cue, Template } from './types';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DEFAULT_TOLERANCE_SEC: Record<Cue['kind'], number> = {
  bell: 5,
  ment: 30,
};

/** 이만큼 앞서서 오디오 엔진에 정밀 예약을 건다. */
export const LOOKAHEAD_MS = 2000;

export interface PlannedCue {
  cue: Cue;
  /** 서버 시각 기준 epoch ms */
  at: number;
}

export type CueState = 'pending' | 'scheduled' | 'playing' | 'done' | 'skipped' | 'failed';

export type Decision =
  | { type: 'schedule'; cueId: string; at: number }
  | { type: 'skip'; cueId: string; lateMs: number };

/** "HH:MM:SS" 문자열을 KST 날짜의 epoch ms로 변환 */
export function kstEpoch(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - KST_OFFSET_MS;
}

/** epoch ms → KST "YYYY-MM-DD" */
export function kstDate(epochMs: number): string {
  return new Date(epochMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** epoch ms → KST "HH:MM:SS" */
export function kstTime(epochMs: number): string {
  return new Date(epochMs + KST_OFFSET_MS).toISOString().slice(11, 19);
}

/** 템플릿 + 학교 설정 → 실제 재생할 큐 목록 (시각 순) */
export function resolveCues(template: Template, channel?: ChannelConfig): Cue[] {
  const disabled = new Set(channel?.disabledCueIds ?? []);
  const cues = template.cues.filter((c) => !disabled.has(c.id));
  for (const extra of channel?.extraCues ?? []) cues.push({ ...extra, official: false });
  return cues.sort((a, b) => a.time.localeCompare(b.time));
}

/** 큐 목록을 특정 날짜의 실제 시각으로 배치 */
export function buildPlan(cues: Cue[], date: string): PlannedCue[] {
  return cues
    .map((cue) => ({ cue, at: kstEpoch(date, cue.time) }))
    .sort((a, b) => a.at - b.at);
}

/**
 * 리허설용: 첫 큐가 startAt에 오도록 시간 이동하고, speed배로 간격을 압축한다.
 * 음원 자체는 정상 속도로 재생되므로 배속에서는 멘트가 겹칠 수 있다.
 */
export function shiftPlan(plan: PlannedCue[], startAt: number, speed = 1): PlannedCue[] {
  if (plan.length === 0) return [];
  const first = plan[0].at;
  return plan.map(({ cue, at }) => ({ cue, at: Math.round(startAt + (at - first) / speed) }));
}

export function toleranceMs(cue: Cue): number {
  return (cue.lateToleranceSec ?? DEFAULT_TOLERANCE_SEC[cue.kind]) * 1000;
}

/**
 * 매 tick마다 호출. 아직 처리하지 않은(pending) 큐 중
 * - 곧 재생할 큐는 schedule
 * - 허용 지연을 넘긴 큐는 skip
 * 결정을 반환한다. 상태 변경은 호출자가 한다(순수 함수).
 */
export function decide(
  plan: PlannedCue[],
  states: Record<string, CueState>,
  now: number,
  lookaheadMs = LOOKAHEAD_MS,
): Decision[] {
  const out: Decision[] = [];
  for (const { cue, at } of plan) {
    if ((states[cue.id] ?? 'pending') !== 'pending') continue;
    if (at - now > lookaheadMs) break; // plan은 시각순
    const late = now - at;
    if (late > toleranceMs(cue)) out.push({ type: 'skip', cueId: cue.id, lateMs: late });
    else out.push({ type: 'schedule', cueId: cue.id, at });
  }
  return out;
}

/**
 * 플레이어를 중간에 시작(또는 새로고침)했을 때 이미 지난 큐를 건너뜀 처리.
 * 허용 지연 이내의 큐는 남겨 두어 decide()가 재생하게 한다.
 */
export function initialStates(plan: PlannedCue[], now: number): Record<string, CueState> {
  const states: Record<string, CueState> = {};
  for (const { cue, at } of plan) {
    states[cue.id] = now - at > toleranceMs(cue) ? 'skipped' : 'pending';
  }
  return states;
}

export function nextPending(
  plan: PlannedCue[],
  states: Record<string, CueState>,
): PlannedCue | undefined {
  return plan.find(({ cue }) => {
    const s = states[cue.id] ?? 'pending';
    return s === 'pending' || s === 'scheduled';
  });
}
