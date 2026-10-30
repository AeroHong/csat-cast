import { useState } from 'react';
import { describeRehearsal, validateRehearsal, type ScheduledRehearsal } from '../core/rehearsals';
import { kstDate } from '../core/scheduler';
import type { ArmedDate } from '../core/types';

const WEEKDAY = '일월화수목금토';
/** "2026-11-10" → "11/10(화)" */
export function shortDate(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${WEEKDAY[weekday]})`;
}

function dday(from: string, to: string) {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  return n === 0 ? '오늘' : `D-${n}`;
}

/**
 * 리허설 예약: 날짜·방식을 정해 두면 그날 이 화면을 열어 두기만 해도 자동으로 리허설을 진행한다.
 */
export default function RehearsalScheduler({
  list,
  onChange,
  now,
  official,
  runningDate,
}: {
  list: ScheduledRehearsal[];
  onChange: (list: ScheduledRehearsal[]) => void;
  now: number;
  official: ArmedDate[];
  /** 지금 자동 진행 중인 리허설 날짜 (그 예약은 지우기 전에 먼저 중지해야 함) */
  runningDate: string | null;
}) {
  const today = kstDate(now);
  const [date, setDate] = useState(kstDate(now + 86_400_000));
  const [kind, setKind] = useState<ScheduledRehearsal['kind']>('actual');
  const [startTime, setStartTime] = useState('14:00');
  const [speed, setSpeed] = useState(10);
  const [errors, setErrors] = useState<string[]>([]);

  function add() {
    const r: ScheduledRehearsal = {
      id: `${date}-${Date.now()}`,
      date,
      kind,
      ...(kind === 'custom' ? { startTime, speed } : {}),
    };
    const errs = validateRehearsal(r, { now, today, official, existing: list });
    setErrors(errs);
    if (errs.length === 0) onChange([...list, r].sort((a, b) => a.date.localeCompare(b.date)));
  }

  const upcoming = list.filter((r) => r.date >= today);
  const officialUpcoming = official.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <section className="card">
      <h2>리허설 예약</h2>
      <p className="muted small">예약한 날 이 화면을 열어 두면 실전과 똑같이 자동으로 진행합니다. 예약은 이 PC에 저장됩니다.</p>

      {upcoming.length === 0 ? (
        <p className="muted">예약된 리허설이 없습니다.</p>
      ) : (
        <ul className="sched-list">
          {upcoming.map((r) => (
            <li key={r.id} className={r.date === today ? 'is-today' : ''}>
              <span className="mono">{shortDate(r.date)}</span>
              <span className="tag">{dday(today, r.date)}</span>
              <span>{describeRehearsal(r)}</span>
              <button
                className="small"
                disabled={r.date === runningDate}
                title={r.date === runningDate ? '진행 중인 리허설은 [자동 방송 중지] 후 지울 수 있습니다' : '예약 취소'}
                onClick={() => onChange(list.filter((x) => x.id !== r.id))}
              >
                취소
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="sched-form">
        <label>
          날짜
          <input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <fieldset>
          <legend>진행 방식</legend>
          <label className="radio">
            <input type="radio" name="rkind" checked={kind === 'actual'} onChange={() => setKind('actual')} />
            실제 시간표 그대로 (08:05부터 실전과 같은 시각)
          </label>
          <label className="radio">
            <input type="radio" name="rkind" checked={kind === 'custom'} onChange={() => setKind('custom')} />
            시작 시각 지정
          </label>
          {kind === 'custom' && (
            <div className="row">
              <label>
                시작 시각
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </label>
              <label>
                배속
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  <option value={1}>1배 (실제 간격)</option>
                  <option value={10}>10배</option>
                  <option value={60}>60배</option>
                </select>
              </label>
            </div>
          )}
        </fieldset>
        <button className="primary" onClick={add}>
          + 예약 추가
        </button>
        {errors.length > 0 && (
          <ul className="error small">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      {officialUpcoming.length > 0 && (
        <div className="official-dates">
          <div className="muted small">교육지원청 지정 방송일 (자동 진행, 변경 불가)</div>
          <ul className="sched-list">
            {officialUpcoming.map((d) => (
              <li key={d.date}>
                <span className="mono">{shortDate(d.date)}</span>
                <span className={`tag ${d.mode}`}>{d.mode === 'live' ? '실전' : '리허설'}</span>
                <span>{d.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
