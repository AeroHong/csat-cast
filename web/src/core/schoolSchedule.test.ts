import { describe, expect, it } from 'vitest';
import { resolveCues } from './scheduler';
import { checkSchedule, saveChannel } from './schoolSchedule';
import type { Cue, SchoolProfile, Template } from './types';

const cue = (id: string, time: string, extra: Partial<Cue> = {}): Cue => ({
  id,
  time,
  period: '1교시',
  label: id,
  kind: 'ment',
  assetId: 'a',
  ...extra,
});
const assets = new Set(['a']);

describe('학교 자체 시간표', () => {
  const T: Template = { id: 't', name: '평가원', description: '', verified: true, cues: [cue('official', '08:40:00', { official: true })] };

  it('학교 시간표가 있으면 평가원 유형 대신 그것만 시각순으로 방송한다', () => {
    const cues = resolveCues(T, { id: 'main', label: '전체', templateId: 't', customCues: [cue('b', '09:00:00'), cue('a', '08:00:00')] });
    expect(cues.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cues.every((c) => c.official === false)).toBe(true);
  });

  it('지정된 평가원 유형이 없어도 학교 시간표로 방송한다', () => {
    expect(resolveCues(undefined, { id: 'main', label: '전체', templateId: '없음', customCues: [cue('a', '08:00:00')] })).toHaveLength(1);
  });

  it('시각 형식·내용·음원이 빠지면 저장하지 않는다', () => {
    const { errors } = checkSchedule([cue('x', '8:00', { label: '', assetId: '' }), cue('y', '09:00:00', { assetId: 'deleted' })], assets);
    expect(errors.join('\n')).toMatch(/시각 형식 오류/);
    expect(errors.join('\n')).toMatch(/내용을 적으세요/);
    expect(errors.join('\n')).toMatch(/음원을 고르세요/);
    expect(errors.join('\n')).toMatch(/고른 음원이 없습니다/);
    expect(checkSchedule([], assets).errors).toHaveLength(1);
  });

  it('겹치는 시각, 종료 없는 시험 시작은 확인을 요청한다', () => {
    const { errors, warnings } = checkSchedule(
      [cue('s', '08:40:00', { examStart: true }), cue('n', '08:40:00'), cue('e', '10:00:00')],
      assets,
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/08:40:00에 방송이 둘 이상 겹칩니다/);
    expect(warnings.join('\n')).toMatch(/종료\(종료령\)가 없습니다/);
  });

  it('로컬 모드 저장: 학교 시간표를 지우면 키째 빠진다 (서버는 undefined 값을 받지 않음)', async () => {
    const mem = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;
    const p: SchoolProfile = { neisCode: 'LOCAL', name: '로컬', channels: [{ id: 'main', label: '전체', templateId: 't' }] };
    const withCustom = await saveChannel(p, 'main', { customCues: [cue('a', '08:00:00')] });
    expect(withCustom.channels[0].customCues).toHaveLength(1);
    const reverted = await saveChannel(withCustom, 'main', { customCues: undefined });
    expect('customCues' in reverted.channels[0]).toBe(false);
    expect(JSON.parse(mem.get('csat-cast:local-profile')!).channels[0]).toEqual({ id: 'main', label: '전체', templateId: 't' });
  });
});
