import { describe, expect, it } from 'vitest';
import { describeTime, parseTime24 } from './time24';

describe('24시간제 시각 입력', () => {
  it.each([
    ['12:00', '12:00:00'],
    ['12', '12:00:00'],
    ['1200', '12:00:00'],
    ['905', '09:05:00'],
    ['13:05:30', '13:05:30'],
    ['130530', '13:05:30'],
    ['9:5', '09:05:00'],
    ['13시 5분', '13:05:00'],
    ['13시 5분 30초', '13:05:30'],
    ['오후 1:05', '13:05:00'],
    ['오후 12:10', '12:10:00'],
    ['오전 12:10', '00:10:00'],
    ['00:30', '00:30:00'],
  ])('%s → %s', (input, out) => expect(parseTime24(input)).toBe(out));

  it.each(['', '24:00', '12:60', 'abc', '오후 13:00', '1234567'])('읽을 수 없음: %s', (input) => expect(parseTime24(input)).toBeNull());

  it('오전/오후 설명', () => {
    expect(describeTime('12:00:00')).toBe('오후 12:00');
    expect(describeTime('00:05:00')).toBe('오전 12:05');
    expect(describeTime('11:59:30')).toBe('오전 11:59:30');
  });
});
