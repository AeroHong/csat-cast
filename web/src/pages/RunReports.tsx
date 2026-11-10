import { useState } from 'react';
import { OUTCOME_LABEL, recurring, summarize, type Outcome, type RunReport } from '../core/runReports';
import { kstDate, kstTime } from '../core/scheduler';

const PROBLEM: Outcome[] = ['late', 'manual', 'cut', 'gap', 'skipped', 'failed', 'missed'];

const drift = (ms: number | null) => (ms === null ? '' : `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(ms < 10_000 && ms > -10_000 ? 2 : 0)}초`);

/** 방송 회차별 결과 (테스트·리허설·실전) + 여러 번 반복된 문제 */
export default function RunReports({
  reports,
  onClear,
  title = '방송 결과 기록',
  subtitle = '이 PC에서 진행한 테스트·리허설·실전 방송 (최근 30회)',
  prefix,
}: {
  reports: RunReport[];
  /** 없으면 지우기 버튼을 숨긴다 (관리자 화면) */
  onClear?: () => void;
  title?: string;
  subtitle?: string;
  /** 회차 이름 앞에 붙일 말 (관리자 화면: 채널 이름·운영자) */
  prefix?: (r: RunReport) => string;
}) {
  const [open, setOpen] = useState<string | null>(reports[0]?.id ?? null);
  const repeated = recurring(reports);

  return (
    <section className="card run-reports">
      <div className="timetable-head">
        <h2>{title}</h2>
        <span className="muted small">{subtitle}</span>
      </div>
      {reports.length === 0 ? (
        <p className="muted">아직 기록이 없습니다. 리허설을 한 번 진행하면 여기에 결과가 남습니다.</p>
      ) : (
        <>
          {repeated.length > 0 && (
            <div className="banner warn">
              <strong>여러 번 반복된 문제</strong>
              <ul>
                {repeated.map((r) => (
                  <li key={r.label}>
                    {r.label} <span className="muted">({r.of}회 중 {r.times}회)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="run-list">
            {reports.map((r) => {
              const s = summarize(r);
              const expanded = open === r.id;
              const running = r.endedAt === null;
              return (
                <li key={r.id} className={running ? 'running' : s.ok ? 'ok' : 'bad'}>
                  <button className="run-head" onClick={() => setOpen(expanded ? null : r.id)} aria-expanded={expanded}>
                    <span className="mono">
                      {kstDate(r.startedAt).slice(5)} {kstTime(r.startedAt).slice(0, 5)}
                    </span>
                    <span className={`tag ${r.mode}`}>{r.mode === 'live' ? '실전' : '테스트'}</span>
                    <span className="run-label">
                      {prefix?.(r)}
                      {r.label}
                    </span>
                    <span className="run-result">
                      {running
                        ? '진행 중'
                        : s.ok
                          ? `✓ ${s.total - s.counts.stopped}개 모두 정상`
                          : `문제 ${s.problems}건 · ` +
                            PROBLEM.filter((k) => s.counts[k])
                              .map((k) => `${OUTCOME_LABEL[k]} ${s.counts[k]}`)
                              .concat(r.incidents.length ? [`사고 ${r.incidents.length}`] : [])
                              .join(' · ')}
                      {!running && s.counts.stopped > 0 && <span className="muted"> (중지해서 {s.counts.stopped}개 남김)</span>}
                    </span>
                    <span className="muted small">{s.maxDriftMs !== null ? `최대 오차 ${drift(s.maxDriftMs)}` : ''}</span>
                  </button>
                  {expanded && (
                    <div className="run-detail">
                      {r.battery?.unplugged && (
                        <p className="error small">
                          배터리로 동작한 적이 있음{r.battery.min !== null ? ` (최저 ${Math.round(r.battery.min * 100)}%)` : ''}
                        </p>
                      )}
                      {r.incidents.length > 0 && (
                        <>
                          <h3>사고 기록</h3>
                          <ul className="events">
                            {r.incidents.map((i, k) => (
                              <li key={k} className={i.level}>
                                <span className="mono">{kstTime(i.at)}</span> {i.message}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <h3>방송별 결과</h3>
                      <table className="timeline compact">
                        <tbody>
                          {r.cues.map((c) => (
                            <tr key={c.id} className={PROBLEM.includes(c.outcome) ? 'st-failed' : c.outcome === 'pending' ? '' : 'st-done'}>
                              <td className="mono">{c.time.slice(0, 5)}</td>
                              <td>{c.label}</td>
                              <td>
                                {OUTCOME_LABEL[c.outcome]}
                                {c.detail && <div className="muted small">{c.detail}</div>}
                              </td>
                              <td className="mono">{drift(c.driftMs)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {onClear && (
          <div className="row">
            <span className="spacer" />
            <button
              className="link"
              onClick={() => {
                if (window.confirm('이 PC의 방송 결과 기록을 모두 지울까요? (관리자 화면에 올라간 기록은 남습니다)')) onClear();
              }}
            >
              기록 지우기
            </button>
          </div>
          )}
        </>
      )}
    </section>
  );
}
