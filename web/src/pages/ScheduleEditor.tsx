import { useEffect, useMemo, useState } from 'react';
import { audioEngine } from '../core/audio';
import { loadSchoolAssetDocs } from '../core/catalog';
import {
  checkSchedule,
  deleteSchoolAudio,
  saveChannel,
  toSchoolAsset,
  uploadSchoolAudio,
  type SchoolAssetDoc,
} from '../core/schoolSchedule';
import type { Asset, ChannelConfig, Cue, SchoolProfile, Template } from '../core/types';
import AudioComposer from './AudioComposer';
import { formatDuration } from './NowPlaying';

interface Props {
  neisCode: string;
  profile: SchoolProfile;
  channel: ChannelConfig;
  /** 이 채널에 지정된 평가원 유형 (복사해서 시작할 때 씀) */
  template: Template | undefined;
  assets: Asset[];
  /** 자동 방송 중에는 고칠 수 없다 */
  locked: boolean;
  onProfile: (p: SchoolProfile) => void;
  onAssets: (a: Asset[]) => void;
}

const newId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
export default function ScheduleEditor({ neisCode, profile, channel, template, assets, locked, onProfile, onAssets }: Props) {
  const saved = channel.customCues;
  const [draft, setDraft] = useState<Cue[] | null>(saved ? structuredClone(saved) : null);
  const [docs, setDocs] = useState<[string, SchoolAssetDoc][]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadLabel, setUploadLabel] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** 타종 붙여 새 음원 만들기 열림 */
  const [composing, setComposing] = useState(false);

  // 채널이 바뀌거나 저장된 시간표가 바뀌면 편집 내용을 다시 맞춘다
  useEffect(() => {
    setDraft(channel.customCues ? structuredClone(channel.customCues) : null);
  }, [channel.id, channel.customCues]);

  useEffect(() => {
    void loadSchoolAssetDocs(neisCode).then(setDocs);
  }, [neisCode]);

  const schoolAssets = assets.filter((a) => a.source !== 'builtin');
  const builtinAssets = assets.filter((a) => a.source === 'builtin');
  const assetIds = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const check = useMemo(() => (draft ? checkSchedule(draft, assetIds) : null), [draft, assetIds]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved ?? null);
  const periods = [...new Set((draft ?? []).map((c) => c.period).filter(Boolean))];
  /** 편집 중인 시간표에서 쓰는 곳 수 */
  const usage = (id: string) => (draft ?? saved ?? []).filter((c) => c.assetId === id).length;
  /** 저장된 시간표나 편집 중인 시간표 어디서든 쓰면 삭제할 수 없다 */
  const inUse = (id: string) => [...(draft ?? []), ...(saved ?? [])].some((c) => c.assetId === id);

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
      if (check?.warnings.length && !window.confirm(`확인이 필요합니다:\n\n${check.warnings.join('\n')}\n\n이대로 저장할까요?`)) return;
      const cues = [...draft].sort((a, b) => a.time.localeCompare(b.time)).map((c) => ({ ...c, official: false }));
      onProfile(await saveChannel(profile, channel.id, { customCues: cues }));
      setNotice('저장했습니다. 이제 이 시간표로 방송합니다.');
    });

  const revert = () => {
    if (!window.confirm('학교 시간표를 지우고 평가원 시간표로 되돌릴까요? 만든 시간표는 복구할 수 없습니다 (올린 음원은 남습니다).'))
      return;
    void run('revert', async () => {
      onProfile(await saveChannel(profile, channel.id, { customCues: undefined }));
      setDraft(null);
      setNotice('평가원 시간표로 되돌렸습니다.');
    });
  };

  const upload = (file: File) =>
    run('upload', async () => {
      const { asset, doc } = await uploadSchoolAudio(neisCode, file, uploadLabel);
      setDocs((ds) => [...ds.filter(([id]) => id !== asset.id), [asset.id, doc]]);
      onAssets([...assets.filter((a) => a.id !== asset.id), asset]);
      setUploadLabel('');
      setNotice(`"${doc.label}" 음원을 올렸습니다 (${formatDuration(doc.durationMs / 1000)}).`);
    });

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

  const disabled = locked || busy !== null;

  return (
    <>
      <section className="card">
        <h2>학교 음원</h2>
        <p className="muted small">
          직접 녹음·제작한 안내 방송을 올립니다 (mp3·wav, 20MB 이하). 올린 음원은 아래 시간표에서 고를 수 있습니다.
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
            {busy === 'upload' ? '올리는 중…' : '＋ 음원 파일 올리기'}
            <input
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              hidden
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
            />
          </label>
          <button onClick={() => setComposing(true)} disabled={disabled || composing}>
            🔔 타종 붙여 새 음원 만들기
          </button>
        </div>
        {composing && !locked && (
          <AudioComposer
            neisCode={neisCode}
            assets={assets}
            onClose={() => setComposing(false)}
            onSaved={(asset, doc) => {
              setDocs((ds) => [...ds.filter(([id]) => id !== asset.id), [asset.id, doc]]);
              onAssets([...assets.filter((a) => a.id !== asset.id), asset]);
              setComposing(false);
              setNotice(`"${doc.label}" 음원을 만들어 저장했습니다 (${formatDuration(doc.durationMs / 1000)}). 시간표에서 고를 수 있습니다.`);
            }}
          />
        )}
        {docs.length > 0 && (
          <table className="asset-list">
            <tbody>
              {[...docs]
                .sort((a, b) => a[1].label.localeCompare(b[1].label))
                .map(([id, d]) => (
                  <tr key={id}>
                    <td>
                      <strong>{d.label}</strong>
                      <div className="muted small">{d.fileName}</div>
                    </td>
                    <td className="mono">{formatDuration(d.durationMs / 1000)}</td>
                    <td className="muted small">{usage(id) ? `시간표 ${usage(id)}곳` : '사용 안 함'}</td>
                    <td className="actions">
                      <button onClick={() => void preview(id)} disabled={locked}>
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
        )}
      </section>

      <section className="card timetable-card">
        <div className="timetable-head">
          <h2>{saved ? '학교 시간표' : '시간표 편집'}</h2>
          <span className="muted small">
            {saved
              ? '이 시험장은 평가원 유형 대신 학교가 만든 시간표로 방송합니다.'
              : `지금은 평가원 시간표(${template?.name ?? '미지정'})로 방송합니다.`}
          </span>
        </div>
        {locked && <div className="banner warn">자동 방송 중에는 시간표를 고칠 수 없습니다. 방송을 중지한 뒤 고치세요.</div>}
        {error && <div className="banner bad">{error}</div>}
        {notice && <div className="banner">{notice}</div>}

        {draft === null ? (
          <div className="edit-start">
            <p>
              운영 시간이나 안내 내용이 평가원 시간표와 다른 시험장(경증 시각장애 시험장 등)은 시간표를 직접 만들어 방송할 수 있습니다.
              저장하기 전에는 방송에 반영되지 않습니다.
            </p>
            <div className="row">
              <button className="primary" onClick={startFromTemplate} disabled={disabled || !template}>
                평가원 시간표 복사해서 시작
              </button>
              <button onClick={startEmpty} disabled={disabled}>
                빈 시간표로 시작
              </button>
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
                  {draft.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="time"
                          step={1}
                          value={c.time}
                          disabled={disabled}
                          onChange={(e) => e.target.value && update(c.id, { time: normTime(e.target.value) })}
                        />
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
                            <optgroup label="평가원 음원">
                              {builtinAssets.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.label}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                          <button
                            className="icon"
                            disabled={locked || !c.assetId || !assetIds.has(c.assetId)}
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
                  ))}
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
                {check.errors.map((e) => (
                  <li key={e} className="bad">
                    {e}
                  </li>
                ))}
                {check.warnings.map((w) => (
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
              <span className="spacer" />
              {saved && (
                <button className="link danger-text" onClick={revert} disabled={disabled}>
                  평가원 시간표로 되돌리기
                </button>
              )}
              <button
                onClick={() => {
                  setDraft(saved ? structuredClone(saved) : null);
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
              저장하면 시각순으로 정렬됩니다. "시험 시작"(본령)이 늦게 울리면 다음 "시험 종료"(종료령)까지 같은 만큼 늦춰 시험 시간을
              보장합니다.
            </p>
          </>
        )}
      </section>
    </>
  );
}
