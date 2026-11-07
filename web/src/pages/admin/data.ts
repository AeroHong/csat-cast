import { collection, onSnapshot } from 'firebase/firestore';
import { onValue, ref } from 'firebase/database';
import { useEffect, useState } from 'react';
import {
  BAD_CELLS,
  cellState,
  cuesHash,
  devicesConflict,
  expectedCues,
  type Cell,
  type DevicePresence,
  type TimelineEntry,
} from '../../core/board';
import { loadTemplates } from '../../core/catalog';
import { serverClock } from '../../core/clock';
import { fb } from '../../core/firebase';
import type { ChannelStatus } from '../../core/reporter';
import type { Cue, SchoolProfile, Template } from '../../core/types';
import { csatSituation } from '../../data/templates';

export type Health = 'ok' | 'warn' | 'bad' | 'none';

/** 마지막 신호가 이보다 오래됐으면 연결 끊김 (학교 PC는 30초마다 보고) */
export const STALE_MS = 90_000;

export type StatusTree = Record<string, Record<string, ChannelStatus>>;
export type PresenceTree = Record<string, Record<string, Record<string, DevicePresence>>>;

export interface ChannelRow {
  code: string;
  ch: string;
  name: string;
  label: string;
  examNo: number | null;
  special: boolean;
  school?: SchoolProfile;
  s?: ChannelStatus;
  /** 서버 설정 기준 시간표 */
  expected: Cue[];
  /** 학교 PC가 보고한 실제 시간표·결과 (자동 방송 중일 때) */
  timeline: TimelineEntry[] | null;
  online: boolean;
  armed: boolean;
  devices: DevicePresence[];
  hashMismatch: boolean;
  /** 평가원 유형 번호 (1~6) — 학교 자체 시간표면 null */
  typeNo: number | null;
  customSchedule: boolean;
  health: Health;
  reasons: string[];
}

