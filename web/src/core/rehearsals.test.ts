import { describe, expect, it } from 'vitest';
import { rehearsalPlan, validateRehearsal, type ScheduledRehearsal } from './rehearsals';
import { kstEpoch, kstTime } from './scheduler';
import type { ArmedDate, Cue } from './types';

const cue = (id: string, time: string): Cue => ({ id, time, period: '', label: id, kind: 'ment', assetId: id });
const cues = [cue('a', '08:05:00'), cue('b', '08:10:00'), cue('c', '09:05:00')];
const official: ArmedDate[] = [
  { date: '2026-11-18', mode: 'test', label: '예비소집일 전체 리허설' },
  { date: '2026-11-19', mode: 'live', label: '2027학년도 수능' },
];
const today = '2026-11-05';
const ctx = (existing: ScheduledRehearsal[] = []) => ({ now: kstEpoch(today, '10:00:00'), today, official, existing });
const r = (o: Partial<ScheduledRehearsal>): ScheduledRehearsal => ({ id: 'x', date: '2026-11-10', kind: 'actual', ...o });

describe('리허설 예약', () => {
  it('실제 시간표 그대로: 그날 시간표 시각에 방송', () => {
    const plan = rehearsalPlan(cues, r({ date: '2026-11-10' }));
    expect(plan.map((p) => kstTime(p.at))).toEqual(['08:05:00', '08:10:00', '09:05:00']);
    expect(plan[0].at).toBe(kstEpoch('2026-11-10', '08:05:00'));
  });

  it('시작 시각 지정: 첫 방송을 그 시각으로 옮기고 배속만큼 간격을 줄인다', () => {
    const plan = rehearsalPlan(cues, r({ kind: 'custom', startTime: '14:00', speed: 10 }));
    expect(plan.map((p) => kstTime(p.at))).toEqual(['14:00:00', '14:00:30', '14:06:00']);
  });

  it('실전 방송일·공식 리허설일·지난 날짜·같은 날 중복은 예약할 수 없다', () => {
    expect(validateRehearsal(r({ date: '2026-11-19' }), ctx())[0]).toContain('실전 방송일');
    expect(validateRehearsal(r({ date: '2026-11-18' }), ctx())[0]).toContain('공식 리허설일');
    expect(validateRehearsal(r({ date: '2026-11-04' }), ctx())).toContain('지난 날짜입니다');
    expect(validateRehearsal(r({ id: 'new' }), ctx([r({})]))).toContain('그날은 이미 예약된 리허설이 있습니다');
    expect(validateRehearsal(r({}), ctx())).toEqual([]);
  });

  it('오늘 예약은 시작 시각이 아직 안 지났을 때만', () => {
    expect(validateRehearsal(r({ date: today, kind: 'custom', startTime: '09:30', speed: 1 }), ctx())).toContain('시작 시각이 이미 지났습니다');
    expect(validateRehearsal(r({ date: today, kind: 'custom', startTime: '10:30', speed: 60 }), ctx())).toEqual([]);
    expect(validateRehearsal(r({ kind: 'custom', startTime: '', speed: 1 }), ctx())).toContain('시작 시각을 정하세요');
  });
});
