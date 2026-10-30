import { initialStates, type CueState, type PlannedCue } from './scheduler';
import type { RunMode } from './types';

/**
 * 진행 상태 저장소. 새로고침·브라우저 재시작·PC 재부팅 뒤에도
 * 이미 송출한 방송을 다시 내보내지 않고 이어서 진행하기 위해 PC(localStorage)에 기록한다.
 */
export interface SavedRun {
  date: string;
  mode: RunMode;
  states: Record<string, CueState>;
  /** 담당자가 직접 중지했으면 같은 날 자동으로 다시 시작하지 않는다 */
  stoppedByUser: boolean;
  savedAt: number;
}

const key = (school: string, channel: string) => `csat-cast:run:${school}:${channel}`;

export function loadRun(school: string, channel: string, date: string): SavedRun | null {
  try {
    const raw = localStorage.getItem(key(school, channel));
    const run = raw ? (JSON.parse(raw) as SavedRun) : null;
    return run && run.date === date ? run : null;
  } catch {
    return null;
  }
}

export function saveRun(school: string, channel: string, run: SavedRun) {
  try {
    localStorage.setItem(key(school, channel), JSON.stringify(run));
  } catch {
    /* 저장소 사용 불가: 이어하기만 안 될 뿐 방송에는 영향 없음 */
  }
}

/**
 * 저장된 상태로 이어서 시작할 때의 큐 상태 계산.
 * - 완료/건너뜀/실패는 그대로 유지 (다시 송출하지 않음)
 * - 재생 중이었던 큐: 이미 소리가 나갔으므로 완료 처리 (중복 송출 방지)
 * - 예약만 된 큐: 시작 시각 전에 창이 닫혀 소리가 나가지 않았으므로 처음 시작할 때와 같은 규칙
 *   (허용 지연 이내면 다시 재생, 넘었으면 건너뜀). 시작 시각이 되면 player가 즉시 playing으로 저장한다.
 * - 나머지는 처음 시작할 때와 같은 규칙
 */
export function restoreStates(
  plan: PlannedCue[],
  saved: Record<string, CueState> | undefined,
  now: number,
): Record<string, CueState> {
  const states = initialStates(plan, now);
  if (!saved) return states;
  for (const { cue } of plan) {
    const prev = saved[cue.id];
    if (prev === 'done' || prev === 'skipped' || prev === 'failed') states[cue.id] = prev;
    else if (prev === 'playing') states[cue.id] = 'done';
  }
  return states;
}
