import { describe, expect, it } from 'vitest';
import { outputStatus } from './audioOutput';

const amp = { deviceId: 'a1', label: '스피커 (Realtek)' };

describe('outputStatus: 출력 장치 점검 표시', () => {
  it('지원 안 하는 브라우저·장치를 안 고른 경우는 주의', () => {
    expect(outputStatus({ supported: false, choice: null, devices: null }).level).toBe('warn');
    expect(outputStatus({ supported: true, choice: null, devices: [amp] }).level).toBe('warn');
  });
  it('고른 장치가 연결돼 있으면 정상', () => {
    const s = outputStatus({ supported: true, choice: amp, devices: [amp, { deviceId: 'h', label: 'HDMI' }] });
    expect(s.level).toBe('ok');
    expect(s.text).toContain('Realtek');
  });
  it('고른 장치가 빠졌거나 보내기 실패면 문제', () => {
    expect(outputStatus({ supported: true, choice: amp, devices: [{ deviceId: 'h', label: 'HDMI' }] }).level).toBe('bad');
    expect(outputStatus({ supported: true, choice: amp, devices: [amp], error: 'NotFoundError' }).level).toBe('bad');
  });
  it('권한이 없어 목록을 못 보면 고른 장치를 믿고 정상으로 둔다', () => {
    expect(outputStatus({ supported: true, choice: amp, devices: null }).level).toBe('ok');
  });
});
