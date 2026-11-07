import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { fb } from '../../core/firebase';
import { recurring, summarize, type ServerRunReport } from '../../core/runReports';
import { kstDate, kstTime } from '../../core/scheduler';
import type { SchoolProfile } from '../../core/types';
import RunReports from '../RunReports';

/**
 * 시험장별 방송 결과 기록 (학교 PC가 올린 테스트·리허설·실전 회차).
 * 위: 학교별 요약(회차 수·최근 결과·반복 문제) → 학교를 고르면 아래에 회차별 상세.
 */
export default function RunReportsAdmin({ schools }: { schools: SchoolProfile[] }) {
  const [list, setList] = useState<ServerRunReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!fb) return;
    return onSnapshot(
      query(collection(fb.db, 'runReports'), orderBy('startedAt', 'desc'), limit(500)),
      (s) => {
        setList(s.docs.map((d) => d.data() as ServerRunReport));
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, []);

  const order = (code: string) => schools.find((s) => s.neisCode === code)?.examNo ?? 999;
  const bySchool = useMemo(() => {
    const m = new Map<string, ServerRunReport[]>();
    for (const r of list) m.set(r.school, [...(m.get(r.school) ?? []), r]);
    return [...m.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  }, [list, schools]);
  const nameOf = (code: string, fallback: string) => {
    const s = schools.find((x) => x.neisCode === code);
    return s ? `${s.examNo ? `${String(s.examNo).padStart(2, '0')}. ` : ''}${s.name}` : fallback || code;
  };
  const silent = schools.filter((s) => !bySchool.some(([code]) => code === s.neisCode));
  const picked = selected ? (bySchool.find(([code]) => code === selected)?.[1] ?? []) : [];

  return (
    <div className="admin-access">
      {error && <div className="banner bad">결과 기록을 불러오지 못했습니다: {error}</div>}
      <section className="card">
        <h2>시험장별 테스트·방송 결과</h2>
        <p className="muted small">
          학교 PC에서 테스트·리허설·실전 방송을 진행하면 회차마다 결과가 올라옵니다. 학교를 누르면 회차별 상세와 반복된 문제를 볼 수 있습니다.
        </p>
        {bySchool.length === 0 ? (
          <p className="muted">아직 올라온 기록이 없습니다.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>시험장</th>
                <th>회차</th>
                <th>최근 회차</th>
                <th>최근 결과</th>
                <th>반복 문제</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bySchool.map(([code, rs]) => {
                const last = rs[0];
                const s = summarize(last);
                const rep = recurring(rs);
                const running = last.endedAt === null;
                return (
                  <tr key={code} className={selected === code ? 'is-selected' : ''}>
                    <td>
                      <strong>{nameOf(code, last.schoolName)}</strong>
                    </td>
                    <td className="mono">
                      {rs.length}
                      <span className="muted small"> (실전 {rs.filter((r) => r.mode === 'live').length})</span>
                    </td>
                    <td className="mono small">
                      {kstDate(last.startedAt).slice(5)} {kstTime(last.startedAt).slice(0, 5)} · {last.label}
                    </td>
                    <td className={running ? '' : s.ok ? 'ok-text' : 'error'}>
                      {running ? '진행 중' : s.ok ? '✓ 모두 정상' : `문제 ${s.problems}건`}
                    </td>
                    <td className={rep.length ? 'error' : 'muted'}>{rep.length ? `${rep.length}건` : '없음'}</td>
                    <td>
                      <button className="small" onClick={() => setSelected(selected === code ? null : code)}>
                        {selected === code ? '닫기' : '자세히'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {silent.length > 0 && bySchool.length > 0 && (
          <p className="muted small">기록이 없는 시험장 {silent.length}곳: {silent.map((s) => s.name.replace(/고등학교$/, '고')).join(', ')}</p>
        )}
      </section>

      {selected && (
        <RunReports
          key={selected}
          reports={picked}
          title={nameOf(selected, picked[0]?.schoolName ?? '')}
          subtitle="이 시험장 PC들이 올린 회차 (최근 것부터)"
          prefix={(r) => {
            const x = r as ServerRunReport;
            return `${x.channel !== 'main' ? `[${x.channelLabel}] ` : ''}${x.operator ? `${x.operator} · ` : ''}`;
          }}
        />
      )}
    </div>
  );
}
