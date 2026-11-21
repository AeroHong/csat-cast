import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import TimeInput from '../components/TimeInput';
import { audioEngine, fetchAssetBytes } from '../core/audio';
import { serverClock } from '../core/clock';
import { kstEpoch } from '../core/scheduler';
import { mixdown, MIX_SAMPLE_RATE } from '../core/audioMix';
import { byLabel, downloadBlob, encodeMp3, nextDownload, safeFileName } from '../core/mp3';
import { loadSchoolAssetDocs } from '../core/catalog';
import {
  checkSchedule,
  deleteSchoolAudio,
  toSchoolAsset,
  uploadSchoolAudio,
  type SchoolAssetDoc,
} from '../core/schoolSchedule';
import { assignByFileName, looksLikeSchedule, parseScheduleRows, timeFromFileName } from '../core/scheduleImport';
import type { Asset, Cue, Template } from '../core/types';
import AudioComposer, { type Saved } from './AudioComposer';
import { formatDuration } from './NowPlaying';

/**
 * 무엇을 편집하는가: 수능 채널의 학교 시간표(customCues) 또는 외부 시험 방송의 시간표.
 */
export interface EditTarget {
  /** 편집 내용 임시 보관·화면 초기화 기준 (대상마다 다르게) */
  key: string;
  saved: Cue[] | undefined;
  /** 저장 (실패하면 throw) */
  save: (cues: Cue[]) => Promise<void>;
  /** 학교 시간표 지우기 (수능 채널만) */
  revert?: () => Promise<void>;
  /** 음원 없는 줄·빈 시간표도 저장 (시험 방송: 시간표 먼저 만들고 음원은 나중에) */
  allowMissingAudio?: boolean;
  title: string;
  status: ReactNode;
  /** 아직 시간표가 없을 때 안내 */
  intro?: ReactNode;
  savedNotice: string;
  /** 복사해서 시작할 평가원 유형 (수능 채널만) */
  template?: Template;
  /**
   * 시험 방송이면 그 시험 id. 음원 목록에는 이 시험에서 올렸거나 이 시험에서 쓰는 음원만 보이고, 평가원 음원은 쓰지 않는다.
   * 없으면 수능 시간표: 시험 방송에서 올린 음원은 보이지 않는다.
   */
  examId?: string;
}

interface Props {
  neisCode: string;
  target: EditTarget;
  assets: Asset[];
  /** 전부 고칠 수 없음 (다른 방송이 자동 진행 중 등) */
  locked: boolean;
  /** 이 대상을 지금 자동 방송 중: 아직 안 나간 줄만 고칠 수 있다 */
  live?: { date: string; lockedIds: Set<string> };
  /** 자동 방송 중 (미리 듣기·타종 붙이기는 방송 스피커로 나가므로 막는다) */
  audioBusy: boolean;
  /** 같은 채널을 자동 방송 중인 다른 PC (담당자 이름) */
  othersArmed?: string[];
  /** 이 대상 밖(다른 채널·다른 시험)에서 쓰는 음원 — 삭제 금지 */
  usedElsewhere: (assetId: string) => boolean;
  onAssets: (a: Asset[]) => void;
}

/** 방송 중 저장할 때, 이보다 가까운 시각의 줄은 송출 준비가 늦어 건너뛸 수 있다 */
const LIVE_EDIT_MARGIN_MS = 10_000;

const newId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 저장하지 않은 편집 내용 (이 PC에만). 음원을 다 만들기 전에 새로고침해도 엑셀로 채운 시간표가 남게 */
const draftKey = (neisCode: string, key: string) => `csat-cast:schedule-draft:${neisCode}:${key}`;
function loadStoredDraft(neisCode: string, channelId: string, saved: Cue[] | undefined): Cue[] | null {
  try {
    const v = localStorage.getItem(draftKey(neisCode, channelId));
    if (!v) return null;
    const d = JSON.parse(v) as Cue[];
    return JSON.stringify(d) !== JSON.stringify(saved ?? null) ? d : null;
  } catch {
    return null;
  }
}

/** "HH:MM" 또는 "HH:MM:SS" → "HH:MM:SS" */
const normTime = (t: string) => (t.length === 5 ? `${t}:00` : t);

