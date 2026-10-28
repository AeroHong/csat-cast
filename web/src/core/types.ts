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
  url: string;
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

export interface SchoolProfile {
  neisCode: string;
  name: string;
  venueType?: string;
  lastPeriod: 4 | 5;
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
