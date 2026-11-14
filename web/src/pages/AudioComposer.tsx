import { useEffect, useRef, useState } from 'react';
import { computePeaks, fetchAssetBytes } from '../core/audio';
import { MIX_SAMPLE_RATE, clipGain, encodeWav, findSoundBounds, mixdown, planMix, renderMix, type MixBlock } from '../core/audioMix';
import { byLabel, downloadBlob, encodeMp3, nextDownload, safeFileName } from '../core/mp3';
import { MAX_UPLOAD_BYTES, uploadSchoolAudio, type SchoolAssetDoc } from '../core/schoolSchedule';
import type { Asset } from '../core/types';
import { formatDuration } from './NowPlaying';

interface Props {
  neisCode: string;
  assets: Asset[];
  /** 학교 음원 목록에서 고른 음원 id. 여러 개면 같은 타종 구성을 각각에 붙여 일괄 저장한다 */
  targets?: string[];
  /**
   * 저장한 음원들과 실패한 항목 (일괄 저장에서 일부만 실패할 수 있다).
   * removeOriginals: 담당자가 '저장 후 원본 삭제'를 골랐는지 (원본은 Saved.from)
   */
  onSaved: (saved: Saved[], failed: string[], removeOriginals: boolean) => void;
  onClose: () => void;
}

export interface Saved {
  asset: Asset;
  doc: SchoolAssetDoc;
  /** 타종을 붙인 원본 음원 id (목록에서 고른 음원) */
  from?: string;
}

/** target: 학교 음원 목록에서 고른 음원 자리 (일괄 만들기에서는 고른 음원마다 바뀐다) */
type Source = { type: 'asset'; id: string } | { type: 'file'; file: File } | { type: 'target' };
type RealSource = Exclude<Source, { type: 'target' }>;
interface Block {
  key: number;
  source: Source | null;
  gapAfterSec: number;
  /** 담당자가 정한 음량 (%) */
  volume: number;
}
interface Result {
  buffer: AudioBuffer;
  peaks: Float32Array;
  /** 블록별 [시작, 끝] (초) */
  spans: [number, number][];
  totalSec: number;
}

const DEFAULT_BELL = 'ref-bell-start';
let seq = 0;
const block = (source: Source | null): Block => ({ key: ++seq, source, gapAfterSec: 1, volume: 100 });

/**
 * 타종 + 멘트 이어 붙이기. 블록을 순서대로 놓고 간격만 정하면, 앞뒤 무음을 자르고 음량을 맞춰 한 파일로 만든다.
 * 결과는 학교 음원으로 저장되어 시간표에서 고를 수 있다.
 */
