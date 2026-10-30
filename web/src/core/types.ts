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
   * 시험 시작(본령). 늦게 울리면 늦은 만큼 이 시험의 뒤 방송(종료 n분 전·종료령)을 늦춰 시험 시간을 보장한다.
   * 다음 교시는 원래 시각대로 (쉬는 시간이 줄어든다).
   */
  examStart?: boolean;
  /** 시험 종료(종료령). 본령 지연으로 늦춘 시각은 여기까지만 적용된다 */
  examEnd?: boolean;
  /**
   * true면 재생 도중 끊겼을 때(새로고침·PC 멈춤) 송출 완료로 넘기지 않고 허용 시간 안이면 처음부터 다시 재생한다.
   * 한 파일에 방송이 여러 개 든 합본(16:05 종료령 + 16:07 본령)에서 뒤쪽 방송을 잃지 않기 위함.
   */
  restartIfInterrupted?: boolean;
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
