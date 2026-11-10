import { describe, expect, it } from 'vitest';
import { incidentsFrom, outcomesFrom, recurring, summarize, type RunReport } from './runReports';
import type { PlannedCue } from './scheduler';
import type { Cue } from './types';

const cue = (id: string, time: string): Cue => ({ id, time, period: 'p', label: id, kind: 'ment', assetId: id });
const plan: PlannedCue[] = [
  { cue: cue('a', '08:05:00'), at: 0 },
  { cue: cue('b', '08:10:00'), at: 10_000 },
  { cue: cue('c', '08:25:00'), at: 20_000 },
  { cue: cue('d', '08:35:00'), at: 30_000 },
  { cue: cue('e', '08:40:00'), at: 40_000 },
];

describe('outcomesFrom', () => {
  const snap = {
    plan,
    states: { a: 'done', b: 'done', c: 'skipped', d: 'done' } as Record<string, 'done' | 'skipped'>,
    startedAt: { a: 30, b: 12_500, d: 31_000 },
    manual: ['d'],
  };

  it('정상·늦음(1초 초과)·건너뜀·수동·대기를 나눈다', () => {
    const r = outcomesFrom(snap, false);
    expect(r.map((x) => x.outcome)).toEqual(['played', 'late', 'skipped', 'manual', 'pending']);
    expect(r[1].driftMs).toBe(2_500);
  });

  it('도중에 멈췄으면 남은 방송은 안 나감', () => {
    expect(outcomesFrom(snap, true).at(-1)!.outcome).toBe('missed');
  });

  it('담당자가 직접 중지했으면 남은 방송은 문제가 아닌 "중지로 남김"', () => {
    expect(outcomesFrom(snap, true, true).at(-1)!.outcome).toBe('stopped');
  });
});

describe('incidentsFrom', () => {
  it('이 회차 이후의 경고·오류만, 중복 없이', () => {
    const ev = [
      { at: 5, level: 'warn' as const, message: '옛날 경고' },
      { at: 20, level: 'info' as const, message: '정보' },
      { at: 30, level: 'warn' as const, message: '멈춤' },
      { at: 31, level: 'error' as const, message: '재생 실패: 본령', cueId: 'x' },
      { at: 32, level: 'warn' as const, message: '자동 방송 중지' },
    ];
    const first = incidentsFrom(ev, 10, []);
    expect(first.map((i) => i.message)).toEqual(['멈춤']);
    expect(incidentsFrom(ev, 10, first)).toHaveLength(1);
  });
});

const report = (id: string, outcomes: RunReport['cues'][number]['outcome'][], incidents: string[] = []): RunReport => ({
  id,
  mode: 'test',
  label: 't',
  startedAt: Number(id),
  endedAt: Number(id) + 1,
  cues: outcomes.map((o, i) => ({ id: `c${i}`, time: `08:0${i}:00`, label: `방송${i}`, outcome: o, driftMs: 0 })),
  incidents: incidents.map((m, i) => ({ at: i, level: 'warn', message: m })),
});

describe('summarize · recurring', () => {
  it('문제 수를 세고 모두 정상이면 ok', () => {
    expect(summarize(report('1', ['played', 'played'])).ok).toBe(true);
    const s = summarize(report('2', ['played', 'skipped'], ['멈춤']));
    expect([s.ok, s.problems, s.counts.skipped]).toEqual([false, 2, 1]);
  });

  it('여러 회차에서 2번 이상 반복된 방송 문제와 사고(숫자 무시)를 찾는다', () => {
    const r = recurring([
      report('1', ['played', 'skipped'], ['방송 프로그램이 12초간 멈춰 있었습니다']),
      report('2', ['played', 'skipped'], ['방송 프로그램이 40초간 멈춰 있었습니다']),
      report('3', ['failed', 'played']),
    ]);
    expect(r.map((x) => [x.label, x.times, x.of])).toEqual([
      ['08:01 방송1 — 건너뜀', 2, 3],
      ['방송 프로그램이 n초간 멈춰 있었습니다', 2, 3],
    ]);
  });
});

describe('outcomesFrom — 끝까지 나갔는지', () => {
  const issue = (kind: 'cut' | 'gap' | 'stopped') => ({ kind, playedMs: 1000, durationMs: 3000, gapMs: 0, detail: `${kind} 사유` });

  it('완료여도 끊김 판정이 있으면 정상이 아니다 (수동 송출보다 우선)', () => {
    const r = outcomesFrom(
      {
        plan,
        states: { a: 'done', b: 'done', c: 'done', d: 'done' },
        startedAt: { a: 0, b: 10_000, c: 20_000, d: 30_000 },
        manual: ['d'],
        issues: { a: issue('cut'), b: issue('gap'), d: issue('stopped') },
      },
      false,
    );
    expect(r.slice(0, 4).map((x) => x.outcome)).toEqual(['cut', 'gap', 'played', 'userCut']);
    expect(r[0].detail).toBe('cut 사유');
  });

  it('회차가 끝났는데 재생 중으로 남은 방송은 정상이 아니라 중간 끊김', () => {
    const snap = { plan, states: { a: 'playing' as const }, startedAt: { a: 0 }, manual: [] };
    expect(outcomesFrom(snap, false)[0].outcome).toBe('pending');
    expect(outcomesFrom(snap, true)[0].outcome).toBe('cut');
  });

  it('중간 끊김·끊김 있음은 문제로 세고, 담당자 정지는 세지 않는다', () => {
    const base = { id: '1', mode: 'test' as const, label: '', startedAt: 0, endedAt: 1, incidents: [] };
    const c = (outcome: 'cut' | 'gap' | 'userCut') => ({ id: outcome, time: '08:00:00', label: outcome, outcome, driftMs: 0 });
    expect(summarize({ ...base, cues: [c('cut'), c('gap'), c('userCut')] }).problems).toBe(2);
  });
});
