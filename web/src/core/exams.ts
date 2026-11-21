import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { fb } from './firebase';
import type { ArmedDate, Exam } from './types';

/**
 * 외부 시험 방송 저장소 (학력평가·모의평가 등).
 * - 서버: Firestore schools/{코드}/exams/{id}
 * - 로컬 모드: 이 PC의 localStorage
 */

const LOCAL_KEY = 'csat-cast:local-exams';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const newExamId = () => `x-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function loadLocal(): Exam[] {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]') as Exam[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLocal(list: Exam[]) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  // 같은 PC의 다른 탭·화면도 바로 알게
  window.dispatchEvent(new CustomEvent('csat-cast:local-exams'));
}

export const sortExams = (list: Exam[]) => [...list].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

/** 시험 목록을 구독한다 (다른 PC에서 고친 내용도 바로 들어온다). 구독 해제 함수를 돌려준다 */
export function subscribeExams(neisCode: string, cb: (list: Exam[]) => void): () => void {
  if (neisCode === 'LOCAL' || !fb) {
    const send = () => cb(sortExams(loadLocal()));
    send();
    const onStorage = (e: StorageEvent) => e.key === LOCAL_KEY && send();
    window.addEventListener('csat-cast:local-exams', send);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('csat-cast:local-exams', send);
      window.removeEventListener('storage', onStorage);
    };
  }
  return onSnapshot(
    collection(fb.db, 'schools', neisCode, 'exams'),
    (snap) => cb(sortExams(snap.docs.map((d) => ({ ...(d.data() as Exam), id: d.id })))),
    (e) => console.error('[csat-cast] 시험 목록을 불러오지 못함', e),
  );
}

export async function saveExam(neisCode: string, exam: Exam): Promise<Exam> {
  // Firestore는 undefined 값을 받지 않는다
  const clean = JSON.parse(JSON.stringify({ ...exam, updatedAt: Date.now() })) as Exam;
  if (neisCode === 'LOCAL' || !fb) {
    saveLocal([...loadLocal().filter((e) => e.id !== exam.id), clean]);
    return clean;
  }
  await setDoc(doc(fb.db, 'schools', neisCode, 'exams', exam.id), clean);
  return clean;
}

export async function deleteExam(neisCode: string, id: string) {
  if (neisCode === 'LOCAL' || !fb) return saveLocal(loadLocal().filter((e) => e.id !== id));
  await deleteDoc(doc(fb.db, 'schools', neisCode, 'exams', id));
}

/** 다른 날 같은 시험을 다시 치를 때: 시간표·음원은 그대로, 줄 id는 새로 (이어하기 기록이 섞이지 않게) */
export function copyExam(src: Exam, date: string, name = `${src.name} (복사)`): Exam {
  const stamp = Date.now().toString(36);
  return {
    ...structuredClone(src),
    id: newExamId(),
    name,
    date,
    cues: src.cues.map((c, i) => ({ ...c, id: `s-${stamp}${i.toString(36)}` })),
    updatedAt: Date.now(),
  };
}

/**
 * 시험 이름·날짜 검사. errors가 있으면 저장하지 않는다.
 * - 수능 방송일(교육지원청 지정 실전·공식 리허설)과 같은 날은 안 됨
 * - 같은 채널에 같은 날 시험은 하나만
 */
export function validateExam(
  exam: Pick<Exam, 'id' | 'name' | 'date' | 'channelId'>,
  ctx: { today: string; official: ArmedDate[]; existing: Exam[] },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!exam.name.trim()) errors.push('시험 이름을 적으세요');
  if (!DATE_RE.test(exam.date)) errors.push('날짜를 고르세요');
  else {
    if (exam.date < ctx.today) warnings.push('지난 날짜입니다 (자동 방송되지 않습니다)');
    const official = ctx.official.find((d) => d.date === exam.date);
    if (official)
      errors.push(`${exam.date}은 ${official.mode === 'live' ? '수능 실전 방송일' : '수능 공식 리허설일'}(${official.label})이라 시험 방송을 잡을 수 없습니다`);
    const dup = ctx.existing.find((e) => e.id !== exam.id && e.date === exam.date && e.channelId === exam.channelId);
    if (dup) errors.push(`그날은 이미 "${dup.name}" 시험 방송이 있습니다`);
  }
  return { errors, warnings };
}

/** 음원을 아직 고르지 않은 줄 수 */
export const missingAudioCount = (exam: Exam, assetIds: Set<string>) =>
  exam.cues.filter((c) => !c.assetId || !assetIds.has(c.assetId)).length;
