// 확장자를 붙여 scripts/(node 직접 실행)에서도 불러올 수 있게 한다
import { resolveCues, type CueState, type PlannedCue } from './scheduler.ts';
import type { Cue, SchoolProfile, Template } from './types';

/**
 * 관리자 송출 현황판의 순수 로직 (화면·서버와 분리해 테스트한다).
 * 학교 PC는 자기가 실제로 틀 시간표(timeline)와 큐별 결과를 보고하고,
 * 관리자 화면은 그것을 서버 설정 기준 시간표와 맞춰 학교 × 방송 시각 표로 보여 준다.
 */

/** 학교 PC가 보고하는 큐 하나의 상태 */
export type CueReport = 'pending' | 'scheduled' | 'playing' | 'played' | 'skipped' | 'failed' | 'manual';

/** status/{학교}/{채널}/timeline 의 한 줄 */
export interface TimelineEntry {
  id: string;
  /** 시간표상 시각 "HH:MM:SS" (리허설로 당겨도 원래 시각) */
  time: string;
  /** 실제로 송출할 시각 (본령 지연·리허설 이동 반영, 서버 시각 epoch ms) */
  at: number;
  label: string;
  period: string;
  s: CueReport;
  /** 실제로 소리가 시작된 시각 */
  t?: number;
}

/** 시각이 이만큼 지났는데 송출 보고가 없으면 '보고 없음'(빨강) */
export const MISSING_AFTER_MS = 15_000;
/** 이 안에 나갈 방송은 '곧' */
export const SOON_MS = 2 * 60_000;

