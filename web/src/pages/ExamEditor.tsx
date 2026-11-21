import { useEffect, useMemo, useState } from 'react';
import { loadSchoolAssetDocs } from '../core/catalog';
import { copyExam, deleteExam, missingAudioCount, saveExam, validateExam } from '../core/exams';
import { deleteSchoolAudio } from '../core/schoolSchedule';
import type { ArmedDate, Asset, ChannelConfig, Exam } from '../core/types';
import { shortDate } from './RehearsalScheduler';
import ScheduleEditor, { type EditTarget } from './ScheduleEditor';

interface Props {
  neisCode: string;
  exam: Exam;
  exams: Exam[];
  channels: ChannelConfig[];
  today: string;
  official: ArmedDate[];
  assets: Asset[];
  operator?: string;
  /** 이 시험을 지금 자동 방송 중이면 이미 나갔거나 나가는 중인 줄 */
  live?: { date: string; lockedIds: Set<string> };
  /** 다른 방송이 자동 진행 중 (이 시험 시간표는 고쳐도 되지만 미리 듣기 등은 막음) */
  audioBusy: boolean;
  /** 이 시험 밖(수능 시간표·다른 시험)에서 쓰는 음원 */
  usedElsewhere: (assetId: string) => boolean;
  othersArmed?: string[];
  onAssets: (a: Asset[]) => void;
  onSelect: (id: string | null) => void;
}

/** 시험 방송 한 건 편집: 이름·날짜·채널 + 음원·시간표 */
export default function ExamEditor({
  neisCode,
  exam,
  exams,
  channels,
  today,
  official,
  assets,
  operator,
  live,
  audioBusy,
  usedElsewhere,
  othersArmed,
  onAssets,
  onSelect,
}: Props) {
  const [name, setName] = useState(exam.name);
  const [date, setDate] = useState(exam.date);
  const [channelId, setChannelId] = useState(exam.channelId);
  const [copyDate, setCopyDate] = useState('');
  const [msg, setMsg] = useState<{ level: 'bad' | 'okay'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 다른 시험을 고르거나 다른 PC에서 이름·날짜를 바꾸면 맞춘다
  useEffect(() => {
    setName(exam.name);
    setDate(exam.date);
    setChannelId(exam.channelId);
  }, [exam.id, exam.name, exam.date, exam.channelId]);
  useEffect(() => setMsg(null), [exam.id]);

  const metaDirty = name !== exam.name || date !== exam.date || channelId !== exam.channelId;
  const assetIds = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const missing = missingAudioCount(exam, assetIds);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ level: 'bad', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const saveMeta = () =>
    act(async () => {
      const next = { ...exam, name: name.trim(), date, channelId, updatedBy: operator };
      const r = validateExam(next, { today, official, existing: exams });
      if (r.errors.length) throw new Error(r.errors.join(' / '));
      if (r.warnings.length && !window.confirm(`${r.warnings.join('\n')}\n\n이대로 저장할까요?`)) return;
      await saveExam(neisCode, next);
      setMsg({ level: 'okay', text: '이름·날짜를 저장했습니다.' });
    });

  const copy = () =>
    act(async () => {
      const c = copyExam(exam, copyDate, exam.name);
      const r = validateExam(c, { today, official, existing: exams });
      if (r.errors.length) throw new Error(r.errors.join(' / '));
      await saveExam(neisCode, { ...c, updatedBy: operator });
      setCopyDate('');
      onSelect(c.id);
    });

  /** 이 시험에서 올렸고 다른 곳(수능 시간표·다른 시험)에서 쓰지 않는 음원 — 시험을 지우면 함께 지운다 */
  const ownAudio = assets.filter((a) => a.examId === exam.id && !usedElsewhere(a.id));
  const remove = () => {
    if (
      !window.confirm(
        `"${exam.name}"(${exam.date}) 시험 방송을 삭제할까요? 시간표는 복구할 수 없습니다.` +
          (ownAudio.length ? `
이 시험에서 올린 음원 ${ownAudio.length}개도 함께 삭제합니다.` : ''),
      )
    )
      return;
    void act(async () => {
      await deleteExam(neisCode, exam.id);
      const ids = new Set(ownAudio.map((a) => a.id));
      const removed: string[] = [];
      for (const [id, d] of await loadSchoolAssetDocs(neisCode)) {
        if (!ids.has(id)) continue;
        await deleteSchoolAudio(neisCode, id, d).then(
          () => removed.push(id),
          () => undefined,
        );
      }
      if (removed.length) onAssets(assets.filter((a) => !removed.includes(a.id)));
      onSelect(null);
    });
  };

  const target: EditTarget = {
    key: `exam:${exam.id}`,
    saved: exam.cues,
    save: async (cues) => {
      await saveExam(neisCode, { ...exam, cues, updatedBy: operator });
    },
    allowMissingAudio: true,
    examId: exam.id,
    title: '시험 시간표',
    status: (
      <>
        {shortDate(exam.date)} {exam.name} · 방송 {exam.cues.length}개
        {missing > 0 && <span className="error"> · 음원 없는 방송 {missing}곳</span>}
      </>
    ),
    savedNotice: live
      ? '저장했습니다. 진행 중인 방송에 바로 반영됩니다.'
      : '저장했습니다. 그날 이 화면을 열어 두면 시간표대로 자동 방송합니다.',
  };

  return (
    <>
      <section className="card exam-meta">
        <div className="row">
          <label>
            시험 이름
            <input type="text" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            날짜
            <input
              type="date"
              value={date}
              disabled={busy || !!live}
              title={live ? '방송 중에는 날짜를 바꿀 수 없습니다' : undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {channels.length > 1 && (
            <label>
              채널
              <select value={channelId} disabled={busy || !!live} onChange={(e) => setChannelId(e.target.value)}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="primary" disabled={busy || !metaDirty} onClick={() => void saveMeta()}>
            저장
          </button>
          <span className="spacer" />
          <label>
            다른 날로 복사
            <input type="date" value={copyDate} min={today} disabled={busy} onChange={(e) => setCopyDate(e.target.value)} />
          </label>
          <button disabled={busy || !copyDate} onClick={() => void copy()}>
            복사
          </button>
          <button
            className="link danger-text"
            disabled={busy || !!live}
            title={live ? '방송 중인 시험은 [자동 방송 중지] 후 지울 수 있습니다' : undefined}
            onClick={remove}
          >
            삭제
          </button>
        </div>
        {msg && <div className={`banner ${msg.level}`}>{msg.text}</div>}
      </section>
      <ScheduleEditor
        key={exam.id}
        neisCode={neisCode}
        target={target}
        assets={assets}
        locked={false}
        live={live}
        audioBusy={audioBusy}
        othersArmed={othersArmed}
        usedElsewhere={usedElsewhere}
        onAssets={onAssets}
      />
    </>
  );
}
