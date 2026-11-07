/**
 * 학교 시간표 일괄 가져오기 (엑셀) + 음원 파일 이름으로 시간표에 자동 연결.
 *
 * 엑셀 형식: 첫 줄(또는 위쪽 어딘가)에 머리글 — 교시 · 구분 · 타종시간 [· 비고 / 방송 내용]
 *   - 교시 칸이 비어 있으면 위 칸의 교시를 이어 쓴다 (엑셀에서 병합·생략한 경우)
 *   - 타종시간이 없는 줄(점심시간 등)은 건너뛴다
 *   - 비고·방송 내용에 "포함" 또는 "타종 없이"가 있으면 그 줄은 따로 송출하지 않고 앞 방송에 이어진 것으로 본다
 *     (예: 18:15 종료령 파일에 18:17 두 번째 본령이 들어 있음 / 영어는 준비령 뒤 듣기평가 방송으로 시작)
 *     "(멜로디 및 타종 없음)"은 멘트만 나간다는 뜻이므로 해당하지 않는다.
 *   - 종료령 직후 3분 안의 본령도 같은 방식(합본 파일)으로 본다 — 평가원 시간표의 16:05 종료령·16:07 본령과 같다
 *
 * 음원 파일 이름: 앞에 시각을 붙인다 — 1710_한국사종료5분전.mp3, 0805.mp3, 17-10 ….mp3, 171000.mp3
 */
import type { Cue } from './types';

/** 평가원 시간표와 같은 교시 이름 (학교 시간표와 현황판에서 같은 열로 묶이게) */
const PERIOD_NAMES: Record<string, string> = {
  '1': '1교시 국어',
  '2': '2교시 수학',
  '3': '3교시 영어',
  '4': '4교시 한국사·탐구',
  '5': '5교시 제2외국어/한문',
};

const pad = (n: number) => String(n).padStart(2, '0');
const toSec = (t: string) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

/** 엑셀 시각 칸 → "HH:MM:SS". 날짜(1899-12-30 08:05), 하루 비율 숫자(0.336…), 글자("8:05") 모두 받는다 */
export function parseTimeCell(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // 엑셀 시각은 UTC 기준 날짜로 읽힌다 (1899-12-30T08:05:00Z)
    return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const frac = v - Math.floor(v);
    const total = Math.round(frac * 86400);
    if (total <= 0 || total >= 86400) return null;
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }
  if (typeof v === 'string') {
    const m = /^\s*(\d{1,2})\s*[:시]\s*(\d{2})\s*(?:분)?\s*(?:[:]\s*(\d{2}))?\s*$/.exec(v);
    if (!m) return null;
    const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    if (h > 23 || mi > 59 || s > 59) return null;
    return `${pad(h)}:${pad(mi)}:${pad(s)}`;
  }
  return null;
}