/** 큐 목록의 지문. 학교 PC와 관리자 화면이 같은 함수로 계산해 시간표가 같은지 비교한다. */
export function cuesHash(cues: Cue[]): string {
  const text = [...cues]
    .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    .map((c) => [c.id, c.time, c.assetId, c.examStart ? 'S' : '', c.examEnd ? 'E' : ''].join('|'))
    .join('\n');
  // FNV-1a 32bit 두 번 (충돌 가능성을 낮춤)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 서버 설정(학교 프로필 + 시간표) 기준으로 그 채널이 틀어야 할 큐 */
export function expectedCues(school: SchoolProfile | undefined, templates: Template[], channelId: string): Cue[] {
  const ch = school?.channels?.find((c) => c.id === channelId);
  if (!ch) return [];
  return resolveCues(
    templates.find((t) => t.id === ch.templateId),
    ch,
  );
}

/** 플레이어 진행 상태 → 보고용 타임라인 */
export function toTimeline(
  plan: PlannedCue[],
  states: Record<string, CueState>,
  startedAt: Record<string, number>,
  manual: Set<string> | string[],
): TimelineEntry[] {
  const man = new Set(manual);
  return plan.map(({ cue, at }) => {
    const st = states[cue.id] ?? 'pending';
    const s: CueReport = st === 'done' ? (man.has(cue.id) ? 'manual' : 'played') : st;
    const e: TimelineEntry = { id: cue.id, time: cue.time, at, label: cue.label, period: cue.period, s };
    const t = startedAt[cue.id];
    if (t !== undefined && (s === 'played' || s === 'manual' || s === 'playing')) e.t = t;
    return e;
  });
}

export type CellKind =
  | 'idle' // 자동 방송 대기 아님 (시간표만 있음)
  | 'pending'
  | 'soon'
  | 'playing'
  | 'played'
  | 'manual'
  | 'skipped'
  | 'failed'
  | 'missing' // 시각이 지났는데 송출 보고 없음
  | 'offline'; // 연결이 끊겨 확인할 수 없는 예정 방송

export interface Cell {
  kind: CellKind;
  /** 송출 오차(ms, +는 늦음) */
  driftMs?: number;
  at?: number;
}

/**
 * 표의 칸 하나.
 * @param online 학교 PC 연결이 살아 있는가 (마지막 신호가 최근인가)
 */
export function cellState(entry: TimelineEntry | undefined, armed: boolean, online: boolean, now: number): Cell {
  if (!entry || !armed) return { kind: 'idle', at: entry?.at };
  const { s, at } = entry;
  const drift = entry.t !== undefined ? Math.round(entry.t - at) : undefined;
  switch (s) {
    case 'played':
      return { kind: 'played', driftMs: drift, at };
    case 'manual':
      return { kind: 'manual', driftMs: drift, at };
    case 'skipped':
      return { kind: 'skipped', at };
    case 'failed':
      return { kind: 'failed', at };
    case 'playing':
      return { kind: 'playing', driftMs: drift, at };
    default:
      // pending/scheduled: 아직 안 나갔다고 보고된 상태
      if (now > at + MISSING_AFTER_MS) return { kind: 'missing', at };
      if (!online) return { kind: 'offline', at };
      return { kind: at - now <= SOON_MS ? 'soon' : 'pending', at };
  }
}

/** 문제로 볼 칸 (빨강) */
export const BAD_CELLS: ReadonlySet<CellKind> = new Set(['failed', 'missing']);

/** 표의 열: 여러 학교 시간표의 방송 시각을 합친 것 (같은 시각은 한 열) */
export interface Column {
  time: string;
  /** 이 시각에 나가는 방송 이름들 (학교 유형에 따라 다를 수 있음) */
  labels: string[];
  period: string;
}

export function buildColumns(cueLists: Cue[][]): Column[] {
  const byTime = new Map<string, Column>();
  for (const list of cueLists) {
    for (const c of list) {
      const col = byTime.get(c.time) ?? { time: c.time, labels: [], period: c.period };
      if (!col.labels.includes(c.label)) col.labels.push(c.label);
      byTime.set(c.time, col);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

/** 모든 학교를 통틀어 다음 방송 시각과, 그 시각에 방송할 학교·준비 안 된 학교 수 */
export function nextAcross(
  rows: { timeline: TimelineEntry[] | null; armed: boolean; ready: boolean }[],
  now: number,
): { at: number; labels: string[]; schools: number; notReady: number } | null {
  let at = Infinity;
  for (const r of rows) {
    if (!r.armed || !r.timeline) continue;
    for (const e of r.timeline) if ((e.s === 'pending' || e.s === 'scheduled') && e.at > now && e.at < at) at = e.at;
  }
  if (at === Infinity) return null;
  const labels = new Set<string>();
  let schools = 0;
  let notReady = 0;
  for (const r of rows) {
    if (!r.armed || !r.timeline) continue;
    const hit = r.timeline.filter((e) => e.at === at && (e.s === 'pending' || e.s === 'scheduled'));
    if (!hit.length) continue;
    schools++;
    if (!r.ready) notReady++;
    hit.forEach((e) => labels.add(e.label));
  }
  return { at, labels: [...labels], schools, notReady };
}

/** RTDB presence/{학교}/{채널} — 지금 이 채널을 연 PC들 */
export interface DevicePresence {
  uid: string;
  email?: string;
  name?: string;
  since: number;
  armed?: boolean;
}

/** 같은 채널 화면을 연 PC 목록 (먼저 연 순서). 학교 담당자가 여럿이면 2대 이상도 정상이다 */
export function devicesOpen(devices: Record<string, DevicePresence> | undefined | null): DevicePresence[] {
  return Object.values(devices ?? {}).sort((a, b) => a.since - b.since);
}

/** 같은 채널을 2대 이상의 PC가 **자동 방송 중**이면 그 목록 (실제 이중 송출 위험). 화면만 열어 둔 PC는 세지 않는다 */
export function devicesConflict(devices: Record<string, DevicePresence> | undefined | null): DevicePresence[] {
  const armed = devicesOpen(devices).filter((d) => d.armed);
  return armed.length > 1 ? armed : [];
}

/** 송출 오차 표시: +0.12초 / -0.03초 */
export function formatDrift(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = ms / 1000;
  return `${s >= 0 ? '+' : ''}${Math.abs(s) < 10 ? s.toFixed(2) : s.toFixed(0)}초`;
}
