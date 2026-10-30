import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../core/validate';
import { BUILTIN_TEMPLATES, csatSituation, csatTemplateId } from './templates';

const byId = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!;
const times = (id: string) => byId(id).cues.map((c) => `${c.time.slice(0, 5)} ${c.assetId}`);

describe('2027 수능 안내방송 시간표 (평가원 대본 6개 유형)', () => {
  it('6개 유형 모두 검사를 통과하고 시각순이다', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual(['csat-1', 'csat-2', 'csat-3', 'csat-4', 'csat-5', 'csat-6']);
    for (const t of BUILTIN_TEMPLATES) {
      expect(validateTemplate(t)).toEqual([]);
      const ts = t.cues.map((c) => c.time);
      expect([...ts].sort()).toEqual(ts);
    }
  });

  it('대본 안내대로 시험장 상황 → 유형 번호가 정해진다', () => {
    expect(csatTemplateId('split', 4)).toBe('csat-1');
    expect(csatTemplateId('split', 5)).toBe('csat-2'); // 대본 예시: 혼합시험실 없고 5교시 종료 → 2)
    expect(csatTemplateId('mixed', 'mixed')).toBe('csat-6'); // 대본 예시: 혼합시험실 있고 4·5교시 종료 → 6)
    for (const t of BUILTIN_TEMPLATES) {
      const s = csatSituation(t.id)!;
      expect(csatTemplateId(s.inquiry, s.end)).toBe(t.id);
    }
  });

  it('유형별 차이는 15:30 준비령(A/B)과 16:37 종료령(A/B/C), 5교시 유무뿐이다', () => {
    const at = (id: string, hhmm: string) => byId(id).cues.filter((c) => c.time.startsWith(hhmm)).map((c) => c.assetId);
    expect(['csat-1', 'csat-2', 'csat-3'].map((id) => at(id, '15:30'))).toEqual([['p4-inq-ready-a'], ['p4-inq-ready-a'], ['p4-inq-ready-a']]);
    expect(['csat-4', 'csat-5', 'csat-6'].map((id) => at(id, '15:30'))).toEqual([['p4-inq-ready-b'], ['p4-inq-ready-b'], ['p4-inq-ready-b']]);
    expect(['csat-1', 'csat-2', 'csat-3'].map((id) => at(id, '16:37'))).toEqual([['p4-end-a'], ['p4-end-b'], ['p4-end-c']]);
    expect(byId('csat-1').cues.some((c) => c.id.startsWith('p5-'))).toBe(false);
    expect(byId('csat-3').cues.filter((c) => c.id.startsWith('p5-'))).toHaveLength(6);
    const common = (id: string) => times(id).filter((x) => !/15:30|16:37|p5-/.test(x));
    for (const t of BUILTIN_TEMPLATES) expect(common(t.id)).toEqual(common('csat-1'));
  });

  it('13:10 영어 듣기평가 시간에는 아무것도 송출하지 않는다', () => {
    for (const t of BUILTIN_TEMPLATES) expect(t.cues.filter((c) => c.time >= '13:06:00' && c.time < '14:10:00')).toEqual([]);
  });

  it('5교시까지 하는 유형은 37개, 4교시로 끝나는 유형은 31개 방송', () => {
    expect(byId('csat-2').cues).toHaveLength(37); // 40개 파일 중 준비령 B, 종료령 A·C 제외
    expect(byId('csat-1').cues).toHaveLength(31);
  });

  it('16:05 합본 파일(종료령 + 16:07 본령)은 늦어도 이어서 재생해 본령을 놓치지 않는다', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const combo = t.cues.find((c) => c.assetId === 'p4-t1-end')!;
      expect(combo.catchUp).toBe(true);
      expect(combo.lateToleranceSec).toBe(125); // 본령(파일 120초 지점) 시작 5초 뒤까지
      expect(t.cues.some((c) => c.time === '16:07:00')).toBe(false); // 16:07 본령은 따로 없음
    }
  });
});
