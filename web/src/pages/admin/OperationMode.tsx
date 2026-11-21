import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { fb } from '../../core/firebase';
import type { GlobalConfig } from '../../core/types';
import { shortDate } from '../RehearsalScheduler';

/**
 * 운영 모드: 수능 모드 켜기/끄기 (config/global.csatMode).
 * - 켜짐: 학교 PC가 평가원 시간표·음원을 받고, 지정 방송일(armedDates)에 자동 방송
 * - 꺼짐: 평가원 음원을 받지 않고 학교 시험 방송만 (수능이 끝난 뒤 ~ 다음 수능 준비 전)
 */
export default function OperationMode() {
  const [cfg, setCfg] = useState<Partial<GlobalConfig> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fb) return;
    return onSnapshot(
      doc(fb.db, 'config', 'global'),
      (d) => setCfg((d.data() as Partial<GlobalConfig> | undefined) ?? {}),
      (e) => setError(e.message),
    );
  }, []);

  const on = cfg?.csatMode === true;

  async function toggle() {
    if (!fb) return;
    const msg = on
      ? '수능 모드를 끌까요?\n\n학교 PC는 평가원 음원을 더 받지 않고, 지정 방송일 자동 방송도 하지 않습니다 (학교 시험 방송만 사용).'
      : '수능 모드를 켤까요?\n\n학교 PC가 평가원 시간표·음원을 받기 시작합니다. 먼저 새 음원을 Storage에 올리고(scripts/upload-audio.ts) 방송일(armedDates)을 확인하세요.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError(null);
    try {
      await setDoc(doc(fb.db, 'config', 'global'), { csatMode: !on }, { merge: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card narrow">
      <h2>운영 모드</h2>
      {cfg === null ? (
        <p className="muted">불러오는 중…</p>
      ) : (
        <>
          <p>
            수능 모드: <strong className={on ? 'error' : ''}>{on ? '켜짐' : '꺼짐'}</strong>
          </p>
          <p className="muted small">
            {on
              ? '학교 PC가 평가원 시간표·음원을 받고 지정 방송일에 자동 방송합니다.'
              : '학교 PC는 평가원 음원을 받지 않고, 학교가 만든 시험 방송만 씁니다. 내년 수능 준비를 시작할 때 켜세요.'}
          </p>
          {(cfg.armedDates?.length ?? 0) > 0 && (
            <p className="muted small">
              지정 방송일: {cfg.armedDates!.map((d) => `${shortDate(d.date)} ${d.label}`).join(', ')}
              {!on && ' (꺼져 있는 동안은 쓰지 않음)'}
            </p>
          )}
          <button className={on ? '' : 'primary'} disabled={busy} onClick={() => void toggle()}>
            {busy ? '바꾸는 중…' : on ? '수능 모드 끄기' : '수능 모드 켜기'}
          </button>
          {!on && (
            <p className="muted small">
              켜기 전에: ① 새 평가원 음원 준비(<span className="mono">node scripts/import-audio.ts</span>) ② Storage 업로드(
              <span className="mono">node scripts/upload-audio.ts</span>) ③ 시간표·방송일 등록(<span className="mono">seed.ts</span>) ④ Hosting
              배포
            </p>
          )}
        </>
      )}
      {error && <div className="banner bad">{error}</div>}
    </section>
  );
}
