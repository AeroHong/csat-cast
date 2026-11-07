import { useEffect, useRef } from 'react';
import { cellState, formatDrift } from '../../core/board';
import { kstTime } from '../../core/scheduler';
import { CELL_LABEL, CellBox, cellTitle } from './LiveBoard';
import { rowNext, type ChannelRow } from './data';

/** 별도 운영 시험장 (경증 시각장애 1.5배 등): 시간표가 평가원 열과 달라 세로 타임라인으로 따로 보여 준다 */
export default function SpecialVenue({ row: r, now }: { row: ChannelRow; now: number }) {
  const list = r.timeline
    ? r.timeline.map((e) => ({ key: e.id, time: e.time, period: e.period, label: e.label, cell: cellState(e, true, r.online, now), entry: e }))
    : r.expected.map((c) => ({ key: c.id, time: c.time, period: c.period, label: c.label, cell: { kind: 'idle' as const }, entry: undefined }));
  const playing = list.find((x) => x.cell.kind === 'playing');
  const next = rowNext(r, now);
  const venue = r.school?.venueType || '별도 운영 시험장';

  // 송출 중이거나 다음에 나갈 방송이 목록 위쪽에 보이도록 세로 스크롤
  const focusKey = (playing ?? list.find((x) => x.cell.kind === 'soon' || x.cell.kind === 'pending'))?.key;
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = listRef.current;
    const li = focusKey ? box?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(focusKey)}"]`) : null;
    if (box && li) box.scrollTo({ top: Math.max(0, li.offsetTop - 2 * li.offsetHeight), behavior: 'smooth' });
  }, [focusKey]);

  return (
    <section className={`special card h-${r.health}`}>
      <header className="special-head">
        <div>
          <div className="special-kicker">별도 운영 시험장 · {venue}</div>
          <h2>
            {r.examNo ? `${String(r.examNo).padStart(2, '0')}. ` : ''}
            {r.name}
            {r.s?.mode && r.s.mode !== 'idle' && <span className={`tag ${r.s.mode}`}>{r.s.mode === 'live' ? '실전' : '테스트'}</span>}
          </h2>
          <div className="muted small">
            {r.customSchedule ? `학교 자체 시간표 ${r.expected.length}개 방송` : '자체 시간표 없음'}
            {r.s?.operator && ` · 운영: ${r.s.operator}`}
            {r.s && ` · 마지막 신호 ${Math.max(0, Math.round((now - r.s.lastSeen) / 1000))}초 전`}
          </div>
        </div>
        <div className="special-now">
          {playing ? (
            <>
              <div className="muted small">지금 송출 중</div>
              <div className="big-line">▶ {playing.label}</div>
            </>
          ) : next ? (
            <>
              <div className="muted small">다음 방송</div>
              <div className="big-line">
                <span className="mono">{kstTime(next.at ?? 0)}</span> {next.label}
              </div>
              {next.at && <div className="muted small">{countdown(next.at - now)} 후</div>}
            </>
          ) : (
            <div className="muted">{r.armed ? '남은 방송 없음' : '자동 방송 대기 아님'}</div>
          )}
        </div>
      </header>

      <ul className={`reasons ${r.health}`}>
        {r.reasons.slice(0, 6).map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>

      {list.length > 0 ? (
        <ol className="special-timeline" ref={listRef}>
          {list.map((x) => (
            <li
              key={x.key}
              data-key={x.key}
              className={`k-${x.cell.kind} ${x.key === focusKey ? 'is-focus' : ''}`}
              title={`${x.period} ${x.label}\n${x.entry?.t ? `${kstTime(x.entry.t)} 시작 (${formatDrift(x.cell.driftMs)})` : CELL_LABEL[x.cell.kind]}`}
            >
              <span className="mono">{x.time.slice(0, 5)}</span>
              <CellBox cell={x.cell} title={cellTitle(r.name, x.cell, x.entry)} />
              <span className="st-label">
                <span className="muted">{x.period}</span> {x.label}
              </span>
              <span className="muted small st-result">
                {x.entry?.t ? formatDrift(x.cell.driftMs) : r.armed ? CELL_LABEL[x.cell.kind] : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">시간표가 없습니다.</p>
      )}
    </section>
  );
}

export function countdown(ms: number) {
  if (ms <= 0) return '0초';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}시간 ${m}분` : m ? `${m}분 ${sec}초` : `${sec}초`;
}
