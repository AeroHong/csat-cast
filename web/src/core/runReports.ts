/**
 * 방송 회차별 결과 기록 (테스트·리허설·실전). 이 PC(localStorage)에 최근 30회를 남긴다.
 * 담당자가 여러 번 테스트해 본 뒤 "늘 같은 방송이 늦다 / 화면이 자꾸 꺼진다" 같은 반복 문제를 찾기 위함.
 */
import type { PlayerEvent, PlayerSnapshot } from './player';
import type { RunMode } from './types';

/** 이보다 늦게 시작하면 '늦음'으로 본다 */
export const LATE_MS = 1_000;
const MAX_REPORTS = 30;

export type Outcome = 'played' | 'late' | 'manual' | 'skipped' | 'failed' | 'missed' | 'stopped' | 'pending';

export interface CueOutcome {
  id: string;
  /** 시간표 시각 "HH:MM:SS" (배속 리허설이어도 원래 시각) */
  time: string;
  label: string;
  outcome: Outcome;
  /** 실제 시작 - 예정 (ms) */
  driftMs: number | null;
}

export interface Incident {
  at: number;
  level: 'warn' | 'error';
  message: string;
}

export interface RunReport {
  id: string;
  mode: RunMode;
  /** 예: "바로 리허설 60배속", "예약 리허설 · 11/16 14:00", "실전 · 2027학년도 수능" */
  label: string;
  startedAt: number;
  endedAt: number | null;
  cues: CueOutcome[];
  incidents: Incident[];
  /** 진행 중 가장 낮았던 배터리 잔량(0~1)과 배터리로 동작한 적이 있는지 */
  battery?: { min: number | null; unplugged: boolean };
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  played: '정상',
  late: '늦음',
  manual: '수동 송출',
  skipped: '건너뜀',
  failed: '실패',
  missed: '안 나감',
  stopped: '중지로 남김',
  pending: '대기',
};

/**
 * 지금 플레이어 상태 → 방송별 결과.
 * ended=true면 끝까지 안 나간 방송은 '안 나감'(문제). 담당자가 직접 중지했으면 '중지로 남김'(문제 아님).
 */
export function outcomesFrom(
  snap: Pick<PlayerSnapshot, 'plan' | 'states' | 'startedAt' | 'manual'>,
  ended: boolean,
  stoppedByUser = false,
): CueOutcome[] {
  const manual = new Set(snap.manual);
  return snap.plan.map(({ cue, at }) => {
    const st = snap.states[cue.id] ?? 'pending';
    const started = snap.startedAt[cue.id];
    const driftMs = started === undefined ? null : Math.round(started - at);
    let outcome: Outcome;
    if (st === 'skipped') outcome = 'skipped';
    else if (st === 'failed') outcome = 'failed';
    else if (manual.has(cue.id)) outcome = 'manual';
    else if (st === 'done' || st === 'playing') outcome = driftMs !== null && driftMs > LATE_MS ? 'late' : 'played';
    else outcome = !ended ? 'pending' : stoppedByUser ? 'stopped' : 'missed';
    return { id: cue.id, time: cue.time, label: cue.label, outcome, driftMs };
  });
}

/** 담당자가 직접 한 조작(중지·다시 재생 거부 등)은 사고로 세지 않는다 */
const OPERATOR_ACTION = /^(자동 방송 중지|모든 재생 정지|이미 송출한 방송|지금 송출 중인 방송)/;

/**
 * 플레이어 기록 중 이 회차에 생긴 경고·오류 (중복 제외).
 * 특정 방송에 딸린 기록(재생 실패·건너뜀)은 방송별 결과에 이미 있으므로 빼고, PC 멈춤 같은 환경 문제만 남긴다.
 */
export function incidentsFrom(events: PlayerEvent[], since: number, prev: Incident[]): Incident[] {
  const seen = new Set(prev.map((i) => `${i.at}|${i.message}`));
  const add = events
    .filter((e) => e.at >= since && !e.cueId && (e.level === 'warn' || e.level === 'error') && !OPERATOR_ACTION.test(e.message))
    .map((e) => ({ at: e.at, level: e.level as Incident['level'], message: e.message }))
    .filter((i) => !seen.has(`${i.at}|${i.message}`));
  return [...prev, ...add].sort((a, b) => a.at - b.at);
}

export interface RunSummary {
  total: number;
  counts: Record<Outcome, number>;
  maxDriftMs: number | null;
  problems: number;
  ok: boolean;
}

export function summarize(r: RunReport): RunSummary {
  const counts = Object.fromEntries(Object.keys(OUTCOME_LABEL).map((k) => [k, 0])) as Record<Outcome, number>;
  let maxDriftMs: number | null = null;
  for (const c of r.cues) {
    counts[c.outcome]++;
    if (c.driftMs !== null && (maxDriftMs === null || c.driftMs > maxDriftMs)) maxDriftMs = c.driftMs;
  }
  const problems = counts.late + counts.manual + counts.skipped + counts.failed + counts.missed + r.incidents.length;
  return { total: r.cues.length, counts, maxDriftMs, problems, ok: problems === 0 };
}

export interface Recurring {
  label: string;
  times: number;
  of: number;
}

/**
 * 여러 회차에 걸쳐 반복된 문제: 같은 방송(시각+내용)이 2회 이상 문제였거나, 같은 종류의 사고가 2회 이상.
 * 사고 메시지의 숫자는 지워서 묶는다 ("12초간 멈춰" / "40초간 멈춰" → 같은 종류).
 */
export function recurring(reports: RunReport[]): Recurring[] {
  const done = reports.filter((r) => r.endedAt !== null);
  const counter = new Map<string, Set<string>>();
  const bump = (key: string, run: string) => {
    if (!counter.has(key)) counter.set(key, new Set());
    counter.get(key)!.add(run);
  };
  for (const r of done) {
    for (const c of r.cues)
      if (c.outcome !== 'played' && c.outcome !== 'pending' && c.outcome !== 'stopped') bump(`${c.time.slice(0, 5)} ${c.label} — ${OUTCOME_LABEL[c.outcome]}`, r.id);
    for (const i of r.incidents) bump(i.message.replace(/\d+/g, 'n').replace(/: .*$/, ''), r.id);
  }
  return [...counter.entries()]
    .filter(([, runs]) => runs.size >= 2)
    .map(([label, runs]) => ({ label, times: runs.size, of: done.length }))
    .sort((a, b) => b.times - a.times);
}

const key = (school: string, channel: string) => `csat-cast:reports:${school}:${channel}`;

export function loadReports(school: string, channel: string): RunReport[] {
  try {
    const v = localStorage.getItem(key(school, channel));
    return v ? (JSON.parse(v) as RunReport[]) : [];
  } catch {
    return [];
  }
}

/** 같은 id면 덮어쓰고, 최근 것부터 30개만 둔다 */
export function saveReport(school: string, channel: string, report: RunReport): RunReport[] {
  const list = [report, ...loadReports(school, channel).filter((r) => r.id !== report.id)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_REPORTS);
  try {
    localStorage.setItem(key(school, channel), JSON.stringify(list));
  } catch {
    /* 저장 공간 부족 등 — 방송에는 영향 없음 */
  }
  return list;
}

export function clearReports(school: string, channel: string) {
  try {
    localStorage.removeItem(key(school, channel));
  } catch {
    /* 무시 */
  }
}