/** 음원 파일 이름 앞의 시각 → "HH:MM:SS" (없으면 null) */
export function timeFromFileName(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, '');
  const m = /^(\d{1,2})[-_.: 시]?(\d{2})(?:[-_.: 분]?(\d{2})(?!\d))?(?!\d)/.exec(base);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${pad(h)}:${pad(mi)}:${pad(s)}`;
}

const text = (v: unknown) => (v == null ? '' : String(v).trim());

interface Header {
  row: number;
  period: number;
  label: number;
  time: number;
  note: number[];
}

function findHeader(rows: unknown[][]): Header | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r].map(text);
    const time = cells.findIndex((c) => /타종\s*시간|^시각$|^시간$/.test(c));
    const label = cells.findIndex((c) => /^구분$|^내용$|방송\s*구분/.test(c));
    if (time < 0 || label < 0) continue;
    const period = cells.findIndex((c) => /교시/.test(c));
    const note = cells.map((c, i) => (/비고|방송\s*내용|대본|시나리오/.test(c) ? i : -1)).filter((i) => i >= 0);
    return { row: r, period, label, time, note };
  }
  return null;
}

/** 이 시트가 시간표 형식(머리글: 구분·타종시간)인지 */
export function looksLikeSchedule(rows: unknown[][]) {
  return findHeader(rows) !== null;
}

export interface ImportResult {
  cues: Cue[];
  /** 앞 방송에 합친 줄 등, 담당자가 확인할 내용 */
  notes: string[];
}

const isStart = (label: string) => /본령|시작/.test(label);
const isEnd = (label: string) => /종료령/.test(label);
/**
 * 이 줄은 따로 송출하지 않음: "…파일에 포함", "타종 없이 … 듣기평가" (단, "타종 없음"은 멘트만 나간다는 뜻).
 * 대본 본문(수백 자) 안의 "포함"·"타종 없이"에 걸리지 않도록 짧은 메모 칸만 본다.
 */
const NOTE_MAX = 80;
const noOwnBroadcast = (notes: string[]) => notes.some((n) => n.length <= NOTE_MAX && (/포함/.test(n) || /타종\s*없이/.test(n)));

function periodName(raw: string) {
  const m = /^\s*(\d)\s*교시/.exec(raw);
  return m ? (PERIOD_NAMES[m[1]] ?? raw) : raw;
}

/** 엑셀 표(행 배열) → 학교 시간표 */
export function parseScheduleRows(rows: unknown[][], newId: (time: string, i: number) => string): ImportResult {
  const h = findHeader(rows);
  if (!h) throw new Error('머리글(구분·타종시간)을 찾지 못했습니다. 첫 줄에 "교시 · 구분 · 타종시간" 머리글이 있는지 확인하세요.');
  const cues: Cue[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let period = '';
  rows.slice(h.row + 1).forEach((row, i) => {
    if (h.period >= 0 && text(row[h.period])) period = text(row[h.period]);
    const label = text(row[h.label]);
    const time = parseTimeCell(row[h.time]);
    if (!time) {
      if (label && text(row[h.time])) notes.push(`${label}: 타종시간 "${text(row[h.time])}"을(를) 읽지 못해 건너뜀`);
      return;
    }
    if (!label) return;
    const hhmm = time.slice(0, 5);
    const key = `${time}|${label}`;
    if (seen.has(key)) {
      notes.push(`${hhmm} ${label}: 같은 줄이 두 번 있어 하나만 넣음`);
      return;
    }
    seen.add(key);
    const notesInRow = h.note.map((c) => text(row[c])).filter(Boolean);
    const prev = cues.at(-1);
    const chained = prev && isStart(label) && prev.examEnd && toSec(time) - toSec(prev.time) <= 180;
    if (prev && (noOwnBroadcast(notesInRow) || chained)) {
      // 앞 방송 파일에 들어 있음 → 따로 내지 않는다
      prev.label = `${prev.label} · ${hhmm} ${label}`;
      if (isStart(label) && prev.examEnd) {
        // 종료령 + 다음 본령 합본: 끊기면 처음부터 다시, 늦어도 10분까지는 튼다 (평가원 16:05 합본과 같은 방식)
        prev.examStart = true;
        prev.restartIfInterrupted = true;
        prev.lateToleranceSec = 600;
      }
      notes.push(`${hhmm} ${label}: 따로 송출하지 않고 ${prev.time.slice(0, 5)} 방송에 이어지는 것으로 넣음`);
      return;
    }
    const bell = isStart(label) || isEnd(label);
    cues.push({
      id: newId(time, i),
      time,
      period: periodName(period),
      label,
      kind: bell ? 'bell' : 'ment',
      assetId: '',
      ...(isStart(label) ? { examStart: true } : {}),
      ...(isEnd(label) ? { examEnd: true } : {}),
      official: false,
    });
  });
  if (!cues.length) throw new Error('가져올 방송이 없습니다 (타종시간이 있는 줄이 없음).');
  cues.sort((a, b) => a.time.localeCompare(b.time));
  return { cues, notes };
}

export interface NamedAsset {
  id: string;
  fileName: string;
  uploadedAt: number;
}

/**
 * 음원이 비어 있는 줄에 파일 이름의 시각이 같은 학교 음원을 넣는다 (같은 시각 파일이 여럿이면 가장 최근 것).
 * 이미 음원을 고른 줄은 그대로 둔다.
 */
export function assignByFileName(cues: Cue[], assets: NamedAsset[]): { cues: Cue[]; assigned: number } {
  const byTime = new Map<string, NamedAsset>();
  for (const a of assets) {
    const t = timeFromFileName(a.fileName);
    if (!t) continue;
    const cur = byTime.get(t);
    if (!cur || a.uploadedAt > cur.uploadedAt) byTime.set(t, a);
  }
  let assigned = 0;
  const next = cues.map((c) => {
    if (c.assetId) return c;
    const a = byTime.get(c.time);
    if (!a) return c;
    assigned++;
    return { ...c, assetId: a.id };
  });
  return { cues: next, assigned };
}
