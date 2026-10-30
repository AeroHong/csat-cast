export type CueKind = 'bell' | 'ment';

/** 시간표의 한 항목 (타종 또는 멘트 1회 재생). */
export interface Cue {
  id: string;
  /** KST 기준 "HH:MM:SS" */
  time: string;
  period: string;
  label: string;
  kind: CueKind;
  assetId: string;
  /** 예정 시각보다 이만큼 늦었으면 재생하지 않고 건너뛴다. 기본값은 kind에 따라 다름. */
  lateToleranceSec?: number;
  /**
   * true면 늦게 시작할 때 늦은 만큼 앞부분을 건너뛰고 재생해, 파일 뒤쪽 방송이 제시각에 나가게 한다.
   * 여러 방송이 한 파일에 든 합본(예: 16:05 종료령 + 16:07 본령)용. 새로고침으로 재생이 끊겨도 이어서 재생한다.
   */
  catchUp?: boolean;
  /** true면 공식 시간표 항목 (학교에서 시간 변경 불가) */
  official?: boolean;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  /** 평가원 공고로 검증 완료 여부. false면 화면에 경고 표시. */
  verified: boolean;
  cues: Cue[];
}

export type AssetSource = 'builtin' | 'upload' | 'tts';

export interface Asset {
  id: string;
  label: string;
  /** 내려받을 주소. storagePath가 있으면 캐시 이름으로만 쓴다 (음원이 바뀌면 함께 바뀌는 고정 주소) */
  url: string;
  /** Firebase Storage 경로. 있으면 여기서 내려받는다 (로그인 필요) */
  storagePath?: string;
  source: AssetSource;
}

/** 학교별 채널 설정 (채널 1개 = 플레이어 1개) */
export interface ChannelConfig {
  id: string;
  label: string;
  templateId: string;
  /** 학교에서 끈 공식 큐 */
  disabledCueIds?: string[];
  /** 학교에서 추가한 큐 */
  extraCues?: Cue[];
}

/** 4교시 탐구: 1과목·2과목 선택자를 시험실별로 나눔(split) / 한 시험실에 섞임(mixed) */
export type InquiryRooms = 'split' | 'mixed';
/** 시험장 종료 교시: 모두 4교시 / 모두 5교시 / 섞임 */
export type EndPeriod = 4 | 5 | 'mixed';

export interface SchoolProfile {
  neisCode: string;
  name: string;
  venueType?: string;
  /** 시험장 상황 (시간표 유형을 고르는 근거). 채널의 templateId가 실제로 쓰인다. */
  inquiryRooms?: InquiryRooms;
  endPeriod?: EndPeriod;
  inquiryNote?: string;
  channels: ChannelConfig[];
}

export type RunMode = 'live' | 'test';

/** 특정 날짜에 실제 시각대로 자동 방송할 날 (실전, 공식 리허설) */
export interface ArmedDate {
  date: string; // YYYY-MM-DD (KST)
  mode: RunMode;
  label: string;
}

export interface GlobalConfig {
  armedDates: ArmedDate[];
  /** 이 시간대에는 테스트 기능을 막는다 (실전 보호) */
  liveLockWindow: { start: string; end: string };
}
