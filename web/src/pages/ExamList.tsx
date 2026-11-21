import { useState } from 'react';
import { missingAudioCount, newExamId, saveExam, validateExam } from '../core/exams';
import type { ArmedDate, ChannelConfig, Exam } from '../core/types';
import { shortDate } from './RehearsalScheduler';

function dday(from: string, to: string) {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  return n === 0 ? '오늘' : n > 0 ? `D-${n}` : '지남';
}

/**
 * 외부 시험 방송 목록 + 새 시험 만들기.
 * 시험마다 날짜를 정해 두면 그날 이 화면을 열어 두기만 해도 시간표대로 자동 방송한다.
 */
export default function ExamList({
  neisCode,
  exams,
  channels,
  channelId,
  today,
  official,
  assetIds,
  selectedId,
  runningId,
  operator,
  onSelect,
}: {
  neisCode: string;
  exams: Exam[];
  channels: ChannelConfig[];
  /** 새 시험을 만들 기본 채널 (지금 보고 있는 채널) */
  channelId: string;
  today: string;
  official: ArmedDate[];
  assetIds: Set<string>;
  selectedId: string | null;
  /** 지금 자동 방송 중인 시험 */
  runningId: string | null;
  operator?: string;
  onSelect: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState(false);
  /** 새 시험 입력 칸 (시험이 없을 때만 처음부터 펼친다) */
  const [adding, setAdding] = useState(exams.length === 0);

  async function create() {
    const exam: Exam = { id: newExamId(), name: name.trim(), date, channelId, cues: [], updatedAt: Date.now(), updatedBy: operator };
    const r = validateExam(exam, { today, official, existing: exams });
    setErrors([...r.errors, ...r.warnings]);
    if (r.errors.length) return;
    if (r.warnings.length && !window.confirm(`${r.warnings.join('\n')}\n\n이대로 만들까요?`)) return;
    setBusy(true);
    try {
      await saveExam(neisCode, exam);
      setName('');
      setErrors([]);
      setAdding(false);
      onSelect(exam.id);
    } catch (e) {
      setErrors([`만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  }

  const upcoming = exams.filter((e) => e.date >= today);
  const past = exams.filter((e) => e.date < today).reverse();
  const channelLabel = (id: string) => (channels.length > 1 ? (channels.find((c) => c.id === id)?.label ?? id) : null);

  const item = (e: Exam) => {
    const missing = missingAudioCount(e, assetIds);
    return (
      <li key={e.id} className={`exam-item ${e.id === selectedId ? 'selected' : ''} ${e.date === today ? 'is-today' : ''}`}>
        <button className="exam-pick" onClick={() => onSelect(e.id)}>
          <span className="exam-name">
            <strong>{e.name}</strong>
            {e.id === runningId && <span className="tag live">방송 중</span>}
          </span>
          <span className="muted small">
            <span className="mono">{shortDate(e.date)}</span> <span className="tag">{dday(today, e.date)}</span> · 방송 {e.cues.length}개
            {channelLabel(e.channelId) && ` · ${channelLabel(e.channelId)}`}
            {missing > 0 && <span className="error"> · 음원 없음 {missing}</span>}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="card">
      <h2>시험 방송</h2>
      <p className="muted small">시험을 고르면 오른쪽에서 음원·시간표를 작업합니다. 그날 [방송 진행] 화면을 열어 두면 자동 방송합니다.</p>

      {upcoming.length === 0 ? <p className="muted">예정된 시험 방송이 없습니다.</p> : <ul className="exam-list">{upcoming.map(item)}</ul>}
      {past.length > 0 && (
        <>
          <button className="link" onClick={() => setShowPast((v) => !v)}>
            {showPast ? '지난 시험 숨기기 ▲' : `지난 시험 ${past.length}개 보기 ▼`}
          </button>
          {showPast && <ul className="exam-list past">{past.map(item)}</ul>}
        </>
      )}

      {!adding ? (
        <button className="primary" onClick={() => setAdding(true)}>
          ＋ 새 시험
        </button>
      ) : (
      <div className="sched-form">
        <strong>＋ 새 시험</strong>
        <label>
          이름
          <input type="text" value={name} placeholder="예: 3월 전국연합학력평가" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          날짜
          <input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void create()}>
            {busy ? '만드는 중…' : '시험 만들기'}
          </button>
          {exams.length > 0 && <button onClick={() => setAdding(false)}>취소</button>}
        </div>
        {errors.length > 0 && (
          <ul className="error small">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
      )}
    </section>
  );
}
