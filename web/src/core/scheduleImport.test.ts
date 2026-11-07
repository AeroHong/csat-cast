import { describe, expect, it } from 'vitest';
import { assignByFileName, parseScheduleRows, parseTimeCell, timeFromFileName } from './scheduleImport';

const t = (hhmm: string) => new Date(`1899-12-30T${hhmm}:00.000Z`);
const id = (time: string, i: number) => `x-${time.replace(/:/g, '')}-${i}`;

/** 선유고 1.5배 시나리오 엑셀(time table 시트)과 같은 모양 */
const SHEET: unknown[][] = [
  ['교시', '구분', '타종시간', '비고'],
  ['1교시', '감독관 입실 안내', t('08:05'), null],
  ['1교시', '감독관 입실 완료 시간', t('08:10'), null],
  ['1교시', '예비령', t('08:25'), null],
  [null, '준비령', t('08:35'), null],
  [null, '본령', t('08:40'), null],
  [null, '종료10분전', t('10:30'), null],
  [null, '종료령', t('10:40'), null],
  ['점심', '점심시간 별도 타종 없음', null, '13:30~14:15'],
  ['3교시', '준비령', t('14:20'), null],
  [null, '영어영역 시작', t('14:25'), '* 별도 타종 없이 14:22 듣기평가로 시작'],
  [null, '종료10분전', t('16:00'), '(멜로디 및 타종 없음)'],
  [null, '종료령', t('16:10'), null],
  ['4교시', '탐구 1선택 본령', t('17:30'), null],
  [null, '탐구 1선택 종료령', t('18:15'), null],
  [null, '탐구 2선택 본령', t('18:17'), null],
  [null, '탐구 2선택 종료령', t('19:02'), null],
  ['5교시', '종료령', t('20:25'), null],
  ['5교시', '종료령', t('20:25'), null],
];

describe('parseTimeCell', () => {
  it('엑셀 날짜·숫자·글자 시각을 읽는다', () => {
    expect(parseTimeCell(t('08:05'))).toBe('08:05:00');
    expect(parseTimeCell(0.5)).toBe('12:00:00');
    expect(parseTimeCell('8:05')).toBe('08:05:00');
    expect(parseTimeCell('18시 17분')).toBe('18:17:00');
    expect(parseTimeCell('점심')).toBeNull();
    expect(parseTimeCell(null)).toBeNull();
  });
});

describe('timeFromFileName', () => {
  it('파일 이름 앞의 시각을 읽는다', () => {
    expect(timeFromFileName('1710_한국사종료5분전.mp3')).toBe('17:10:00');
    expect(timeFromFileName('0805.mp3')).toBe('08:05:00');
    expect(timeFromFileName('805 감독관.mp3')).toBe('08:05:00');
    expect(timeFromFileName('17-10 종료.wav')).toBe('17:10:00');
    expect(timeFromFileName('181500.mp3')).toBe('18:15:00');
    expect(timeFromFileName('18_15_종료령.mp3')).toBe('18:15:00');
    expect(timeFromFileName('감독관 입실.mp3')).toBeNull();
    expect(timeFromFileName('2575.mp3')).toBeNull();
  });
});

describe('parseScheduleRows', () => {
  const { cues, notes } = parseScheduleRows(SHEET, id);
  const at = (hhmm: string) => cues.find((c) => c.time.startsWith(hhmm));

  it('교시를 이어 쓰고 평가원 교시 이름으로 바꾼다', () => {
    expect(at('08:35')?.period).toBe('1교시 국어');
    expect(at('16:10')?.period).toBe('3교시 영어');
  });

  it('타종시간 없는 줄과 중복 줄은 빼고, 중복은 알린다', () => {
    expect(cues.some((c) => c.label.includes('점심'))).toBe(false);
    expect(cues.filter((c) => c.time === '20:25:00')).toHaveLength(1);
    expect(notes.some((n) => n.includes('두 번'))).toBe(true);
  });

  it('본령은 시험 시작·타종, 종료령은 시험 종료·타종으로 표시한다', () => {
    expect(at('08:40')).toMatchObject({ examStart: true, kind: 'bell' });
    expect(at('10:40')).toMatchObject({ examEnd: true, kind: 'bell' });
    expect(at('10:30')).toMatchObject({ kind: 'ment' });
    expect(at('10:30')?.examStart).toBeUndefined();
  });

  it('"타종 없이" 듣기평가로 시작하는 영어는 준비령에 이어 붙이고 시험 시작으로 보지 않는다', () => {
    expect(at('14:25')).toBeUndefined();
    expect(at('14:20')?.label).toBe('준비령 · 14:25 영어영역 시작');
    expect(at('14:20')?.examStart).toBeUndefined();
  });

  it('"(멜로디 및 타종 없음)"은 멘트 방송이므로 그대로 넣는다', () => {
    expect(at('16:00')).toMatchObject({ label: '종료10분전', kind: 'ment' });
  });

  it('종료령 2분 뒤 본령은 합본 파일로 보고 하나로 합친다', () => {
    expect(at('18:17')).toBeUndefined();
    expect(at('18:15')).toMatchObject({
      label: '탐구 1선택 종료령 · 18:17 탐구 2선택 본령',
      examEnd: true,
      examStart: true,
      restartIfInterrupted: true,
      lateToleranceSec: 600,
    });
  });

  it('비고에 "포함"이 있으면 시간 간격과 상관없이 앞 방송에 합친다', () => {
    const r = parseScheduleRows(
      [
        ['교시', '구분', '타종시간', '방송 내용'],
        ['4교시', '탐구 1선택 종료령', '18:15', '♪ 멜로디-3'],
        ['4교시', '탐구 2선택 본령', '18:20', '위 시나리오 방송 파일에 포함'],
      ],
      id,
    );
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].examStart).toBe(true);
  });

  it('대본 본문(긴 글) 안의 "포함"·"타종 없이"에는 걸리지 않는다', () => {
    const script = `♪ 멜로디-5\n◦수험생 및 감독관 입실 완료시간입니다. ${'휴대폰 등 전자기기를 포함하여 모든 물품은 제출합니다. '.repeat(3)}듣기평가는 타종 없이 시작됩니다.`;
    const r = parseScheduleRows(
      [
        ['교시', '구분', '타종시간', '방송 내용'],
        ['1교시', '감독관 입실 안내', '8:05', '감독관께서 입실하실 시간입니다.'],
        ['1교시', '감독관 입실 완료 시간', '8:10', script],
      ],
      id,
    );
    expect(r.cues).toHaveLength(2);
  });

  it('머리글이 없으면 알기 쉬운 오류를 낸다', () => {
    expect(() => parseScheduleRows([['a', 'b']], id)).toThrow(/머리글/);
  });
});

describe('assignByFileName', () => {
  it('음원이 빈 줄에 같은 시각 파일을 넣고, 같은 시각이 여럿이면 최근 것을 쓴다', () => {
    const { cues } = parseScheduleRows(SHEET, id);
    const r = assignByFileName(cues, [
      { id: 'u-old', fileName: '1815_종료령.mp3', uploadedAt: 1 },
      { id: 'u-new', fileName: '1815_종료령_수정.mp3', uploadedAt: 2 },
      { id: 'u-x', fileName: '감독관.mp3', uploadedAt: 3 },
    ]);
    expect(r.assigned).toBe(1);
    expect(r.cues.find((c) => c.time === '18:15:00')?.assetId).toBe('u-new');
  });
});