/** 관리자 화면에 필요한 실시간 데이터 (RTDB 상태·접속 PC, Firestore 학교 설정, 시간표) */
export function useAdminData() {
  const [status, setStatus] = useState<StatusTree>({});
  const [presence, setPresence] = useState<PresenceTree>({});
  const [schools, setSchools] = useState<SchoolProfile[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(serverClock.now());

  useEffect(() => {
    if (!fb) return;
    void serverClock.sync();
    const resync = setInterval(() => void serverClock.sync(), 10 * 60_000);
    const u1 = onValue(ref(fb.rtdb, 'status'), (snap) => setStatus(snap.val() ?? {}));
    const u2 = onValue(ref(fb.rtdb, 'presence'), (snap) => setPresence(snap.val() ?? {}));
    const u3 = onValue(ref(fb.rtdb, '.info/connected'), (snap) => setConnected(snap.val() === true));
    // 학교 설정은 실시간 구독 (유형 변경·자체 시간표 저장이 바로 반영되게)
    const u4 = onSnapshot(collection(fb.db, 'schools'), (s) =>
      setSchools(s.docs.map((d) => ({ ...(d.data() as SchoolProfile), neisCode: d.id }))),
    );
    void loadTemplates().then(setTemplates);
    const id = setInterval(() => setNow(serverClock.now()), 1000);
    return () => {
      u1();
      u2();
      u3();
      u4();
      clearInterval(id);
      clearInterval(resync);
    };
  }, []);

  return { status, presence, schools, templates, connected, now };
}

export type ModeFilter = 'all' | 'live' | 'test';

/** 학교·채널별 행을 만들고 상태를 판정한다 */
export function buildRows(
  d: { status: StatusTree; presence: PresenceTree; schools: SchoolProfile[]; templates: Template[]; now: number },
  mode: ModeFilter = 'all',
): ChannelRow[] {
  const { status, presence, schools, templates, now } = d;
  // 등록된 학교 + 등록은 안 됐지만 접속한 학교 모두 표시
  const codes = new Set([...schools.map((s) => s.neisCode), ...Object.keys(status)]);
  const rows: ChannelRow[] = [];
  for (const code of codes) {
    const school = schools.find((s) => s.neisCode === code);
    const chans = school?.channels?.map((c) => c.id) ?? [];
    const ids = new Set([...chans, ...Object.keys(status[code] ?? {})]);
    if (ids.size === 0) ids.add('main');
    for (const ch of ids) {
      const s = status[code]?.[ch];
      const chCfg = school?.channels?.find((c) => c.id === ch);
      const expected = expectedCues(school, templates, ch);
      const online = !!s && s.online && now - s.lastSeen <= STALE_MS;
      const modeOk = mode === 'all' || s?.mode === mode;
      const armed = !!s?.armed && modeOk;
      const timeline = armed && Array.isArray(s?.timeline) ? s!.timeline! : null;
      const devices = devicesConflict(presence[code]?.[ch]);
      const hashMismatch = !!s?.planHash && expected.length > 0 && s.planHash !== cuesHash(expected);
      const sit = chCfg && !chCfg.customCues ? csatSituation(chCfg.templateId) : undefined;
      const row: ChannelRow = {
        code,
        ch,
        name: school?.name ?? s?.schoolName ?? code,
        label: chCfg?.label ?? s?.channelLabel ?? ch,
        examNo: school?.examNo ?? null,
        special: !!school?.special,
        school,
        s,
        expected,
        timeline,
        online,
        armed,
        devices,
        hashMismatch,
        typeNo: sit && chCfg ? Number(chCfg.templateId.replace('csat-', '')) : null,
        customSchedule: !!chCfg?.customCues,
        health: 'none',
        reasons: [],
      };
      Object.assign(row, judge(row, now));
      rows.push(row);
    }
  }
  return rows;
}

/** 채널 상태를 초록/노랑/빨강으로 판정하고 사유를 붙인다 (빨강 사유가 먼저) */
export function judge(r: Omit<ChannelRow, 'health' | 'reasons'>, now: number): { health: Health; reasons: string[] } {
  const bad: string[] = [];
  const warn: string[] = [];
  if (r.special && !r.customSchedule) bad.push('1.5배 시간표 미등록 (학교 [시간표 편집]에서 만들어야 함)');
  if (r.devices.length > 1) bad.push(`같은 채널을 PC ${r.devices.length}대가 열어 둠 (이중 송출 위험)`);
  const s = r.s;
  if (!s) return bad.length ? { health: 'bad', reasons: [...bad, '접속 기록 없음'] } : { health: 'none', reasons: ['접속 기록 없음'] };
  if (!r.online) bad.push(s.armed ? '연결 끊김 (PC에서 재생은 계속될 수 있음)' : '연결 끊김');
  for (const a of s.alarms ?? []) bad.push(a);
  if (s.armed && !s.audioUnlocked && !(s.alarms ?? []).length) bad.push('소리 출력 꺼짐');
  if (r.hashMismatch) bad.push('PC 시간표가 서버 설정과 다름 (학교 PC 새로고침 필요)');
  if (r.timeline) {
    const cells = r.timeline.map((e) => [e, cellState(e, true, r.online, now)] as const);
    const missing = cells.filter(([, c]) => c.kind === 'missing');
    if (missing.length) bad.push(`송출 보고 없음: ${missing.map(([e]) => `${e.time.slice(0, 5)} ${e.label}`).join(', ')}`);
    const failed = cells.filter(([, c]) => c.kind === 'failed');
    if (failed.length) bad.push(`재생 실패: ${failed.map(([e]) => `${e.time.slice(0, 5)} ${e.label}`).join(', ')}`);
    const skipped = cells.filter(([, c]) => c.kind === 'skipped');
    if (skipped.length) warn.push(`건너뜀: ${skipped.map(([e]) => `${e.time.slice(0, 5)} ${e.label}`).join(', ')}`);
  } else {
    if (s.failedCount > 0) bad.push(`재생 실패 ${s.failedCount}건`);
    if (s.skippedCount > 0) warn.push(`건너뜀 ${s.skippedCount}건`);
  }
  if (!s.cacheReady) warn.push(s.missingAssets ? `음원 ${s.missingAssets}개 누락` : '음원 준비 중');
  if (!s.clockSynced) warn.push('시각 미동기화');
  if (!s.armed && !s.audioUnlocked) warn.push('소리 출력 꺼짐');
  if (!s.soundConfirmed) warn.push('스피커 확인 안 함');
  if (!s.autoplayAllowed) warn.push('전용 실행 아이콘 미사용 (새로고침 시 클릭 필요)');
  if (!s.armed) warn.push('자동 방송 대기 아님');
  if (bad.length) return { health: 'bad', reasons: [...bad, ...warn] };
  if (warn.length) return { health: 'warn', reasons: warn };
  return { health: 'ok', reasons: ['정상'] };
}

/** 행의 칸: 시간표상 시각 → 칸 상태. 그 학교 시간표에 없는 시각은 없음 */
export function rowCells(r: ChannelRow, now: number): Map<string, { cell: Cell; entry?: TimelineEntry; cue?: Cue }> {
  const m = new Map<string, { cell: Cell; entry?: TimelineEntry; cue?: Cue }>();
  if (r.timeline) {
    for (const e of r.timeline) m.set(e.time, { cell: cellState(e, true, r.online, now), entry: e });
  } else {
    for (const c of r.expected) m.set(c.time, { cell: { kind: 'idle' }, cue: c });
  }
  return m;
}

export const isBadCell = (c: Cell) => BAD_CELLS.has(c.kind);

/** 이 행의 다음 방송 */
export function rowNext(r: ChannelRow, now: number): { time: string; label: string; at?: number } | null {
  if (r.timeline) {
    const e = r.timeline.find((x) => (x.s === 'pending' || x.s === 'scheduled') && x.at + 15_000 >= now);
    return e ? { time: e.time, label: e.label, at: e.at } : null;
  }
  return null;
}
