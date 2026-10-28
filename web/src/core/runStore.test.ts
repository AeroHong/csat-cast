import { describe, expect, it } from 'vitest';
import { restoreStates } from './runStore';
import type { PlannedCue } from './scheduler';

const cue = (id: string, kind: 'bell' | 'ment' = 'ment') => ({ id, time: '', period: '', label: id, kind, assetId: id });
const plan: PlannedCue[] = [
  { cue: cue('a'), at: 1_000 },
  { cue: cue('b', 'bell'), at: 60_000 },
  { cue: cue('c'), at: 120_000 },
  { cue: cue('d'), at: 600_000 },
];

describe('restoreStates (새로고침 후 이어하기)', () => {
  it('저장된 상태가 없으면 처음 시작과 같다', () => {
    expect(restoreStates(plan, undefined, 61_000)).toEqual({ a: 'skipped', b: 'pending', c: 'pending', d: 'pending' });
  });

  it('이미 송출한 큐는 허용 지연 이내라도 다시 송출하지 않는다', () => {
    const s = restoreStates(plan, { a: 'done', b: 'done' }, 62_000);
    expect(s.b).toBe('done');
  });

  it('재생 도중 새로고침된 큐는 완료로 처리해 중복 송출을 막는다', () => {
    const s = restoreStates(plan, { a: 'done', b: 'done', c: 'playing' }, 125_000);
    expect(s.c).toBe('done');
  });

  it('예약만 되고 아직 시각이 안 된 큐는 다시 예약 대상이 된다', () => {
    const s = restoreStates(plan, { c: 'scheduled' }, 119_000);
    expect(s.c).toBe('pending');
  });

  it('PC가 꺼져 있던 동안 지나간 큐는 건너뜀, 이후 큐는 대기', () => {
    const s = restoreStates(plan, { a: 'done' }, 300_000);
    expect(s).toEqual({ a: 'done', b: 'skipped', c: 'skipped', d: 'pending' });
  });
});
