import type { Cue, EndPeriod, GlobalConfig, InquiryRooms, Template } from '../core/types';

/**
 * 기본 시간표 (앱에 탑재되는 오프라인 기본값).
 * Firestore templates/{id} 문서가 있으면 그것이 우선한다.
 *
 * 출처: 「2027학년도 대학수학능력시험 안내방송 대본」(2026-10-05).
 * 대본의 음원은 시험장 상황에 따라 6개 유형(폴더 1~6)으로 나뉘며, 차이는 두 곳뿐이다.
 *   - 15:30 탐구 준비령: A(선택과목 수에 따라 시험실 구분) / B(1·2과목 선택자 혼합 시험실)
 *   - 16:37 4교시 종료령: A(4교시로 종료) / B(5교시로 종료) / C(4·5교시 종료 혼합)
 * assetId는 큐 id와 같다 (public/audio/builtin/manifest.json, scripts/import-audio.ts로 생성).
 *
 * 연장 시험실(1.5배/1.7배 등)은 이 대본에 없으므로 평가원 공식 시간표를 받아 따로 등록한다.
 */
const c = (id: string, time: string, period: string, label: string, kind: Cue['kind'] = 'ment'): Cue => ({
  id,
  time,
  period,
  label,
  kind,
  assetId: id,
  official: true,
});
/** 시험 시작(본령) / 종료(종료령): 본령이 늦으면 종료령까지 같은 만큼 늦춘다 */
const start = (cue: Cue): Cue => ({ ...cue, examStart: true });
const end = (cue: Cue): Cue => ({ ...cue, examEnd: true });

const P0 = '시험 준비';
const P1 = '1교시 국어';
const P2 = '2교시 수학';
const P3 = '3교시 영어';
const P4 = '4교시 한국사·탐구';
const P5 = '5교시 제2외국어/한문';

const morning: Cue[] = [
  c('p0-staff', '08:05:00', P0, '감독관 입실'),
  c('p0-notice', '08:10:00', P0, '입실 완료 · 유의사항 안내'),

  c('p1-prep', '08:25:00', P1, '예비령 (답안지 배부)'),
  c('p1-ready', '08:35:00', P1, '준비령 (문제지 배부)'),
  start(c('p1-start', '08:40:00', P1, '본령 (시험 시작)', 'bell')),
  c('p1-10min', '09:50:00', P1, '종료 10분 전'),
  end(c('p1-end', '10:00:00', P1, '종료령', 'bell')),

  c('p2-staff', '10:15:00', P2, '감독관 입실'),
  c('p2-prep', '10:20:00', P2, '예비령 (답안지 배부)'),
  c('p2-ready', '10:25:00', P2, '준비령 (문제지 배부)'),
  start(c('p2-start', '10:30:00', P2, '본령 (시험 시작)', 'bell')),
  c('p2-10min', '12:00:00', P2, '종료 10분 전'),
  end(c('p2-end', '12:10:00', P2, '종료령 (점심시간)', 'bell')),

  // 13:10 본령은 타종 없이 영어 듣기평가 방송으로 이어진다 → 이 앱은 아무것도 송출하지 않는다.
  c('p3-staff', '12:55:00', P3, '감독관 입실'),
  c('p3-prep', '13:00:00', P3, '예비령 (답안지 배부)'),
  c('p3-ready', '13:05:00', P3, '준비령 (문제지 배부) · 13:10 듣기평가로 이어짐'),
  c('p3-10min', '14:10:00', P3, '종료 10분 전'),
  end(c('p3-end', '14:20:00', P3, '종료령', 'bell')),

  c('p4-staff', '14:35:00', P4, '감독관 입실'),
  c('p4-prep', '14:40:00', P4, '한국사 예비령 (답안지 배부)'),
  c('p4-ready', '14:45:00', P4, '한국사 준비령 (문제지 배부)'),
  start(c('p4-start', '14:50:00', P4, '한국사 본령', 'bell')),
  c('p4-kh-5min', '15:15:00', P4, '한국사 종료 5분 전'),
  end(c('p4-kh-end', '15:20:00', P4, '한국사 종료령', 'bell')),
  c('p4-inq-prep', '15:25:00', P4, '탐구 예비령 (답안지 배부)'),
];

const inquiryReady: Record<InquiryRooms, Cue> = {
  split: c('p4-inq-ready-a', '15:30:00', P4, '탐구 준비령 A (선택과목 구분 시험실)'),
  mixed: c('p4-inq-ready-b', '15:30:00', P4, '탐구 준비령 B (선택과목 혼합 시험실)'),
};