export default function AudioComposer({ neisCode, assets, targets: targetIds = [], onSaved, onClose }: Props) {
  const bells = assets.filter((a) => a.id.startsWith('ref-bell-'));
  const school = assets.filter((a) => a.source !== 'builtin').sort(byLabel);
  const [targets] = useState(() => targetIds.filter((id) => assets.some((a) => a.id === id)));
  const batch = targets.length > 1;
  const [blocks, setBlocks] = useState<Block[]>(() => [
    block(bells.some((b) => b.id === DEFAULT_BELL) ? { type: 'asset', id: DEFAULT_BELL } : null),
    block(targets.length ? { type: 'target' } : null),
  ]);
  /** 일괄 만들기에서 미리 듣기할 음원 */
  const [previewIdx, setPreviewIdx] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  /** 저장한 뒤 원본(고른 음원) 삭제 */
  const [removeOriginals, setRemoveOriginals] = useState(true);
  const [trim, setTrim] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [name, setName] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<'make' | 'save' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  /** 디코딩 결과 (음원 id 또는 내 PC 파일 기준) */
  const decoded = useRef(new Map<string | File, AudioBuffer>());
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const fileFor = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 블록·옵션이 바뀌면 이전 결과는 무효
  useEffect(() => {
    stop();
    setResult(null);
  }, [blocks, trim, normalize, previewIdx]);

  // 닫을 때 미리 듣기 정리
  useEffect(
    () => () => {
      stop();
      void ctxRef.current?.close();
    },
    [],
  );

  function stop() {
    try {
      srcRef.current?.stop();
    } catch {
      /* 이미 끝남 */
    }
    srcRef.current = null;
    setPlaying(false);
  }

  const patch = (key: number, p: Partial<Block>) => setBlocks((bs) => bs.map((b) => (b.key === key ? { ...b, ...p } : b)));
  const move = (i: number, d: -1 | 1) =>
    setBlocks((bs) => {
      const next = [...bs];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });

  const assetLabel = (id: string) => assets.find((a) => a.id === id)?.label ?? '(없는 음원)';
  const usesTarget = blocks.some((b) => b.source?.type === 'target');
  /** 일괄로 여러 개를 만드는지 (고른 음원이 여러 개이고 그 자리가 블록에 있을 때) */
  const many = batch && usesTarget;

  function sourceLabel(s: Source | null, target?: string) {
    if (!s) return '';
    if (s.type === 'file') return s.file.name;
    if (s.type === 'target') return target ? assetLabel(target) : '선택한 음원';
    return assetLabel(s.id);
  }

  /** 고른 음원 자리를 실제 음원으로 바꾼다 */
  function resolve(s: Source, target: string | undefined): RealSource {
    if (s.type !== 'target') return s;
    if (!target) throw new Error('선택한 음원이 없습니다');
    return { type: 'asset', id: target };
  }

  /** 이름: 고른 음원 자리가 있으면 「원래 이름 (타종)」, 없으면 블록 이름을 이어 붙인다 */
  const autoName = (target: string | undefined) =>
    usesTarget && target
      ? `${assetLabel(target)} (타종)`
      : blocks.map((b) => sourceLabel(b.source, target).replace(/^타종: /, '').replace(/\.[^.]+$/, '')).join(' + ');

  async function decode(s: RealSource): Promise<AudioBuffer> {
    const key = s.type === 'file' ? s.file : s.id;
    const hit = decoded.current.get(key);
    if (hit) return hit;
    const asset = s.type === 'asset' ? assets.find((a) => a.id === s.id) : undefined;
    if (s.type === 'asset' && !asset) throw new Error('고른 음원이 없습니다');
    const bytes = s.type === 'file' ? await s.file.arrayBuffer() : await fetchAssetBytes(asset!);
    try {
      const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0));
      decoded.current.set(key, buf);
      return buf;
    } catch {
      throw new Error(`재생할 수 없는 파일입니다: ${sourceLabel(s)}`);
    }
  }

  /** 블록대로 이어 붙인 결과 (target: 고른 음원 자리에 넣을 음원) */
  async function render(target: string | undefined): Promise<Result> {
    if (blocks.some((b) => !b.source)) throw new Error('모든 블록에 음원을 고르세요');
    const bufs = await Promise.all(blocks.map((b) => decode(resolve(b.source!, target))));
    const mix: MixBlock[] = bufs.map((buf, i) => {
      const mono = mixdown(buf);
      const { start, end } = trim ? findSoundBounds(mono, buf.sampleRate) : { start: 0, end: mono.length };
      const auto = normalize ? clipGain(mono.subarray(start, end)) : 1;
      return { startSec: start / buf.sampleRate, endSec: end / buf.sampleRate, gain: (auto * blocks[i].volume) / 100, gapAfterSec: blocks[i].gapAfterSec };
    });
    const { placements, totalSec } = planMix(mix);
    if (44 + Math.ceil(totalSec * MIX_SAMPLE_RATE) * 2 > MAX_UPLOAD_BYTES)
      throw new Error(`합친 결과가 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB를 넘습니다 (약 5분 이하로 줄이세요)`);
    const buffer = await renderMix(bufs, placements, totalSec);
    return { buffer, peaks: computePeaks(buffer, 800), spans: placements.map((p) => [p.atSec, p.atSec + p.durationSec]), totalSec };
  }

  async function make() {
    setBusy('make');
    setError(null);
    try {
      const target = targets[many ? previewIdx : 0];
      setResult(await render(target));
      if (!name && !many) setName(autoName(target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function play() {
    if (playing) return stop();
    if (!result) return;
    const ctx = (ctxRef.current ??= new AudioContext());
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = result.buffer;
    src.connect(ctx.destination);
    src.onended = () => srcRef.current === src && stop();
    src.start();
    srcRef.current = src;
    setPlaying(true);
  }

  const upload = (buffer: AudioBuffer, label: string) =>
    uploadSchoolAudio(neisCode, new File([encodeWav(buffer.getChannelData(0), MIX_SAMPLE_RATE)], `${label}.wav`, { type: 'audio/wav' }), label);

  async function save() {
    if (!result) return;
    setBusy('save');
    setError(null);
    stop();
    try {
      if (!many) {
        const from = usesTarget ? targets[0] : undefined;
        onSaved([{ ...(await upload(result.buffer, name.trim() || '타종 + 멘트')), from }], [], removeOriginals && !!from);
        return;
      }
      // 일괄: 고른 음원마다 같은 구성으로 만들어 하나씩 저장한다
      const saved: Saved[] = [];
      const failed: string[] = [];
      for (const [i, t] of targets.entries()) {
        setProgress(`${i + 1}/${targets.length}`);
        try {
          const r = i === previewIdx ? result : await render(t);
          saved.push({ ...(await upload(r.buffer, autoName(t))), from: t });
        } catch (e) {
          failed.push(`${assetLabel(t)}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          // 고른 원본은 한 번씩만 쓰므로 디코딩 결과를 바로 내려 메모리를 아낀다
          decoded.current.delete(t);
        }
      }
      onSaved(saved, failed, removeOriginals);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }

  /** 내려받을 파일 이름: 학교 방송 프로그램에서 원래 파일 이름 그대로 쓰도록 「(타종)」은 뺀다 */
  const downloadName = (label: string) => `${safeFileName(label.replace(/\s*\(타종\)$/, ''))}.mp3`;

  /** 만든 결과를 MP3로 내려받기 (학교 방송 프로그램용). 일괄이면 고른 음원마다 하나씩 */
  async function download() {
    if (!result) return;
    setBusy('download');
    setError(null);
    stop();
    try {
      if (!many) {
        downloadBlob(await encodeMp3(result.buffer.getChannelData(0), MIX_SAMPLE_RATE), downloadName(name.trim() || autoName(targets[0])));
        return;
      }
      const failed: string[] = [];
      for (const [i, t] of targets.entries()) {
        setProgress(`${i + 1}/${targets.length}`);
        try {
          const r = i === previewIdx ? result : await render(t);
          downloadBlob(await encodeMp3(r.buffer.getChannelData(0), MIX_SAMPLE_RATE), downloadName(autoName(t)));
          await nextDownload();
        } catch (e) {
          failed.push(`${assetLabel(t)}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (i !== previewIdx) decoded.current.delete(t);
        }
      }
      if (failed.length) setError(`내려받지 못한 음원: ${failed.join(', ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="composer">
      <div className="composer-head">
        <strong>{batch ? `선택한 음원 ${targets.length}개에 타종 붙이기` : '타종 붙여 새 음원 만들기'}</strong>
        <button className="link" onClick={onClose}>
          닫기
        </button>
      </div>
      <p className="muted small">
        클로바더빙 등으로 만든 멘트 파일 앞뒤에 타종을 붙입니다. 순서대로 이어 붙이고, 블록 사이 간격만 정하면 됩니다.
        {batch && ' 📌 자리에 선택한 음원이 하나씩 들어가, 같은 구성으로 각각 새 음원이 만들어집니다 (원본은 그대로 남습니다).'}
      </p>
      {batch && (
        <ul className="composer-targets small">
          {targets.map((t) => (
            <li key={t}>{assetLabel(t)}</li>
          ))}
        </ul>
      )}

      <ol className="composer-blocks">
        {blocks.map((b, i) => (
          <li key={b.key}>
            <span className="composer-no">{i + 1}</span>
            <select
              value={b.source?.type === 'asset' ? b.source.id : b.source?.type === 'target' ? '__target' : b.source ? '__file' : ''}
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__pick') {
                  fileFor.current = b.key;
                  fileInput.current?.click();
                } else if (v === '__target') patch(b.key, { source: { type: 'target' } });
                else patch(b.key, { source: v ? { type: 'asset', id: v } : null });
              }}
            >
              <option value="">— 음원 선택 —</option>
              {targets.length > 0 && (
                <option value="__target">📌 {batch ? `선택한 음원 ${targets.length}개 (각각)` : `선택한 음원: ${assetLabel(targets[0])}`}</option>
              )}
              {b.source?.type === 'file' && <option value="__file">📁 {b.source.file.name}</option>}
              <option value="__pick">📁 내 PC 파일 고르기…</option>
              <optgroup label="타종 (평가원 참고 타종)">
                {bells.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </optgroup>
              {school.length > 0 && (
                <optgroup label="학교 음원">
                  {school.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <label className="inline">
              음량
              <select value={b.volume} disabled={disabled} onChange={(e) => patch(b.key, { volume: Number(e.target.value) })}>
                {[50, 70, 85, 100, 120, 150].map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
              </select>
            </label>
            {i < blocks.length - 1 && (
              <label className="inline">
                뒤 간격
                <input
                  type="number"
                  min={0}
                  max={60}
                  step={0.5}
                  value={b.gapAfterSec}
                  disabled={disabled}
                  onChange={(e) => patch(b.key, { gapAfterSec: Math.max(0, Number(e.target.value) || 0) })}
                />
                초
              </label>
            )}
            <span className="spacer" />
            <button className="icon" disabled={disabled || i === 0} onClick={() => move(i, -1)} title="위로">
              ▲
            </button>
            <button className="icon" disabled={disabled || i === blocks.length - 1} onClick={() => move(i, 1)} title="아래로">
              ▼
            </button>
            <button className="link danger-text" disabled={disabled || blocks.length <= 1} onClick={() => setBlocks((bs) => bs.filter((x) => x.key !== b.key))}>
              삭제
            </button>
          </li>
        ))}
      </ol>
      <input
        ref={fileInput}
        type="file"
        accept=".mp3,.wav,audio/mpeg,audio/wav"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && fileFor.current !== null) patch(fileFor.current, { source: { type: 'file', file: f } });
        }}
      />

      <div className="row">
        <button onClick={() => setBlocks((bs) => [...bs, block(null)])} disabled={disabled}>
          ＋ 블록 추가
        </button>
        <label className="inline">
          <input type="checkbox" checked={trim} disabled={disabled} onChange={(e) => setTrim(e.target.checked)} /> 앞뒤 무음 자르기
        </label>
        <label className="inline">
          <input type="checkbox" checked={normalize} disabled={disabled} onChange={(e) => setNormalize(e.target.checked)} /> 음량 자동 맞추기
        </label>
        <span className="spacer" />
        {many && (
          <label className="inline">
            미리 들을 음원
            <select value={previewIdx} disabled={disabled} onChange={(e) => setPreviewIdx(Number(e.target.value))}>
              {targets.map((t, i) => (
                <option key={t} value={i}>
                  {assetLabel(t)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary" onClick={() => void make()} disabled={disabled}>
          {busy === 'make' ? '만드는 중…' : '미리 만들기'}
        </button>
      </div>

      {error && <div className="banner bad">{error}</div>}

      {result && (
        <div className="composer-result">
          <MixWaveform result={result} />
          <div className="row">
            <button onClick={() => void play()} disabled={disabled}>
              {playing ? '■ 정지' : '▶ 듣기'}
            </button>
            <span className="mono">전체 {formatDuration(result.totalSec)}</span>
            <span className="spacer" />
            {many ? (
              <span className="muted small">각각 「원래 이름 (타종)」으로 저장됩니다</span>
            ) : (
              <input type="text" className="composer-name" placeholder="음원 이름" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
            )}
            {usesTarget && (
              <label className="inline" title="시간표에서 원본을 쓰던 자리는 새 음원으로 바꿉니다">
                <input type="checkbox" checked={removeOriginals} disabled={disabled} onChange={(e) => setRemoveOriginals(e.target.checked)} /> 저장 후 원본 삭제
              </label>
            )}
            <button onClick={() => void download()} disabled={disabled} title="학교 방송 프로그램에 넣을 MP3 파일로 내려받습니다 (저장과 별개)">
              {busy === 'download' ? `내려받는 중… ${progress ?? ''}` : many ? `⬇ ${targets.length}개 모두 MP3로 받기` : '⬇ MP3 내려받기'}
            </button>
            <button className="primary" onClick={() => void save()} disabled={disabled}>
              {busy === 'save' ? `저장 중… ${progress ?? ''}` : many ? `${targets.length}개 모두 만들어 저장` : '학교 음원으로 저장'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 합친 결과 파형. 블록 구간을 번갈아 색칠하고 번호를 붙인다 */
function MixWaveform({ result }: { result: Result }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(c);
    g.clearRect(0, 0, w, h);
    result.spans.forEach(([a, b], i) => {
      g.fillStyle = i % 2 ? 'rgba(217,119,6,0.12)' : 'rgba(29,78,216,0.10)';
      g.fillRect((a / result.totalSec) * w, 0, ((b - a) / result.totalSec) * w, h);
      g.fillStyle = css.color;
      g.font = `${11 * dpr}px sans-serif`;
      g.fillText(String(i + 1), (a / result.totalSec) * w + 4 * dpr, 13 * dpr);
    });
    g.fillStyle = css.getPropertyValue('--primary') || '#1d4ed8';
    const n = result.peaks.length;
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, result.peaks[i]) * (h / 2 - 2);
      g.fillRect((i / n) * w, h / 2 - v, Math.max(1, w / n - 0.5), v * 2);
    }
  }, [result]);
  return <canvas ref={ref} className="composer-wave" />;
}
