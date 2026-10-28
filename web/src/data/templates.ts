import type { Cue, GlobalConfig, Template } from '../core/types';

/**
 * 기본 시간표 (앱에 탑재되는 오프라인 기본값).
 * Firestore templates/{id} 문서가 있으면 그것이 우선한다.
 *
 * ⚠ 아래 시각은 예년 기준 초안이다. 2027학년도 평가원 공고로 검증한 뒤 verified=true로 바꿀 것.
 * assetId는 기본적으로 큐 id와 같다 (public/audio/builtin/manifest.json에서 파일과 연결).
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

const P1 = '1교시 국어';
const P2 = '2교시 수학';
const P3 = '3교시 영어';
const P4 = '4교시 한국사·탐구';
const P5 = '5교시 제2외국어/한문';

const periods1to4: Cue[] = [
  c('p1-entry', '08:10:00', P1, '입실 완료'),
  c('p1-prep', '08:25:00', P1, '예비령 (답안지 배부)'),
  c('p1-ready', '08:35:00', P1, '준비령 (문제지 배부)'),
  c('p1-start', '08:40:00', P1, '본령 (시험 시작)', 'bell'),
  c('p1-10min', '09:50:00', P1, '종료 10분 전'),
  c('p1-5min', '09:55:00', P1, '종료 5분 전'),
  c('p1-end', '10:00:00', P1, '종료령', 'bell'),

  c('p2-prep', '10:20:00', P2, '예비령 (답안지 배부)'),
  c('p2-ready', '10:25:00', P2, '준비령 (문제지 배부)'),
  c('p2-start', '10:30:00', P2, '본령 (시험 시작)', 'bell'),
  c('p2-10min', '12:00:00', P2, '종료 10분 전'),
  c('p2-5min', '12:05:00', P2, '종료 5분 전'),
  c('p2-end', '12:10:00', P2, '종료령 (점심시간)', 'bell'),

  c('p3-prep', '13:00:00', P3, '예비령 (답안지 배부)'),
  c('p3-ready', '13:05:00', P3, '준비령 (문제지 배부)'),
  c('p3-start', '13:10:00', P3, '본령 (듣기평가 시작)', 'bell'),
  c('p3-10min', '14:10:00', P3, '종료 10분 전'),
  c('p3-5min', '14:15:00', P3, '종료 5분 전'),
  c('p3-end', '14:20:00', P3, '종료령', 'bell'),

  c('p4-prep', '14:40:00', P4, '예비령 (답안지 배부)'),
  c('p4-ready', '14:45:00', P4, '준비령 (한국사 문제지 배부)'),
  c('p4-start', '14:50:00', P4, '한국사 본령', 'bell'),
  c('p4-kh-5min', '15:15:00', P4, '한국사 종료 5분 전'),
  c('p4-kh-end', '15:20:00', P4, '한국사 종료령 (문제지 회수)', 'bell'),
  c('p4-inq-ready', '15:30:00', P4, '탐구 문제지 배부'),
  c('p4-t1-start', '15:35:00', P4, '탐구 제1선택 본령', 'bell'),
  c('p4-t1-5min', '16:00:00', P4, '탐구 제1선택 종료 5분 전'),
  c('p4-t1-end', '16:05:00', P4, '탐구 제1선택 종료령 (문제지 회수)', 'bell'),
  c('p4-t2-start', '16:07:00', P4, '탐구 제2선택 본령', 'bell'),
  c('p4-t2-5min', '16:32:00', P4, '탐구 제2선택 종료 5분 전'),
  c('p4-t2-end', '16:37:00', P4, '4교시 종료령', 'bell'),
];

const period5: Cue[] = [
  c('p5-prep', '16:55:00', P5, '예비령 (답안지 배부)'),
  c('p5-ready', '17:00:00', P5, '준비령 (문제지 배부)'),
  c('p5-start', '17:05:00', P5, '본령 (시험 시작)', 'bell'),
  c('p5-5min', '17:40:00', P5, '종료 5분 전'),
  c('p5-end', '17:45:00', P5, '종료령 (시험 종료)', 'bell'),
];

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'general-5',
    name: '일반 시험장 (5교시까지)',
    description: '제2외국어/한문 응시자가 있는 시험장',
    verified: false,
    cues: [...periods1to4, ...period5],
  },
  {
    id: 'general-4',
    name: '일반 시험장 (4교시 종료)',
    description: '5교시 응시자가 없는 시험장',
    verified: false,
    cues: periods1to4,
  },
  // 연장 시험실(1.5배/1.7배 등)은 평가원 공식 시간표를 받아 admin 화면/seed로 등록한다.
];

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  armedDates: [
    { date: '2026-11-18', mode: 'test', label: '예비소집일 전체 리허설' },
    { date: '2026-11-19', mode: 'live', label: '2027학년도 수능' },
  ],
  liveLockWindow: { start: '07:00:00', end: '18:30:00' },
};
