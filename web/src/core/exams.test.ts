import { describe, expect, it } from 'vitest';
import { copyExam, missingAudioCount, validateExam } from './exams';
import { checkSchedule } from './schoolSchedule';
import type { Cue, Exam } from './types';

const cue = (id: string, time: string, assetId = 'a'): Cue => ({ id, time, period: '1교시', label: id, kind: 'ment', assetId });
const exam = (over: Partial<Exam> = {}): Exam => ({
  id: 'x1',
  name: '3월 학평',
  date: '2027-03-25',
  channelId: 'main',
  cues: [cue('c1', '08:40:00'), cue('c2', '09:00:00', '')],
  updatedAt: 0,
  ...over,
});
const ctx = { today: '2027-03-01', official: [], existing: [] as Exam[] };

describe('시험 방송: 이름·날짜 검사', () => {
  it('정상 시험은 통과', () => {
    expect(validateExam(exam(), ctx)).toEqual({ errors: [], warnings: [] });
  });

  it('이름·날짜가 없으면 오류', () => {
    expect(validateExam(exam({ name: ' ', date: '' }), ctx).errors).toHaveLength(2);
  });

  it('수능 방송일과 겹치면 오류', () => {
    const r = validateExam(exam(), { ...ctx, official: [{ date: '2027-03-25', mode: 'live', label: '수능' }] });
    expect(r.errors[0]).toMatch(/수능 실전 방송일/);
  });

  it('같은 채널 같은 날 시험은 하나만 (다른 채널은 괜찮음)', () => {
    const other = exam({ id: 'x2', name: '다른 시험' });
    expect(validateExam(exam(), { ...ctx, existing: [other] }).errors[0]).toMatch(/다른 시험/);
    expect(validateExam(exam(), { ...ctx, existing: [{ ...other, channelId: 'ext' }] }).errors).toEqual([]);
  });

  it('지난 날짜는 경고만', () => {
    expect(validateExam(exam(), { ...ctx, today: '2027-04-01' }).warnings).toHaveLength(1);
  });
});

describe('시험 방송: 복사·음원 없는 줄', () => {
  it('복사하면 새 id·새 날짜, 줄 id도 새로', () => {
    const src = exam();
    const c = copyExam(src, '2027-06-04', '6월 모평');
    expect(c.id).not.toBe(src.id);
    expect(c).toMatchObject({ date: '2027-06-04', name: '6월 모평' });
    expect(c.cues.map((x) => x.id)).not.toEqual(src.cues.map((x) => x.id));
    expect(c.cues.map((x) => x.assetId)).toEqual(['a', '']);
  });

  it('음원 없는 줄 수 (삭제된 음원 포함)', () => {
    expect(missingAudioCount(exam(), new Set(['a']))).toBe(1);
    expect(missingAudioCount(exam(), new Set())).toBe(2);
  });

  it('allowMissingAudio면 음원 없는 줄은 오류 대신 경고 한 줄', () => {
    const cues = exam().cues;
    expect(checkSchedule(cues, new Set(['a'])).errors.some((e) => /음원을 고르세요/.test(e))).toBe(true);
    const r = checkSchedule(cues, new Set(['a']), { allowMissingAudio: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /음원이 없는 방송 1곳/.test(w))).toBe(true);
  });

  it('allowEmpty면 빈 시간표도 저장 가능', () => {
    expect(checkSchedule([], new Set(), { allowEmpty: true }).errors).toEqual([]);
  });
});
