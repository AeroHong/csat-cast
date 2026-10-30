import { buildPlan, kstEpoch, shiftPlan, type PlannedCue } from './scheduler';
import type { ArmedDate, Cue } from './types';

/**
 * 학교에서 직접 잡는 리허설 예약. 그날 플레이어 화면을 열어 두면 실전 방송일처럼 자동으로 시작한다.
 * 방송 PC에서 쓰는 것이므로 이 PC(localStorage)에 학교·채널별로 저장한다.
 */
export interface ScheduledRehearsal {
  id: string;
  /** YYYY-MM-DD (KST) */
  date: string;
  /** actual: 시간표 시각 그대로(08:05부터) / custom: startTime부터 speed배로 압축 */
  kind: 'actual' | 'custom';
  /** custom: 첫 방송 시각 "HH:MM" */
  startTime?: string;
  /** custom: 1, 10, 60 */
  speed?: number;
}

const key = (school: string, channel: string) => `csat-cast:rehearsals:${school}:${channel}`;

export function loadRehearsals(school: string, channel: string): ScheduledRehearsal[] {
  try {
    const raw = localStorage.getItem(key(school, channel));
    const list = raw ? (JSON.parse(raw) as ScheduledRehearsal[]) : [];
    return Array.isArray(list) ? list.sort((a, b) => a.date.localeCompare(b.date)) : [];
  } catch {
    return [];
  }
}

export function saveRehearsals(school: string, channel: string, list: ScheduledRehearsal[]) {
  try {
    localStorage.setItem(key(school, channel), JSON.stringify(list));
  } catch {
    /* 저장소 사용 불가 */
  }
}

/** 예약 내용 한 줄 설명 */
export function describeRehearsal(r: ScheduledRehearsal): string {
  return r.kind === 'actual' ? '실제 시간표 그대로 (08:05부터)' : `${r.startTime} 시작 · ${r.speed === 1 ? '실제 간격' : `${r.speed}배속`}`;
}

/**
 * 예약할 수 있는지 검사. 문제 목록을 반환 (빈 배열이면 가능).
 * @param official 교육지원청이 정한 방송일(실전·공식 리허설) — 그날은 자동 방송이 이미 잡혀 있으므로 예약 불가
 */
export function validateRehearsal(
  r: ScheduledRehearsal,
  ctx: { now: number; today: string; official: ArmedDate[]; existing: ScheduledRehearsal[] },
): string[] {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return ['날짜를 고르세요'];
  if (r.date < ctx.today) errors.push('지난 날짜입니다');
  const official = ctx.official.find((d) => d.date === r.date);
  if (official) errors.push(`${r.date}은 ${official.mode === 'live' ? '실전 방송일' : '공식 리허설일'}(${official.label})이라 자동 방송이 이미 잡혀 있습니다`);
  if (ctx.existing.some((x) => x.date === r.date && x.id !== r.id)) errors.push('그날은 이미 예약된 리허설이 있습니다');
  if (r.kind === 'custom') {
    if (!r.startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.startTime)) errors.push('시작 시각을 정하세요');
    else if (r.date === ctx.today && kstEpoch(r.date, r.startTime) <= ctx.now) errors.push('시작 시각이 이미 지났습니다');
    if (![1, 10, 60].includes(r.speed ?? 0)) errors.push('배속을 고르세요');
  }
  return errors;
}

/** 예약된 리허설의 실제 방송 계획 */
export function rehearsalPlan(cues: Cue[], r: ScheduledRehearsal): PlannedCue[] {
  const base = buildPlan(cues, r.date);
  if (r.kind === 'actual' || !r.startTime) return base;
  return shiftPlan(base, kstEpoch(r.date, r.startTime), r.speed ?? 1);
}