const inquiry: Cue[] = [
  start(c('p4-t1-start', '15:35:00', P4, '탐구 첫 번째 본령', 'bell')),
  c('p4-t1-5min', '16:00:00', P4, '탐구 첫 번째 종료 5분 전'),
  // 한 파일에 16:05 종료령과 16:07 두 번째 본령(파일 120.1초 지점)이 들어 있다. 본령만 따로 낼 수 없고
  // 앞을 잘라 내면 방송 사고이므로, 늦어도 건너뛰지 않고 처음부터 끝까지 튼다(10분까지).
  // 늦게 나가면 두 번째 시험도 늦게 시작하므로 16:32·16:37을 같은 만큼 늦춘다 (첫 번째 종료 + 두 번째 시작).
  {
    ...c('p4-t1-end', '16:05:00', P4, '탐구 첫 번째 종료령 · 16:07 두 번째 본령', 'bell'),
    examEnd: true,
    examStart: true,
    lateToleranceSec: 600,
    restartIfInterrupted: true,
  },
  c('p4-t2-5min', '16:32:00', P4, '탐구 두 번째 종료 5분 전'),
];

const period4End: Record<EndPeriod, Cue> = {
  4: end(c('p4-end-a', '16:37:00', P4, '4교시 종료령 A (4교시로 종료)', 'bell')),
  5: end(c('p4-end-b', '16:37:00', P4, '4교시 종료령 B (5교시로 종료)', 'bell')),
  mixed: end(c('p4-end-c', '16:37:00', P4, '4교시 종료령 C (4·5교시 종료 혼합)', 'bell')),
};

const period5: Cue[] = [
  c('p5-staff', '16:50:00', P5, '감독관 입실'),
  c('p5-prep', '16:55:00', P5, '예비령 (답안지 배부)'),
  c('p5-ready', '17:00:00', P5, '준비령 (문제지 배부)'),
  start(c('p5-start', '17:05:00', P5, '본령 (시험 시작)', 'bell')),
  c('p5-10min', '17:35:00', P5, '종료 10분 전'),
  end(c('p5-end', '17:45:00', P5, '종료령 (시험 종료)', 'bell')),
];

export const INQUIRY_ROOMS_LABEL: Record<InquiryRooms, string> = {
  split: '선택과목 구분 시험실',
  mixed: '선택과목 혼합 시험실',
};

export const END_PERIOD_LABEL: Record<EndPeriod, string> = {
  4: '4교시로 종료',
  5: '5교시로 종료',
  mixed: '종료시간 혼합(4-5교시)',
};

/** 평가원 음원 폴더 번호와 같은 순서: 1~3 = 구분 시험실, 4~6 = 혼합 시험실 / 각각 4교시·5교시·혼합 종료 */
const TYPES: { no: number; inquiry: InquiryRooms; end: EndPeriod }[] = [
  { no: 1, inquiry: 'split', end: 4 },
  { no: 2, inquiry: 'split', end: 5 },
  { no: 3, inquiry: 'split', end: 'mixed' },
  { no: 4, inquiry: 'mixed', end: 4 },
  { no: 5, inquiry: 'mixed', end: 5 },
  { no: 6, inquiry: 'mixed', end: 'mixed' },
];

/** 시험장 상황 → 시간표 id */
export function csatTemplateId(inquiry: InquiryRooms, end: EndPeriod): string {
  return `csat-${TYPES.find((t) => t.inquiry === inquiry && t.end === end)!.no}`;
}

/** 시간표 id → 시험장 상황 (2027 수능 유형이 아니면 undefined) */
export function csatSituation(templateId: string): { inquiry: InquiryRooms; end: EndPeriod } | undefined {
  const t = TYPES.find((x) => `csat-${x.no}` === templateId);
  return t && { inquiry: t.inquiry, end: t.end };
}

export const BUILTIN_TEMPLATES: Template[] = TYPES.map(({ no, inquiry: inq, end }) => ({
  id: `csat-${no}`,
  name: `유형 ${no}: ${INQUIRY_ROOMS_LABEL[inq]} · ${END_PERIOD_LABEL[end]}`,
  description:
    `4교시 탐구 ${inq === 'split' ? '1과목·2과목 선택자를 시험실별로 나눈' : '1과목·2과목 선택자가 한 시험실에 섞인'} 시험장, ` +
    (end === 4 ? '모든 시험실이 4교시로 끝남' : end === 5 ? '모든 시험실이 5교시까지 진행' : '4교시로 끝나는 시험실과 5교시까지 하는 시험실이 섞임'),
  verified: true,
  cues: [...morning, inquiryReady[inq], ...inquiry, period4End[end], ...(end === 4 ? [] : period5)],
}));

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  armedDates: [
    { date: '2026-11-18', mode: 'test', label: '예비소집일 전체 리허설' },
    { date: '2026-11-19', mode: 'live', label: '2027학년도 수능' },
  ],
  liveLockWindow: { start: '07:00:00', end: '18:30:00' },
};
