import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';
import { AUDIO_CACHE } from './audio';
import { saveLocalProfile } from './catalog';
import { fb } from './firebase';
import type { Asset, ChannelConfig, Cue, SchoolProfile } from './types';
import { TIME_RE, validateTemplate } from './validate';

/**
 * 학교 자체 시간표·음원 편집 (경증 시각장애 시험장처럼 평가원 음원·시간표가 맞지 않는 시험장용).
 * - 시간표: 채널 설정의 customCues (있으면 평가원 유형 대신 사용)
 * - 음원: Storage schools/{코드}/assets/ + Firestore schools/{코드}/assets/{id}
 * 로컬 모드는 이 PC(localStorage·브라우저 캐시)에만 저장한다.
 */

/** Storage 규칙과 같은 제한 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const LOCAL_ASSETS_KEY = 'csat-cast:local-assets';

export interface SchoolAssetDoc {
  label: string;
  fileName: string;
  storagePath: string;
  sha256: string;
  size: number;
  durationMs: number;
  contentType: string;
  uploadedAt: number;
}

/** 캐시 이름. 내용 해시를 붙여 같은 id로 다시 올려도 새 파일을 받게 한다 */
function cacheUrl(neisCode: string, id: string, sha256: string) {
  return neisCode === 'LOCAL' ? `/local-audio/${id}?v=${sha256.slice(0, 12)}` : `/school-audio/${neisCode}/${id}?v=${sha256.slice(0, 12)}`;
}

export function toSchoolAsset(neisCode: string, id: string, d: SchoolAssetDoc): Asset {
  return {
    id,
    label: d.label,
    url: cacheUrl(neisCode, id, d.sha256),
    storagePath: neisCode === 'LOCAL' ? undefined : d.storagePath,
    source: 'upload',
  };
}

export function loadLocalAssetDocs(): Record<string, SchoolAssetDoc> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ASSETS_KEY) ?? '{}') as Record<string, SchoolAssetDoc>;
  } catch {
    return {};
  }
}

function saveLocalAssetDocs(docs: Record<string, SchoolAssetDoc>) {
  localStorage.setItem(LOCAL_ASSETS_KEY, JSON.stringify(docs));
}

/** 올리기 전에 파일을 검사한다: 형식·크기, 실제로 재생 가능한지(디코딩), 길이, 내용 해시 */
export async function inspectAudioFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext !== 'mp3' && ext !== 'wav') throw new Error('mp3 또는 wav 파일만 올릴 수 있습니다');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
  const bytes = await file.arrayBuffer();
  let durationMs: number;
  try {
    const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0));
    durationMs = Math.round(buf.duration * 1000);
  } catch {
    throw new Error('재생할 수 없는 음원 파일입니다 (파일이 깨졌거나 형식이 다름)');
  }
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    bytes,
    ext,
    durationMs,
    sha256,
    contentType: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
  };
}

/** 음원 올리기. 같은 내용의 파일은 같은 id가 되어 중복 저장되지 않는다 */
export async function uploadSchoolAudio(neisCode: string, file: File, label: string): Promise<{ asset: Asset; doc: SchoolAssetDoc }> {
  const f = await inspectAudioFile(file);
  const id = `u-${f.sha256.slice(0, 12)}`;
  const d: SchoolAssetDoc = {
    label: label.trim() || file.name.replace(/\.[^.]+$/, ''),
    fileName: file.name,
    storagePath: `schools/${neisCode}/assets/${id}.${f.ext}`,
    sha256: f.sha256,
    size: file.size,
    durationMs: f.durationMs,
    contentType: f.contentType,
    uploadedAt: Date.now(),
  };
  const asset = toSchoolAsset(neisCode, id, d);
  if (neisCode === 'LOCAL') {
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(asset.url, new Response(f.bytes, { headers: { 'Content-Type': f.contentType } }));
    saveLocalAssetDocs({ ...loadLocalAssetDocs(), [id]: d });
  } else {
    if (!fb) throw new Error('서버 설정이 없습니다');
    await uploadBytes(ref(fb.storage, d.storagePath), f.bytes, {
      contentType: f.contentType,
    });
    await setDoc(doc(fb.db, 'schools', neisCode, 'assets', id), d);
  }
  return { asset, doc: d };
}

