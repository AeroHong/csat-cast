import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../data/templates';
import { bestOffset } from './clock';
import {
  buildPlan,
  decide,
  initialStates,
  kstDate,
  kstEpoch,
  kstTime,
  nextPending,
  resolveCues,
  shiftPlan,
  type CueState,
} from './scheduler';
import type { Template } from './types';

const T: Template = {
  id: 't',
  name: 't',
  description: '',
  verified: true,
  cues: [
    { id: 'b', time: '08:40:00', period: '1', label: '본령', kind: 'bell', assetId: 'b' },
    { id: 'a', time: '08:10:00', period: '1', label: '입실', kind: 'ment', assetId: 'a' },
    { id: 'c', time: '10:00:00', period: '1', label: '종료', kind: 'bell', assetId: 'c' },
  ],
};
const DATE = '2026-11-19';

describe('KST 시각 변환', () => {
  it('KST 08:40은 UTC 전날 23:40이다', () => {
    expect(new Date(kstEpoch(DATE, '08:40:00')).toISOString()).toBe('2026-11-18T23:40:00.000Z');
  });
  it('왕복 변환', () => {
    const t = kstEpoch(DATE, '17:45:30');
    expect(kstDate(t)).toBe(DATE);
    expect(kstTime(t)).toBe('17:45:30');
  });
});

describe('resolveCues', () => {
  it('시각순 정렬, 비활성 큐 제외, 학교 추가 큐 포함', () => {
    const cues = resolveCues(T, {
      id: 'main',
      label: '본관',
      templateId: 't',
      disabledCueIds: ['c'],
      extraCues: [{ id: 'x', time: '08:00:00', period: '1', label: '안내', kind: 'ment', assetId: 'x', official: true }],
    });
    expect(cues.map((c) => c.id)).toEqual(['x', 'a', 'b']);
    expect(cues[0].official).toBe(false);
  });
});

describe('decide', () => {
  const plan = buildPlan(resolveCues(T), DATE);
  const at = (id: string) => plan.find((p) => p.cue.id === id)!.at;

  it('lookahead 이전에는 아무것도 하지 않는다', () => {
    expect(decide(plan, {}, at('a') - 10_000)).toEqual([]);
  });

  it('lookahead 안에 들어오면 정확한 시각으로 예약한다', () => {
    expect(decide(plan, {}, at('a') - 1_000)).toEqual([{ type: 'schedule', cueId: 'a', at: at('a') }]);
  });

  it('허용 지연(멘트 30초) 이내면 재생, 초과면 건너뛴다', () => {
    expect(decide(plan, {}, at('a') + 20_000)[0].type).toBe('schedule');
    expect(decide(plan, {}, at('a') + 31_000)[0].type).toBe('skip');
  });

  it('타종은 허용 지연이 5초다', () => {
    const s: Record<string, CueState> = { a: 'done' };
    expect(decide(plan, s, at('b') + 4_000)[0].type).toBe('schedule');
    expect(decide(plan, s, at('b') + 6_000)[0].type).toBe('skip');
  });

  it('이미 처리한 큐는 다시 결정하지 않는다', () => {
    expect(decide(plan, { a: 'scheduled' }, at('a'))).toEqual([]);
  });

  it('하루 전체를 시뮬레이션하면 모든 큐가 정확히 한 번씩 예약된다', () => {
    const full = buildPlan(resolveCues(BUILTIN_TEMPLATES[0]), DATE);
    const states: Record<string, CueState> = {};
    const scheduled: string[] = [];
    for (let now = full[0].at - 60_000; now <= full.at(-1)!.at + 60_000; now += 250) {
      for (const d of decide(full, states, now)) {
        expect(d.type).toBe('schedule');
        states[d.cueId] = 'scheduled';
        scheduled.push(d.cueId);
      }
    }
    expect(scheduled).toEqual(full.map((p) => p.cue.id));
  });

  it('PC가 30분 멈췄다 깨어나면 지난 큐는 건너뛰고 이후 큐는 정상 진행', () => {
    const states: Record<string, CueState> = {};
    const result = decide(plan, states, at('b') + 30 * 60_000);
    expect(result.map((d) => [d.cueId, d.type])).toEqual([
      ['a', 'skip'],
      ['b', 'skip'],
    ]);
  });
});

describe('initialStates', () => {
  it('중간에 시작하면 지난 큐는 skipped, 허용 지연 이내는 pending', () => {
    const plan = buildPlan(resolveCues(T), DATE);
    const s = initialStates(plan, plan[1].at + 2_000);
    expect(s).toEqual({ a: 'skipped', b: 'pending', c: 'pending' });
    expect(nextPending(plan, s)?.cue.id).toBe('b');
  });
});

describe('shiftPlan (리허설)', () => {
  it('첫 큐를 시작 시각으로 옮기고 간격을 배속만큼 줄인다', () => {
    const plan = buildPlan(resolveCues(T), DATE);
    const shifted = shiftPlan(plan, 1_000_000, 10);
    expect(shifted.map((p) => p.at)).toEqual([1_000_000, 1_000_000 + 180_000, 1_000_000 + 660_000]);
  });
});

describe('bestOffset', () => {
  it('RTT가 가장 짧은 샘플을 쓴다', () => {
    const r = bestOffset([
      { t0: 0, server: 5_000, t1: 400 },
      { t0: 1000, server: 6_030, t1: 1060 },
    ])!;
    expect(r.rtt).toBe(60);
    expect(r.offset).toBe(6_030 - 1030);
  });
});

describe('기본 시간표', () => {
  it('큐 id가 중복되지 않고 시각이 오름차순', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const ids = t.cues.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      const times = t.cues.map((c) => c.time);
      expect([...times].sort()).toEqual(times);
    }
  });
});
