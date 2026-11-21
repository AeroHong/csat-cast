/**
 * 시각 입력(24시간제) 해석. 브라우저 기본 시간 칸은 한국어 설정에서 오전/오후 12시간제로 나와
 * "오전 11시" 칸에 12를 넣으면 오전 12시(=00시)가 되는 등 헷갈리므로 글자로 직접 받는다.
 *
 * 받는 형식: 13:05, 13:05:30, 1305, 130530, 13시 5분, 13시 5분 30초, 9:5(→09:05), 오후 1:05(→13:05), 오전 12:10(→00:10)
 * @returns "HH:MM:SS" 또는 읽을 수 없으면 null
 */
export function parseTime24(input: string): string | null {
  let t = input.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  let ampm: 'am' | 'pm' | null = null;
  const m0 = /^(오전|오후|am|pm)\s*/i.exec(t);
  if (m0) {
    ampm = /오후|pm/i.test(m0[1]) ? 'pm' : 'am';
    t = t.slice(m0[0].length);
  }
  let h: number, mi: number, s: number;
  let m = /^(\d{1,2})\s*(?:시|:)\s*(\d{1,2})?\s*(?:분|:)?\s*(\d{1,2})?\s*(?:초)?$/.exec(t);
  if (m) {
    [h, mi, s] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  } else if ((m = /^(\d{3,6})$/.exec(t))) {
    // 숫자만: 905 → 09:05, 1305 → 13:05, 130530 → 13:05:30
    const d = m[1].length % 2 ? `0${m[1]}` : m[1];
    [h, mi, s] = [Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4, 6) || 0)];
  } else if ((m = /^(\d{1,2})$/.exec(t))) {
    [h, mi, s] = [Number(m[1]), 0, 0];
  } else return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = ampm === 'pm' ? (h % 12) + 12 : h % 12;
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(mi)}:${pad(s)}`;
}

/** "13:05:00" → "오후 1:05" (헷갈리지 않게 옆에 함께 보여 줌) */
export function describeTime(hms: string): string {
  const [h, m, s] = hms.split(':').map(Number);
  if ([h, m].some((n) => Number.isNaN(n))) return '';
  const label = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${label} ${h12}:${String(m).padStart(2, '0')}${s ? `:${String(s).padStart(2, '0')}` : ''}`;
}
