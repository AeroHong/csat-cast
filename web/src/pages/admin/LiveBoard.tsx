import { Fragment, useMemo } from 'react';
import { buildColumns, formatDrift, type Cell, type CellKind, type TimelineEntry } from '../../core/board';
import { kstTime } from '../../core/scheduler';
import type { Cue } from '../../core/types';
import { rowCells, rowNext, type ChannelRow } from './data';

export const CELL_LABEL: Record<CellKind, string> = {
  idle: '자동 방송 대기 아님',
  pending: '예정',
  soon: '곧 송출 (2분 이내)',
  playing: '송출 중',
  played: '송출 완료',
  manual: '수동 송출',
  skipped: '건너뜀',
  failed: '재생 실패',
  missing: '송출 보고 없음',
  offline: '연결 끊김 (확인 불가)',
};

const CELL_MARK: Record<CellKind, string> = {
  idle: '·',
  pending: '',
  soon: '●',
  playing: '▶',
  played: '✓',
  manual: '✋',
  skipped: '↷',
  failed: '✕',
  missing: '?',
  offline: '…',
};

export function cellTitle(name: string, cell: Cell, entry?: TimelineEntry, cue?: Cue) {
  const what = entry ? `${entry.period} ${entry.label}` : cue ? `${cue.period} ${cue.label}` : '';
  const lines = [`${name} — ${what}`, CELL_LABEL[cell.kind]];
  if (cell.at) lines.push(`예정 ${kstTime(cell.at)}`);
  if (entry?.t) lines.push(`실제 시작 ${kstTime(entry.t)} (${formatDrift(cell.driftMs)})`);
  return lines.join('\n');
}

export function CellBox({ cell, title }: { cell: Cell; title: string }) {
  const showDrift = (cell.kind === 'played' || cell.kind === 'manual') && cell.driftMs !== undefined && Math.abs(cell.driftMs) >= 1000;
  return (
    <span className={`cell ${cell.kind}`} title={title} aria-label={title}>
      {CELL_MARK[cell.kind]}
      {showDrift && <small>{Math.round(cell.driftMs! / 1000)}s</small>}
    </span>
  );
}

/** 일반 시험장: 학교 × 방송 시각 표 */
export default function LiveBoard({ rows, now }: { rows: ChannelRow[]; now: number }) {
  const columns = useMemo(
    () => buildColumns(rows.map((r) => (r.timeline ? r.timeline.map((e) => ({ ...e, kind: 'bell' as const, assetId: '' })) : r.expected))),
    [rows],
  );
  // 다음에 나갈 열을 강조
  const nextTime = useMemo(() => {
    let best: { at: number; time: string } | null = null;
    for (const r of rows)
      for (const e of r.timeline ?? [])
        if ((e.s === 'pending' || e.s === 'scheduled') && e.at >= now && (!best || e.at < best.at)) best = { at: e.at, time: e.time };
    return best?.time;
  }, [rows, now]);
  const periods = useMemo(() => {
    const out: { period: string; span: number }[] = [];
    for (const c of columns) {
      const last = out.at(-1);
      if (last && last.period === c.period) last.span++;
      else out.push({ period: c.period, span: 1 });
    }
    return out;
  }, [columns]);

  if (!rows.length) return <p className="muted">표시할 시험장이 없습니다.</p>;

  return (
    <div className="matrix-scroll">
      <table className="matrix">
        <thead>
          <tr>
            <th className="sticky" rowSpan={2}>
              시험장
            </th>
            {periods.map((p, i) => (
              <th key={i} colSpan={p.span} className="period">
                {p.period}
              </th>
            ))}
            <th rowSpan={2} className="next-col">
              다음 방송
            </th>
          </tr>
          <tr>
            {columns.map((c) => (
              <th key={c.time} className={`time ${c.time === nextTime ? 'is-next' : ''}`} title={c.labels.join('\n')}>
                {c.time.slice(0, 5)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cells = rowCells(r, now);
            const next = rowNext(r, now);
            return (
              <Fragment key={`${r.code}/${r.ch}`}>
                <tr className={`h-${r.health}`}>
                  <th className="sticky school" title={r.reasons.join('\n')}>
                    <div className="school-name">
                      {r.examNo ? <span className="no">{String(r.examNo).padStart(2, '0')}</span> : null}
                      {r.name}
                      {r.ch !== 'main' && <span className="muted"> · {r.label}</span>}
                    </div>
                    <div className="school-meta muted">
                      {r.typeNo ? `유형 ${r.typeNo}` : r.customSchedule ? '자체 시간표' : '유형 미지정'}
                      {r.s?.mode && r.s.mode !== 'idle' && <span className={`tag ${r.s.mode}`}>{r.s.mode === 'live' ? '실전' : '테스트'}</span>}
                      {r.s?.operator && ` · ${r.s.operator}`}
                    </div>
                    <div className={`school-reason ${r.health}`}>{r.reasons[0]}</div>
                  </th>
                  {columns.map((c) => {
                    const x = cells.get(c.time);
                    if (!x) return <td key={c.time} className="none" />;
                    return (
                      <td key={c.time} className={c.time === nextTime ? 'is-next' : ''}>
                        <CellBox cell={x.cell} title={cellTitle(r.name, x.cell, x.entry, x.cue)} />
                      </td>
                    );
                  })}
                  <td className="next-col">
                    {next ? (
                      <>
                        <span className="mono">{kstTime(next.at ?? 0).slice(0, 8)}</span> {next.label}
                      </>
                    ) : (
                      <span className="muted">{r.armed ? '남은 방송 없음' : '—'}</span>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CellLegend() {
  const kinds: CellKind[] = ['played', 'manual', 'playing', 'soon', 'pending', 'skipped', 'failed', 'missing', 'offline', 'idle'];
  return (
    <div className="legend">
      {kinds.map((k) => (
        <span key={k}>
          <CellBox cell={{ kind: k }} title={CELL_LABEL[k]} /> {CELL_LABEL[k]}
        </span>
      ))}
    </div>
  );
}