export async function deleteSchoolAudio(neisCode: string, id: string, d: SchoolAssetDoc) {
  if (neisCode === 'LOCAL') {
    const docs = loadLocalAssetDocs();
    delete docs[id];
    saveLocalAssetDocs(docs);
    await caches
      .open(AUDIO_CACHE)
      .then((c) => c.delete(cacheUrl(neisCode, id, d.sha256)))
      .catch(() => undefined);
    return;
  }
  if (!fb) throw new Error('서버 설정이 없습니다');
  await deleteDoc(doc(fb.db, 'schools', neisCode, 'assets', id));
  // 목록에서 지웠으면 성공으로 본다 (파일이 이미 없거나 권한 문제여도 방송에는 영향 없음)
  await deleteObject(ref(fb.storage, d.storagePath)).catch(() => undefined);
}

/** 채널 설정 저장 (학교 계정은 channels 필드만 고칠 수 있다). 바뀐 프로필을 돌려준다 */
export async function saveChannel(profile: SchoolProfile, channelId: string, patch: Partial<ChannelConfig>): Promise<SchoolProfile> {
  // Firestore는 undefined 값을 받지 않으므로 지운 항목(예: customCues: undefined)은 키째 뺀다
  const channels = JSON.parse(
    JSON.stringify(profile.channels.map((c) => (c.id === channelId ? { ...c, ...patch } : c))),
  ) as ChannelConfig[];
  const next = { ...profile, channels };
  if (profile.neisCode === 'LOCAL') saveLocalProfile(next);
  else {
    if (!fb) throw new Error('서버 설정이 없습니다');
    await updateDoc(doc(fb.db, 'schools', profile.neisCode), { channels });
  }
  return next;
}

/**
 * 학교 시간표 검사. errors가 있으면 저장하지 않는다. warnings는 확인만 요청한다.
 */
export function checkSchedule(cues: Cue[], assetIds: Set<string>): { errors: string[]; warnings: string[] } {
  if (cues.length === 0) return { errors: ['방송을 하나 이상 넣으세요'], warnings: [] };
  // 담당자가 알아보기 쉽게 "시각 내용" 단위로 알린다. 그 밖의 형식 오류(종류·설정값 등)는 공통 검사로 잡는다
  const errors = validateTemplate({ id: 'school', name: '학교 시간표', cues }).filter((e) => !/시각 형식|음원 지정/.test(e));
  const warnings: string[] = [];
  const sorted = [...cues].sort((a, b) => a.time.localeCompare(b.time));
  sorted.forEach((c, i) => {
    const name = `${c.time.slice(0, 8)} ${c.label || '(내용 없음)'}`;
    if (!TIME_RE.test(c.time)) errors.push(`${name}: 시각 형식 오류`);
    if (!c.label.trim()) errors.push(`${name}: 내용을 적으세요`);
    if (!c.assetId) errors.push(`${name}: 음원을 고르세요`);
    else if (!assetIds.has(c.assetId)) errors.push(`${name}: 고른 음원이 없습니다 (삭제됨)`);
    if (i > 0 && sorted[i - 1].time === c.time) warnings.push(`${c.time}에 방송이 둘 이상 겹칩니다`);
  });
  let open: Cue | null = null;
  for (const c of sorted) {
    if (c.examEnd) open = null;
    if (c.examStart) {
      if (open && !c.examEnd) warnings.push(`${open.time} 시험 시작 뒤 종료 없이 ${c.time}에 다시 시작합니다`);
      open = c;
    }
  }
  if (open) warnings.push(`${open.time} 시험 시작 뒤 종료(종료령)가 없습니다 — 늦게 시작해도 뒤 방송을 늦출 수 없습니다`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
