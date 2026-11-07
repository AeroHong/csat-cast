import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../data/templates';
import {
  MISSING_AFTER_MS,
  buildColumns,
  cellState,
  cuesHash,
  devicesConflict,
  expectedCues,
  formatDrift,
  nextAcross,
  toTimeline,
  type TimelineEntry,
} from './board';
import { buildPlan } from './scheduler';
import type { SchoolProfile } from './types';

const school = (templateId: string, extra: Partial<SchoolProfile['channels'][0]> = {}): SchoolProfile => ({
  neisCode: 'd13-01',
  name: '테스트고',
  channels: [{ id: 'main', label: '전체 방송', templateId, ...extra }],
});

const entry = (p: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: 'c1',
  time: '08:40:00',
  at: 1_000_000,
  label: '본령',
  period: '1교시',
  s: 'pending',
  ...p,
});

describe('cuesHash: 학교 PC 시간표와 서버 설정 비교', () => {
  it('같은 시간표면 순서와 무관하게 같은 값', () => {
    const cues = expectedCues(school('csat-2'), BUILTIN_TEMPLATES, 'main');
    expect(cues.length).toBeGreaterThan(30);
    expect(cuesHash([...cues].reverse())).toBe(cuesHash(cues));
  });

  it('유형이 다르면 다른 값 (관리자가 유형을 바꿨는데 학교 PC가 새로고침 안 한 경우를 잡는다)', () => {
    const a = expectedCues(school('csat-2'), BUILTIN_TEMPLATES, 'main');
    const b = expectedCues(school('csat-3'), BUILTIN_TEMPLATES, 'main');
    expect(cuesHash(a)).not.toBe(cuesHash(b));
  });

  it('시각 하나만 바뀌어도 다른 값', () => {
    const a = expectedCues(school('csat-1'), BUILTIN_TEMPLATES, 'main');
    const b = a.map((c, i) => (i === 3 ? { ...c, time: '09:00:01' } : c));
    expect(cuesHash(a)).not.toBe(cuesHash(b));
  });

  it('학교 자체 시간표(customCues)가 있으면 그것 기준', () => {
    const custom = [{ id: 'x', time: '08:00:00', period: '1교시', label: '입실', kind: 'ment' as const, assetId: 'a' }];
    const cues = expectedCues(school('csat-1', { customCues: custom }), BUILTIN_TEMPLATES, 'main');
    expect(cues.map((c) => c.id)).toEqual(['x']);
  });

  it('없는 채널이면 빈 목록', () => {
    expect(expectedCues(school('csat-1'), BUILTIN_TEMPLATES, 'ext-1.5x')).toEqual([]);
  });
});

describe('toTimeline: 진행 상태 → 보고', () => {
  it('완료는 송출, 수동 재생은 수동, 시작 시각은 송출된 큐에만', () => {
    const cues = expectedCues(school('csat-1'), BUILTIN_TEMPLATES, 'main').slice(0, 3);
    const plan = buildPlan(cues, '2026-11-19');
    const [a, b, c] = cues.map((x) => x.id);
    const t = toTimeline(plan, { [a]: 'done', [b]: 'done', [c]: 'pending' }, { [a]: plan[0].at + 40, [b]: plan[1].at + 9000, [c]: 1 }, [b]);
    expect(t.map((e) => e.s)).toEqual(['played', 'manual', 'pending']);
    expect(t[0].t).toBe(plan[0].at + 40);
    expect(t[2].t).toBeUndefined();
    expect(t[0].time).toBe(cues[0].time);
  });
});