function addMinutes(time: string, min: number) {
  const [h, m, s] = time.split(':').map(Number);
  const total = Math.min(h * 3600 + m * 60 + (s || 0) + min * 60, 23 * 3600 + 59 * 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * 학교 자체 시간표 편집 + 학교 음원 관리.
 * 저장하기 전까지는 방송에 반영되지 않는다. 저장하면 이 채널은 평가원 유형 대신 이 시간표로 방송한다.
 */
export default function ScheduleEditor({ neisCode, target, assets, locked, live, audioBusy, othersArmed = [], usedElsewhere, onAssets }: Props) {
  const saved = target.saved;
  const template = target.template;
  const tkey = target.key;
  const rowLocked = (id: string) => !!live?.lockedIds.has(id);
  const initialDraft = () => loadStoredDraft(neisCode, tkey, saved) ?? (saved ? structuredClone(saved) : null);
  const [draft, setDraft] = useState<Cue[] | null>(initialDraft);
  const [allDocs, setDocs] = useState<[string, SchoolAssetDoc][]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    loadStoredDraft(neisCode, tkey, saved)
      ? '저장하지 않은 편집 내용을 이어서 불러왔습니다. 음원을 모두 연결한 뒤 [저장]해야 방송에 반영됩니다.'
      : null,
  );
  /** 엑셀 가져오기 결과 (합친 줄·중복 등 확인할 내용) */
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const firstChannelEffect = useRef(true);
  const [uploadLabel, setUploadLabel] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** 타종 붙여 새 음원 만들기 열림 (값: 목록에서 고른 음원 id들) */
  const [composing, setComposing] = useState<string[] | null>(null);
  /** 타종 붙인 뒤 지울 원본 중, 저장된 시간표에서 아직 써서 [저장] 뒤에 지울 음원 */
  const pendingDelete = useRef(new Set<string>());
  /** 학교 음원 목록 접기 (음원이 많으면 아래 시간표 칸이 좁아지므로) */
  const [assetsFolded, setAssetsFolded] = useState(false);
  /** 학교 음원 목록에서 고른 음원 (타종 붙이기 대상) */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // 채널이 바뀌거나 저장된 시간표가 바뀌면 편집 내용을 다시 맞춘다 (처음 열 때는 initialDraft가 맞춰 둠)
  useEffect(() => {
    if (firstChannelEffect.current) {
      firstChannelEffect.current = false;
      return;
    }
    setDraft(initialDraft());
    setImportNotes([]);
  }, [tkey, JSON.stringify(saved ?? null)]);

  useEffect(() => {
    void loadSchoolAssetDocs(neisCode).then(setDocs);
  }, [neisCode]);

  /** 이 시간표에서 쓰는 음원 (다른 쪽 음원이라도 이미 연결돼 있으면 목록에 보인다) */
  const usedHere = (id: string) => [...(draft ?? []), ...(saved ?? [])].some((c) => c.assetId === id);
  /** 수능 시간표와 시험 방송은 음원 목록을 따로 쓴다 */
  const inScope = (id: string, examOf: string | undefined) => (target.examId ? examOf === target.examId : !examOf) || usedHere(id);
  const docs = allDocs.filter(([id, d]) => inScope(id, d.examId));
  const schoolAssets = assets.filter((a) => a.source !== 'builtin' && inScope(a.id, a.examId)).sort(byLabel);
  /** 학교 음원 목록 (화면에 보이는 이름순. 고른 음원도 이 순서로 처리한다) */
  const sortedDocs = useMemo(() => [...docs].sort((a, b) => byLabel(a[1], b[1])), [docs]);
  const builtinAssets = target.examId ? [] : assets.filter((a) => a.source === 'builtin');
  const assetIds = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const check = useMemo(
    () =>
      draft ? checkSchedule(draft, assetIds, { allowMissingAudio: target.allowMissingAudio, allowEmpty: target.allowMissingAudio }) : null,
    [draft, assetIds, target.allowMissingAudio],
  );
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved ?? null);
  const missingAudio = [...(draft ?? [])].filter((c) => !c.assetId).sort((a, b) => a.time.localeCompare(b.time));

  // 저장하지 않은 편집 내용은 이 PC에 보관하고, 저장·취소하면 지운다
  useEffect(() => {
    try {
      if (dirty && draft) localStorage.setItem(draftKey(neisCode, tkey), JSON.stringify(draft));
      else localStorage.removeItem(draftKey(neisCode, tkey));
    } catch {
      /* 보관 못 해도 편집은 계속 */
    }
  }, [draft, dirty, neisCode, tkey]);
  const periods = [...new Set((draft ?? []).map((c) => c.period).filter(Boolean))];
  /** 편집 중인 시간표에서 쓰는 곳 수 */
  const usage = (id: string) => (draft ?? saved ?? []).filter((c) => c.assetId === id).length;
  /** 저장된 시간표나 편집 중인 시간표 어디서든 쓰면 삭제할 수 없다 */
  const inUse = (id: string) => [...(draft ?? []), ...(saved ?? [])].some((c) => c.assetId === id) || usedElsewhere(id);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function update(id: string, patch: Partial<Cue>) {
    setDraft((d) => d && d.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function addRow() {
    setDraft((d) => {
      const list = d ?? [];
      const last = [...list].sort((a, b) => a.time.localeCompare(b.time)).at(-1);
      return [
        ...list,
        {
          id: newId(),
          time: last ? addMinutes(last.time, 5) : '08:00:00',
          period: last?.period ?? '',
          label: '',
          kind: 'ment',
          assetId: '',
          official: false,
        },
      ];
    });
  }

  function startFromTemplate() {
    if (!template) return;
    setDraft(template.cues.map((c) => ({ ...c, official: false })));
    setNotice(`${template.name}을(를) 복사했습니다. 고친 뒤 [저장]해야 방송에 반영됩니다.`);
  }

  function startEmpty() {
    setDraft([]);
    addRow();
  }

  const save = () =>
    run('save', async () => {
      if (!draft || check?.errors.length) return;
      const warnings = [...(check?.warnings ?? [])];
      if (live) {
        // 방송 중: 곧 나갈(또는 이미 지난) 시각으로 바꾼 줄은 건너뛰게 된다
        const soon = serverClock.now() + LIVE_EDIT_MARGIN_MS;
        const before = new Map((saved ?? []).map((c) => [c.id, JSON.stringify(c)]));
        const late = draft.filter((c) => !rowLocked(c.id) && before.get(c.id) !== JSON.stringify(c) && kstEpoch(live.date, c.time) <= soon);
        if (late.length)
          warnings.push(`지금 시각이 지났거나 곧 다가오는 방송은 송출되지 않고 건너뜁니다: ${late.map((c) => `${c.time.slice(0, 5)} ${c.label}`).join(', ')}`);
      }
      if (warnings.length && !window.confirm(`확인이 필요합니다:\n\n${warnings.join('\n')}\n\n이대로 저장할까요?`)) return;
      const cues = [...draft].sort((a, b) => a.time.localeCompare(b.time)).map((c) => ({ ...c, official: false }));
      await target.save(cues);
      // 타종 붙인 새 음원으로 바꿔 둔 원본은 저장된 시간표에서 빠졌으니 이제 지운다
      const ready = [...pendingDelete.current].filter((id) => !cues.some((c) => c.assetId === id) && !usedElsewhere(id));
      pendingDelete.current.clear();
      const removed = await deleteOriginals(ready);
      if (removed.length) onAssets(assets.filter((a) => !removed.includes(a.id)));
      setNotice(`${target.savedNotice}${removed.length ? ` 바꿔 둔 원본 음원 ${removed.length}개도 삭제했습니다.` : ''}`);
    });

  /** 원본 음원 지우기 (목록에서도 뺀다). 지운 id를 돌려준다. 실패한 원본은 남겨 두어 담당자가 목록에서 지울 수 있다 */
  async function deleteOriginals(ids: string[]): Promise<string[]> {
    const done: string[] = [];
    for (const id of ids) {
      const d = docs.find(([x]) => x === id)?.[1];
      if (!d) continue;
      try {
        await deleteSchoolAudio(neisCode, id, d);
        done.push(id);
      } catch {
        /* 남겨 둔다 */
      }
    }
    if (done.length) setDocs((ds) => ds.filter(([x]) => !done.includes(x)));
    return done;
  }

  /** 타종 붙여 저장한 뒤: 원본 삭제를 골랐으면 시간표의 원본 자리를 새 음원으로 바꾸고 원본을 지운다 */
  async function afterCompose(items: Saved[], failed: string[], removeOriginals: boolean) {
    const ids = new Set(items.map((x) => x.asset.id));
    let nextAssets = [...assets.filter((a) => !ids.has(a.id)), ...items.map((x) => x.asset)];
    setDocs((ds) => [...ds.filter(([id]) => !ids.has(id)), ...items.map((x): [string, SchoolAssetDoc] => [x.asset.id, x.doc])]);
    setComposing(null);
    // 원본을 남겼으면 새 음원을 골라 둔다 → 바로 [시간표에 적용]
    setSelected(removeOriginals ? new Set() : ids);
    const msgs: string[] = [];
    if (items.length === 1) msgs.push(`"${items[0].doc.label}" 음원을 만들어 저장했습니다 (${formatDuration(items[0].doc.durationMs / 1000)}).`);
    else if (items.length) msgs.push(`타종을 붙인 음원 ${items.length}개를 저장했습니다: ${items.map((x) => x.doc.label).join(', ')}.`);
    if (removeOriginals) {
      const withFrom = items.filter((x) => x.from && x.from !== x.asset.id);
      const swaps = withFrom.filter((x) => !usedElsewhere(x.from!));
      const kept = withFrom.length - swaps.length;
      // 편집 중인 시간표에서 원본을 쓰던 자리는 새 음원으로 바꾼다
      const swapOf = new Map(swaps.map((x) => [x.from!, x.asset.id]));
      const swappedInDraft = (draft ?? []).some((c) => swapOf.has(c.assetId));
      if (swappedInDraft) setDraft((d) => d && d.map((c) => (swapOf.has(c.assetId) ? { ...c, assetId: swapOf.get(c.assetId)! } : c)));
      // 저장된 시간표에서 쓰는 원본은 시간표 [저장] 뒤에 지우고, 나머지는 바로 지운다
      const later = swaps.map((x) => x.from!).filter((id) => (saved ?? []).some((c) => c.assetId === id));
      later.forEach((id) => pendingDelete.current.add(id));
      const removed = await deleteOriginals(swaps.map((x) => x.from!).filter((id) => !later.includes(id)));
      nextAssets = nextAssets.filter((a) => !removed.includes(a.id));
      if (removed.length) msgs.push(`원본 ${removed.length}개를 삭제했습니다.`);
      if (swappedInDraft) msgs.push('시간표에서 원본을 쓰던 자리는 새 음원으로 바꿨습니다.');
      if (later.length) msgs.push(`원본 ${later.length}개는 지금 방송하는 시간표에서 쓰고 있어, 아래 시간표를 [저장]하면 삭제됩니다.`);
      if (kept) msgs.push(`원본 ${kept}개는 다른 시간표(다른 채널·시험)에서 쓰고 있어 남겨 두었습니다.`);
    } else if (items.length) msgs.push('새 음원을 골라 두었습니다. [📋 시간표에 적용]을 누르면 원래 음원 자리에 연결됩니다.');
    onAssets(nextAssets);
    setNotice(msgs.join(' ') || null);
    if (failed.length) setError(`저장하지 못한 음원 ${failed.length}개: ${failed.join(' / ')}`);
  }
  

  /**
   * 고른 음원을 편집 중인 시간표에 일괄 연결 (저장은 담당자가 [저장]으로).
   * 1) 「원래 이름 (타종)」이면 원래 음원을 쓰던 줄을 이 음원으로 바꾼다
   * 2) 아니면 이름·파일 이름 앞의 시각(16:20 …, 1620_…)과 같은 시각 줄에 연결한다 (초까지 같은 줄, 없으면 같은 분의 줄이 하나일 때)
   */
  function applyToTimetable(ids: string[]) {
    if (!draft) return setError('먼저 아래에서 학교 시간표를 만드세요 (평가원 시간표 복사 등).');
    let next = draft;
    const done: string[] = [];
    const missed: string[] = [];
    for (const id of ids) {
      const d = docs.find(([x]) => x === id)?.[1];
      if (!d) continue;
      const base = /^(.*) \(타종\)$/.exec(d.label)?.[1];
      const origins = base ? docs.filter(([x, o]) => x !== id && o.label === base).map(([x]) => x) : [];
      let rows = origins.length ? next.filter((c) => origins.includes(c.assetId)) : [];
      if (!rows.length) {
        const time = timeFromFileName(d.label) ?? timeFromFileName(d.fileName);
        if (time) {
          rows = next.filter((c) => c.time === time);
          if (!rows.length) {
            const sameMinute = next.filter((c) => c.time.slice(0, 5) === time.slice(0, 5));
            if (sameMinute.length === 1) rows = sameMinute;
          }
        }
      }
      if (!rows.length) {
        missed.push(d.label);
        continue;
      }
      const hit = new Set(rows.map((c) => c.id));
      next = next.map((c) => (hit.has(c.id) && !rowLocked(c.id) ? { ...c, assetId: id } : c));
      done.push(`${d.label} → ${rows.map((c) => c.time.slice(0, 5)).join(', ')}`);
    }
    setDraft(next);
    setSelected(new Set());
    setError(
      missed.length
        ? `맞는 줄을 찾지 못한 음원 ${missed.length}개: ${missed.join(', ')}. 이름 앞에 시각(예: 16:20 준비령)을 넣거나, 시간표의 음원 칸에서 직접 고르세요.`
        : null,
    );
    setNotice(done.length ? `음원 ${done.length}개를 시간표에 연결했습니다 (${done.join(' / ')}). 아래 [저장]해야 방송에 반영됩니다.` : null);
  }

  const revert = () => {
    if (!target.revert) return;
    if (!window.confirm('학교 시간표를 지우고 평가원 시간표로 되돌릴까요? 만든 시간표는 복구할 수 없습니다 (올린 음원은 남습니다).'))
      return;
    void run('revert', async () => {
      await target.revert!();
      setDraft(null);
      setNotice('평가원 시간표로 되돌렸습니다.');
    });
  };

  /**
   * 음원 올리기 (여러 개 가능). 파일 이름 앞에 시각이 있으면(1710_….mp3) 편집 중인 시간표의 같은 시각 줄에 바로 연결한다.
   * 같은 시각 파일을 다시 올리면 그 줄의 음원이 새 파일로 바뀐다.
   */
  const upload = (files: File[]) =>
    run('upload', async () => {
      const uploaded: { asset: Asset; doc: SchoolAssetDoc; time: string | null }[] = [];
      const failed: string[] = [];
      for (const [i, file] of files.entries()) {
        setBusy(`upload:${i + 1}/${files.length}`);
        const time = timeFromFileName(file.name);
        const cue = time ? draft?.find((c) => c.time === time) : undefined;
        const label = files.length === 1 && uploadLabel.trim() ? uploadLabel : cue && time ? `${time.slice(0, 5)} ${cue.label}` : '';
        try {
          uploaded.push({ ...(await uploadSchoolAudio(neisCode, file, label, { examId: target.examId })), time });
        } catch (e) {
          failed.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const ids = new Set(uploaded.map((u) => u.asset.id));
      setDocs((ds) => [...ds.filter(([id]) => !ids.has(id)), ...uploaded.map((u) => [u.asset.id, u.doc] as [string, SchoolAssetDoc])]);
      onAssets([...assets.filter((a) => !ids.has(a.id)), ...uploaded.map((u) => u.asset)]);
      setUploadLabel('');
      // 시각이 맞는 줄에 연결 (같은 시각 파일이 여럿이면 나중 것)
      const byTime = new Map<string, string>();
      for (const u of uploaded) if (u.time) byTime.set(u.time, u.asset.id);
      const linkedTimes = draft ? [...byTime.keys()].filter((t) => draft.some((c) => c.time === t && !rowLocked(c.id))) : [];
      if (linkedTimes.length)
        setDraft((d) => d && d.map((c) => (byTime.has(c.time) && !rowLocked(c.id) ? { ...c, assetId: byTime.get(c.time)! } : c)));
      const parts: string[] = [];
      if (uploaded.length === 1 && !draft) parts.push(`"${uploaded[0].doc.label}" 음원을 올렸습니다 (${formatDuration(uploaded[0].doc.durationMs / 1000)}).`);
      else if (uploaded.length) parts.push(`음원 ${uploaded.length}개를 올렸습니다.`);
      if (draft && uploaded.length) {
        parts.push(`시간표 ${linkedTimes.length}곳에 연결했습니다.`);
        const unmatched = uploaded.filter((u) => !u.time || !linkedTimes.includes(u.time)).map((u) => u.doc.fileName);
        if (unmatched.length) parts.push(`시간표에 같은 시각이 없어 연결하지 않은 파일: ${unmatched.join(', ')}`);
      }
      if (parts.length) setNotice(parts.join(' '));
      if (failed.length) setError(`올리지 못한 파일: ${failed.join(' / ')}`);
    });

  /** 엑셀(교시·구분·타종시간)로 시간표를 한 번에 채운다. 이미 올린 음원은 파일 이름의 시각으로 연결한다 */
  const importExcel = (file: File) =>
    run('import', async () => {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('엑셀(.xlsx) 파일만 가져올 수 있습니다');
      const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
      let sheet: string | null = null;
      let rows: unknown[][] = [];
      for (const name of await readSheetNames(file)) {
        const r = (await readXlsxFile(file, { sheet: name })) as unknown[][];
        if (looksLikeSchedule(r)) {
          sheet = name;
          rows = r;
          break;
        }
      }
      if (!sheet) throw new Error('시간표 시트를 찾지 못했습니다. 첫 줄에 "교시 · 구분 · 타종시간" 머리글이 있는 시트가 필요합니다.');
      const { cues, notes } = parseScheduleRows(rows, () => newId());
      if (draft?.length && !window.confirm(`편집 중인 시간표(${draft.length}개)를 엑셀 내용(${cues.length}개)으로 바꿀까요?`)) return;
      const named = docs.filter(([id]) => assetIds.has(id)).map(([id, d]) => ({ id, fileName: d.fileName, uploadedAt: d.uploadedAt }));
      const { cues: withAudio, assigned } = assignByFileName(cues, named);
      setDraft(withAudio);
      setImportNotes(notes);
      setNotice(
        `"${sheet}" 시트에서 방송 ${cues.length}개를 가져왔습니다. 음원 ${assigned}곳 연결, ${cues.length - assigned}곳은 음원이 필요합니다. ` +
          '음원 파일 이름 앞에 시각을 붙여(예: 1710_한국사종료5분전.mp3) 올리면 해당 줄에 자동으로 연결됩니다. 모두 연결한 뒤 [저장]하세요.',
      );
    });

  const importButton = () => (
    <label
      className={`button ${disabled || live ? 'disabled' : ''}`}
      title={live ? '방송 중에는 시간표 전체를 바꿀 수 없습니다' : '교시 · 구분 · 타종시간 머리글이 있는 엑셀(.xlsx)'}
    >
      {busy === 'import' ? '가져오는 중…' : '📄 엑셀에서 가져오기'}
      <input
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        disabled={disabled || !!live}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importExcel(f);
        }}
      />
    </label>
  );

  const remove = (id: string, d: SchoolAssetDoc) => {
    if (!window.confirm(`"${d.label}" 음원을 삭제할까요?`)) return;
    void run('delete', async () => {
      await deleteSchoolAudio(neisCode, id, d);
      setDocs((ds) => ds.filter(([x]) => x !== id));
      onAssets(assets.filter((a) => a.id !== id));
    });
  };

  async function preview(id: string) {
    if (previewId) {
      audioEngine.stopAsset(previewId);
      if (previewId === id) return setPreviewId(null);
    }
    const asset = assets.find((a) => a.id === id) ?? docs.filter(([x]) => x === id).map(([x, d]) => toSchoolAsset(neisCode, x, d))[0];
    if (!asset) return;
    setPreviewId(id);
    try {
      await audioEngine.unlock();
      const r = await audioEngine.load([asset]);
      if (r.failed.length) throw new Error(r.failed[0].error);
      const h = await audioEngine.playNow(id);
      void h.ended.then(() => {
        setPreviewId((p) => (p === id ? null : p));
        // 자동 방송 중이 아닐 때만 미리 듣기가 가능하므로 디코딩 결과를 바로 내려 메모리를 아낀다
        audioEngine.release(id);
      });
    } catch (e) {
      setPreviewId(null);
      setError(`미리 듣기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 고른 음원을 MP3로 내려받기 (학교 방송 프로그램에 넣을 파일).
   * mp3는 올린 파일 그대로, wav(타종 붙여 저장한 음원 등)는 MP3로 바꾼다. 이름의 「(타종)」은 빼서 원래 파일 이름과 맞춘다.
   */
  function downloadSelected(ids: string[]) {
    void run('download', async () => {
      const failed: string[] = [];
      for (const [i, id] of ids.entries()) {
        setBusy(`download:${i + 1}/${ids.length}`);
        const d = docs.find(([x]) => x === id)?.[1];
        const asset = assets.find((a) => a.id === id);
        if (!d || !asset) continue;
        const name = `${safeFileName(d.label.replace(/\s*\(타종\)$/, ''))}.mp3`;
        try {
          const bytes = await fetchAssetBytes(asset);
          if (d.contentType === 'audio/mpeg') downloadBlob(new Blob([bytes], { type: 'audio/mpeg' }), name);
          else {
            const buf = await new OfflineAudioContext(1, 1, MIX_SAMPLE_RATE).decodeAudioData(bytes.slice(0));
            downloadBlob(await encodeMp3(mixdown(buf), buf.sampleRate), name);
          }
          await nextDownload();
        } catch (e) {
          failed.push(`${d.label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failed.length) throw new Error(`내려받지 못한 음원: ${failed.join(', ')}`);
      setNotice(`${ids.length}개를 MP3로 내려받았습니다 (브라우저 '다운로드' 폴더). 학교 방송 프로그램 음원 폴더에 넣어 쓰세요.`);
    });
  }

  const disabled = locked || busy !== null;
  const disabledAll = disabled;
  /** 지금 목록에 있는 음원 중 고른 수 (삭제된 음원은 빼고 센다) */
  const selectedCount = docs.filter(([id]) => selected.has(id)).length;

  return (
    <>
      <section className="card">
        <div className="asset-head">
          <h2>
            {target.examId ? '시험 음원' : '학교 음원'} {docs.length > 0 && <span className="muted small">{docs.length}개{selectedCount ? ` · ${selectedCount}개 선택` : ''}</span>}
          </h2>
          {docs.length > 0 && (
            <button className="link" onClick={() => setAssetsFolded((f) => !f)}>
              {assetsFolded ? '목록 펴기 ▼' : '목록 접기 ▲'}
            </button>
          )}
        </div>
        <p className="muted small">
          직접 녹음·제작한 안내 방송을 올립니다 (mp3·wav, 20MB 이하, 여러 개 한 번에 가능). 파일 이름 앞에 시각을 붙이면(예:{' '}
          <span className="mono">1710_한국사종료5분전.mp3</span>) 시간표의 같은 시각 줄에 자동으로 연결되고, 같은 시각 파일을 다시
          올리면 새 파일로 바뀝니다.
          {neisCode === 'LOCAL' && ' 로컬 모드에서는 이 PC에만 저장됩니다.'}
        </p>
        <div className="row upload-row">
          <input
            type="text"
            placeholder="음원 이름 (비우면 파일 이름)"
            value={uploadLabel}
            onChange={(e) => setUploadLabel(e.target.value)}
            disabled={disabled}
          />
          <label className={`button ${disabled ? 'disabled' : ''}`}>
            {busy?.startsWith('upload') ? `올리는 중… ${busy.split(':')[1] ?? ''}` : '＋ 음원 파일 올리기'}
            <input
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              multiple
              hidden
              disabled={disabled}
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])];
                e.target.value = '';
                if (fs.length) void upload(fs);
              }}
            />
          </label>
          <button
            onClick={() => setComposing(sortedDocs.map(([id]) => id).filter((id) => selected.has(id)))}
            disabled={disabled || audioBusy || composing !== null}
            title="목록에서 음원을 고르고 누르면 고른 음원에 타종을 붙입니다 (여러 개면 일괄)"
          >
            {selectedCount > 1
              ? `🔔 선택한 ${selectedCount}개에 타종 일괄 붙이기`
              : selectedCount === 1
                ? '🔔 선택한 음원에 타종 붙이기'
                : '🔔 타종 붙여 새 음원 만들기'}
          </button>
          {selectedCount > 0 && (
            <button
              onClick={() => applyToTimetable(sortedDocs.map(([id]) => id).filter((id) => selected.has(id)))}
              disabled={disabled || composing !== null}
              title="「원래 이름 (타종)」 음원은 원래 음원 자리에, 이름 앞에 시각이 있으면 같은 시각 줄에 연결합니다"
            >
              📋 선택한 {selectedCount}개 시간표에 적용
            </button>
          )}
          {selectedCount > 0 && (
            <button
              onClick={() => downloadSelected(sortedDocs.map(([id]) => id).filter((id) => selected.has(id)))}
              disabled={busy !== null || composing !== null}
              title="학교 방송 프로그램에 넣을 MP3 파일로 내려받습니다. 이름의 「(타종)」은 빼고 받습니다."
            >
              {busy?.startsWith('download') ? `내려받는 중… ${busy.split(':')[1] ?? ''}` : `⬇ 선택한 ${selectedCount}개 MP3로 받기`}
            </button>
          )}
        </div>
        {composing && !locked && !audioBusy && (
          <AudioComposer
            key={composing.join(',')}
            neisCode={neisCode}
            examId={target.examId}
            assets={[...builtinAssets, ...schoolAssets]}
            targets={composing}
            onClose={() => setComposing(null)}
            onSaved={(items, failed, removeOriginals) => void afterCompose(items, failed, removeOriginals)}
          />
        )}
        {docs.length > 0 && !assetsFolded && (
          <div className="asset-scroll">
          <table className="asset-list">
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    title="모두 선택"
                    checked={selectedCount === docs.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedCount > 0 && selectedCount < docs.length;
                    }}
                    disabled={disabled || composing !== null}
                    onChange={(e) => setSelected(e.target.checked ? new Set(docs.map(([id]) => id)) : new Set())}
                  />
                </th>
                <th colSpan={4} className="muted small">
                  {selectedCount ? `${selectedCount}개 선택 — 위 [🔔 타종 붙이기]를 누르세요` : '줄을 눌러 타종을 붙일 음원을 고르세요 (여러 개 가능)'}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map(([id, d]) => (
                  <tr
                    key={id}
                    className={`pickable ${selected.has(id) ? 'selected' : ''}`}
                    onClick={(e) => {
                      if (disabled || composing !== null || (e.target as HTMLElement).closest('button, input')) return;
                      toggleSelect(id);
                    }}
                  >
                    <td className="pick">
                      <input type="checkbox" checked={selected.has(id)} disabled={disabled || composing !== null} onChange={() => toggleSelect(id)} />
                    </td>
                    <td>
                      <strong>{d.label}</strong>
                      <div className="muted small">{d.fileName}</div>
                    </td>
                    <td className="mono">{formatDuration(d.durationMs / 1000)}</td>
                    <td className="muted small">{usage(id) ? `시간표 ${usage(id)}곳` : '사용 안 함'}</td>
                    <td className="actions">
                      <button onClick={() => void preview(id)} disabled={audioBusy}>
                        {previewId === id ? '■ 정지' : '▶ 듣기'}
                      </button>
                      <button
                        onClick={() => remove(id, d)}
                        disabled={disabled || inUse(id)}
                        title={inUse(id) ? '시간표에서 쓰는 음원은 삭제할 수 없습니다' : ''}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="card timetable-card">
        <div className="timetable-head">
          <h2>{target.title}</h2>
          <span className="muted small">{target.status}</span>
        </div>
        {locked && <div className="banner warn">자동 방송 중에는 시간표를 고칠 수 없습니다. 방송을 중지한 뒤 고치세요.</div>}
        {live && (
          <div className="banner warn">
            지금 이 시간표로 방송 중입니다. 아직 나가지 않은 방송만 고칠 수 있고, [저장]하면 바로 반영됩니다. 이미 나갔거나 나가는 중인 줄(회색)은 바뀌지 않습니다.
          </div>
        )}
        {!locked && othersArmed.length > 0 && (
          <div className="banner warn">
            이 채널은 다른 PC({othersArmed.join(', ')})에서 자동 방송 중입니다. 여기서 저장해도 그 PC의 진행 중인 방송에는 반영되지 않고,
            그 PC가 방송을 멈추면 반영됩니다.
          </div>
        )}
        {error && <div className="banner bad">{error}</div>}
        {notice && <div className="banner">{notice}</div>}
        {importNotes.length > 0 && (
          <div className="banner warn">
            엑셀에서 가져오며 확인할 내용:
            <ul>
              {importNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        {draft === null ? (
          <div className="edit-start">
            <p>{target.intro}</p>
            <div className="row">
              {template && (
                <button className="primary" onClick={startFromTemplate} disabled={disabled}>
                  평가원 시간표 복사해서 시작
                </button>
              )}
              <button onClick={startEmpty} disabled={disabled}>
                빈 시간표로 시작
              </button>
              {importButton()}
            </div>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="timeline edit-table">
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>교시</th>
                    <th>내용</th>
                    <th>종류</th>
                    <th>음원</th>
                    <th title="본령이 늦게 울리면 종료령까지 늦춰 시험 시간을 보장합니다">시험 시작·종료</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.map((c) => {
                    const disabled = disabledAll || rowLocked(c.id);
                    return (
                    <tr
                      key={c.id}
                      className={rowLocked(c.id) ? 'row-locked' : c.assetId ? '' : 'no-audio'}
                      title={rowLocked(c.id) ? '이미 나갔거나 나가는 중인 방송이라 고칠 수 없습니다' : undefined}
                    >
                      <td>
                        <TimeInput value={c.time} disabled={disabled} onChange={(v) => update(c.id, { time: normTime(v) })} />
                      </td>
                      <td>
                        <input
                          type="text"
                          list="edit-periods"
                          value={c.period}
                          disabled={disabled}
                          onChange={(e) => update(c.id, { period: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={c.label}
                          placeholder="예: 1교시 본령"
                          disabled={disabled}
                          onChange={(e) => update(c.id, { label: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          value={c.kind}
                          disabled={disabled}
                          onChange={(e) =>
                            update(c.id, {
                              kind: e.target.value as Cue['kind'],
                            })
                          }
                        >
                          <option value="ment">📢 안내</option>
                          <option value="bell">🔔 타종</option>
                        </select>
                      </td>
                      <td>
                        <div className="asset-pick">
                          <select value={c.assetId} disabled={disabled} onChange={(e) => update(c.id, { assetId: e.target.value })}>
                            <option value="">— 음원 선택 —</option>
                            {c.assetId && !assetIds.has(c.assetId) && <option value={c.assetId}>(삭제된 음원)</option>}
                            {schoolAssets.length > 0 && (
                              <optgroup label="학교 음원">
                                {schoolAssets.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.label}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {builtinAssets.length > 0 && (
                              <optgroup label="평가원 음원">
                                {builtinAssets.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.label}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                          <button
                            className="icon"
                            disabled={audioBusy || !c.assetId || !assetIds.has(c.assetId)}
                            onClick={() => void preview(c.assetId)}
                            title="미리 듣기"
                          >
                            {previewId === c.assetId ? '■' : '▶'}
                          </button>
                        </div>
                      </td>
                      <td className="flags">
                        <label>
                          <input
                            type="checkbox"
                            checked={!!c.examStart}
                            disabled={disabled}
                            onChange={(e) =>
                              update(c.id, {
                                examStart: e.target.checked || undefined,
                              })
                            }
                          />{' '}
                          시작
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={!!c.examEnd}
                            disabled={disabled}
                            onChange={(e) =>
                              update(c.id, {
                                examEnd: e.target.checked || undefined,
                              })
                            }
                          />{' '}
                          종료
                        </label>
                      </td>
                      <td>
                        <button
                          className="link danger-text"
                          disabled={disabled}
                          onClick={() => setDraft((d) => d && d.filter((x) => x.id !== c.id))}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                  {draft.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        아직 방송이 없습니다. [＋ 방송 추가]로 한 줄씩 넣거나 [📄 엑셀에서 가져오기]를 쓰세요.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <datalist id="edit-periods">
                {periods.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            {check && (check.errors.length > 0 || check.warnings.length > 0) && (
              <ul className="edit-issues">
                {/* 음원 없는 줄은 한 줄로 묶는다 (엑셀로 가져온 직후 수십 줄이 표를 밀어내지 않게). 표에서 빨간 줄로 보인다 */}
                {missingAudio.length > 0 && (
                  <li className={target.allowMissingAudio ? "warn" : "bad"}>
                    음원이 없는 방송 {missingAudio.length}곳 (표의 빨간 줄{target.allowMissingAudio ? " — 연결 전까지 송출되지 않음" : ""}): {missingAudio.map((c) => c.time.slice(0, 5)).join(', ')}
                  </li>
                )}
                {check.errors
                  .filter((e) => !/: 음원을 고르세요$/.test(e))
                  .map((e) => (
                    <li key={e} className="bad">
                      {e}
                    </li>
                  ))}
                {check.warnings.filter((w) => !/^음원이 없는 방송/.test(w)).map((w) => (
                  <li key={w} className="warn">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="row edit-actions">
              <button onClick={addRow} disabled={disabled}>
                ＋ 방송 추가
              </button>
              {importButton()}
              <span className="spacer" />
              {saved && target.revert && (
                <button className="link danger-text" onClick={revert} disabled={disabled}>
                  평가원 시간표로 되돌리기
                </button>
              )}
              <button
                onClick={() => {
                  setDraft(saved ? structuredClone(saved) : null);
                  setImportNotes([]);
                  setError(null);
                }}
                disabled={disabled || !dirty}
              >
                변경 취소
              </button>
              <button className="primary" onClick={() => void save()} disabled={disabled || !dirty || !!check?.errors.length}>
                {busy === 'save' ? '저장 중…' : '저장'}
              </button>
            </div>
            <p className="muted small">
              저장하면 시각순으로 정렬됩니다.{target.allowMissingAudio && ' 음원이 없는 줄도 저장할 수 있지만, 음원을 연결하기 전까지는 송출되지 않습니다.'} "시험 시작"(본령)이 늦게 울리면 다음 "시험 종료"(종료령)까지 같은 만큼 늦춰 시험 시간을
              보장합니다.
            </p>
          </>
        )}
      </section>
    </>
  );
}
