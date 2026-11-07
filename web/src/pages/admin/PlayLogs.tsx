import { collection, getDocs, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { formatDrift } from '../../core/board';
import { fb } from '../../core/firebase';
import type { PlayLog } from '../../core/reporter';
import { kstDate, kstEpoch, kstTime } from '../../core/scheduler';
import type { SchoolProfile } from '../../core/types';

const RESULT: Record<PlayLog['result'], string> = { played: '송출', skipped: '건너뜀', failed: '실패', manual: '수동' };
const ORDER: Record<PlayLog['result'], number> = { failed: 0, skipped: 1, manual: 2, played: 3 };

/** 송출 기록 (playLogs — 학교 PC가 남기며 수정·삭제 불가). 사후 증빙용 CSV 내려받기 */
export default function PlayLogs({ schools, now }: { schools: SchoolProfile[]; now: number }) {
  const [date, setDate] = useState(kstDate(now));
  const [mode, setMode] = useState<'all' | 'live' | 'test'>('all');
  const [problemsFirst, setProblemsFirst] = useState(true);
  const [logs, setLogs] = useState<(PlayLog & { id: string })[] | null>(null);
  const [err, setErr] = useState('');

  async function load() {
    if (!fb) return;
    setErr('');
    setLogs(null);
    try {
      const start = kstEpoch(date, '00:00:00');
      const snap = await getDocs(
        query(collection(fb.db, 'playLogs'), where('scheduledAt', '>=', start), where('scheduledAt', '<', start + 86_400_000)),
      );
      setLogs(snap.docs.map((d) => ({ ...(d.data() as PlayLog), id: d.id })));
    } catch (e) {
      setErr(`불러오지 못했습니다: ${(e as Error).message}`);
      setLogs([]);
    }
  }
  useEffect(() => {
    void load();
  }, [date]);

  const nameOf = (code: string) => schools.find((s) => s.neisCode === code)?.name ?? code;
  const shown = (logs ?? [])
    .filter((l) => mode === 'all' || l.mode === mode)
    .sort(
      (a, b) =>
        (problemsFirst ? ORDER[a.result] - ORDER[b.result] : 0) ||
        nameOf(a.school).localeCompare(nameOf(b.school), 'ko') ||
        a.scheduledAt - b.scheduledAt,
    );
  const count = (r: PlayLog['result']) => shown.filter((l) => l.result === r).length;

  function downloadCsv() {
    const head = ['학교', '학교 id', '채널', '모드', '방송', '예정 시각', '실제 시작', '오차(ms)', '결과', '비고'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map((l) =>
      [
        nameOf(l.school),
        l.school,
        l.channel,
        l.mode === 'live' ? '실전' : '테스트',
        l.label,
        kstTime(l.scheduledAt),
        l.startedAt ? kstTime(l.startedAt) : '',
        l.driftMs ?? '',
        RESULT[l.result],
        l.detail ?? '',
      ]
        .map(esc)
        .join(','),
    );
    const blob = new Blob(['﻿' + [head.map(esc).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `송출기록_${date}${mode === 'all' ? '' : mode === 'live' ? '_실전' : '_테스트'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>송출 기록</h2>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="all">실전·테스트 모두</option>
          <option value="live">실전만</option>
          <option value="test">테스트만</option>
        </select>
        <label className="row">
          <input type="checkbox" checked={problemsFirst} onChange={(e) => setProblemsFirst(e.target.checked)} />
          실패·건너뜀 먼저
        </label>
        <button className="small" onClick={() => void load()}>
          새로 고침
        </button>
        <button className="small primary" onClick={downloadCsv} disabled={!shown.length}>
          CSV 내려받기
        </button>
      </div>
      <p className="muted small">
        학교 PC가 송출할 때마다 서버에 남기는 기록이며 누구도 고치거나 지울 수 없습니다. 인터넷이 끊겼던 PC는 다시 연결될 때 올라옵니다.
      </p>
      {err && <p className="error">{err}</p>}
      {logs === null ? (
        <p className="muted">불러오는 중…</p>
      ) : (
        <>
          <div className="summary">
            <div className="sum ok">송출 {count('played')}</div>
            <div className="sum ok">수동 {count('manual')}</div>
            <div className="sum warn">건너뜀 {count('skipped')}</div>
            <div className="sum bad">실패 {count('failed')}</div>
          </div>
          <table className="list">
            <thead>
              <tr>
                <th>학교</th>
                <th>모드</th>
                <th>예정</th>
                <th>방송</th>
                <th>실제 시작</th>
                <th>결과</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} className={`r-${l.result}`}>
                  <td>
                    {nameOf(l.school)}
                    {l.channel !== 'main' && <span className="muted"> · {l.channel}</span>}
                  </td>
                  <td>{l.mode === 'live' ? '실전' : '테스트'}</td>
                  <td className="mono">{kstTime(l.scheduledAt)}</td>
                  <td>{l.label}</td>
                  <td className="mono">
                    {l.startedAt ? `${kstTime(l.startedAt)} (${formatDrift(l.driftMs ?? undefined)})` : '—'}
                  </td>
                  <td>{RESULT[l.result]}</td>
                  <td className="muted small">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="muted">이 날짜의 기록이 없습니다.</p>}
        </>
      )}
    </section>
  );
}