describe('cellState: 칸 상태', () => {
  const at = 1_000_000;
  it('자동 방송 대기가 아니면 idle', () => {
    expect(cellState(entry(), false, true, at - 1).kind).toBe('idle');
    expect(cellState(undefined, true, true, at).kind).toBe('idle');
  });

  it('송출 완료는 오차와 함께', () => {
    const c = cellState(entry({ s: 'played', t: at + 120 }), true, true, at + 5000);
    expect(c).toMatchObject({ kind: 'played', driftMs: 120 });
  });

  it(`시각이 지나도 ${MISSING_AFTER_MS / 1000}초까지는 기다리고, 그 뒤에도 보고가 없으면 missing`, () => {
    expect(cellState(entry(), true, true, at + MISSING_AFTER_MS).kind).not.toBe('missing');
    expect(cellState(entry(), true, true, at + MISSING_AFTER_MS + 1).kind).toBe('missing');
    // 연결이 끊긴 채 시각이 지나도 missing (확인 못 함 = 문제)
    expect(cellState(entry(), true, false, at + MISSING_AFTER_MS + 1).kind).toBe('missing');
  });

  it('2분 안이면 곧, 연결이 끊겼으면 offline', () => {
    expect(cellState(entry(), true, true, at - 60_000).kind).toBe('soon');
    expect(cellState(entry(), true, true, at - 10 * 60_000).kind).toBe('pending');
    expect(cellState(entry(), true, false, at - 60_000).kind).toBe('offline');
  });

  it('건너뜀·실패·재생 중은 보고 그대로', () => {
    expect(cellState(entry({ s: 'skipped' }), true, true, at).kind).toBe('skipped');
    expect(cellState(entry({ s: 'failed' }), true, true, at).kind).toBe('failed');
    expect(cellState(entry({ s: 'playing', t: at }), true, true, at + 1).kind).toBe('playing');
  });
});

describe('buildColumns: 여러 유형의 방송 시각 합치기', () => {
  it('같은 시각은 한 열, 시각 순', () => {
    const lists = ['csat-1', 'csat-3', 'csat-6'].map((id) => expectedCues(school(id), BUILTIN_TEMPLATES, 'main'));
    const cols = buildColumns(lists);
    const times = cols.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort()).toEqual(times);
    // 5교시가 있는 유형이 섞였으므로 17:45 종료령 열이 있다
    expect(times).toContain('17:45:00');
    // 16:37 종료령은 유형마다 이름이 달라 여러 개
    expect(cols.find((c) => c.time === '16:37:00')!.labels.length).toBeGreaterThan(1);
  });
});

describe('nextAcross: 전체 다음 방송', () => {
  it('가장 이른 대기 방송과 그 시각의 학교 수·미준비 수', () => {
    const now = 0;
    const rows = [
      { armed: true, ready: true, timeline: [entry({ at: 100, s: 'played' }), entry({ id: 'b', at: 500 })] },
      { armed: true, ready: false, timeline: [entry({ id: 'b', at: 500 }), entry({ id: 'c', at: 900 })] },
      { armed: false, ready: true, timeline: [entry({ id: 'z', at: 200 })] },
      { armed: true, ready: true, timeline: null },
    ];
    expect(nextAcross(rows, now)).toEqual({ at: 500, labels: ['본령'], schools: 2, notReady: 1 });
  });

  it('남은 방송이 없으면 null', () => {
    expect(nextAcross([{ armed: true, ready: true, timeline: [entry({ s: 'played' })] }], 0)).toBeNull();
  });
});

describe('devicesConflict: 같은 채널 이중 실행', () => {
  it('1대면 문제없음, 2대 이상이면 먼저 연 순서로', () => {
    expect(devicesConflict({ a: { uid: 'u', since: 1 } })).toEqual([]);
    expect(devicesConflict(null)).toEqual([]);
    const r = devicesConflict({ a: { uid: 'u1', since: 5 }, b: { uid: 'u2', since: 2 } });
    expect(r.map((d) => d.uid)).toEqual(['u2', 'u1']);
  });
});

describe('formatDrift', () => {
  it('부호와 소수 둘째 자리', () => {
    expect(formatDrift(120)).toBe('+0.12초');
    expect(formatDrift(-30)).toBe('-0.03초');
    expect(formatDrift(65_000)).toBe('+65초');
    expect(formatDrift(undefined)).toBe('');
  });
});
