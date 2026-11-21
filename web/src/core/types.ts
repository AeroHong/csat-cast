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
  /** 시험 방송용 학교 음원이면 그 시험 (없으면 수능 시간표용). 수능·시험 음원 목록을 나눠 보여 준다 */
  examId?: string;
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
  /**
   * 학교 자체 시간표. 있으면 평가원 유형(templateId) 대신 이것만 방송한다.
   * 평가원 음원·시간표가 맞지 않는 시험장(경증 시각장애 시험장 등)이 직접 만든다.
   */
  customCues?: Cue[];
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
  /** 시험장 번호 (시험지구 일람표 순번) */
  examNo?: number | null;
  /** 별도 운영 시험장 (경증 시각장애 1.5배 등) — 학교 자체 시간표로 방송하고 관리자 화면에 따로 표시 */
  special?: boolean;
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
  /**
   * 수능 모드. 켜져 있을 때만 학교 PC가 평가원 시간표·음원을 쓰고 지정 방송일(armedDates)에 자동 방송한다.
   * 수능이 끝나면 관리자가 끈다 → 평가원 음원을 받지 않고 시험 방송만 쓴다. 없으면 꺼짐.
   */
  csatMode?: boolean;
}

/**
 * 외부 시험 방송 (학력평가·모의평가 등). 학교가 직접 만들고 정한 날짜에 실제 시각대로 자동 방송한다.
 * 음원은 학교 음원(schools/{코드}/assets)을 수능 시간표와 함께 쓴다.
 */
export interface Exam {
  id: string;
  /** 예: 2027 3월 전국연합학력평가 */
  name: string;
  /** YYYY-MM-DD (KST) */
  date: string;
  /** 방송할 채널 (기본 main) */
  channelId: string;
  /** 음원을 아직 고르지 않은 줄(assetId '')도 저장할 수 있다 — 그 줄은 연결 전까지 송출되지 않는다 */
  cues: Cue[];
  updatedAt: number;
  updatedBy?: string;
}
