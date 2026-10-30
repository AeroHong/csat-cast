import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { BUILTIN_TEMPLATES, DEFAULT_GLOBAL_CONFIG, csatSituation, csatTemplateId } from '../data/templates';
import { fb } from './firebase';
import type { Asset, GlobalConfig, SchoolProfile, Template } from './types';
import { validateTemplate } from './validate';

/**
 * 시간표·음원·학교 설정을 불러온다.
 * Firestore(오프라인 캐시 포함) → 앱 내장 기본값 순으로 사용하므로 서버가 없어도 동작한다.
 */

const LOCAL_PROFILE_KEY = 'csat-cast:local-profile';

/**
 * 평가원 기본 음원 목록. 음원은 공개 저장소·Hosting에 두지 않고 Firebase Storage(builtin/audio/)에서
 * 로그인한 시험장만 받는다 (scripts/upload-audio.ts로 올림). 로컬 모드는 개발 PC의 web/public 음원을 쓴다.
 */
export async function loadBuiltinAssets(fromStorage: boolean): Promise<Asset[]> {
  const res = await fetch('/audio/builtin/manifest.json');
  const manifest = (await res.json()) as Record<string, { file: string; label?: string; sha256?: string }>;
  return Object.entries(manifest).map(([id, m]) => ({
    id,
    label: m.label ?? id,
    // 내용 해시를 붙여 음원이 바뀌면 캐시된 옛 음원 대신 새로 받게 한다
    url: `/audio/builtin/${m.file}${m.sha256 ? `?v=${m.sha256.slice(0, 12)}` : ''}`,
    storagePath: fromStorage ? `builtin/audio/${m.file}` : undefined,
    source: 'builtin' as const,
  }));
}

export async function loadTemplates(): Promise<Template[]> {
  const byId = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));
  if (fb) {
    try {
      const snap = await getDocs(collection(fb.db, 'templates'));
      snap.forEach((d) => {
        const t = { ...(d.data() as Template), id: d.id };
        const errors = validateTemplate(t);
        // 잘못된 시간표는 쓰지 않는다 (내장 기본값 유지)
        if (errors.length) console.error(`[csat-cast] 시간표 ${d.id} 오류로 무시:`, errors);
        else byId.set(d.id, t);
      });
    } catch {
      /* 내장 기본값 사용 */
    }
  }
  return [...byId.values()];
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  if (fb) {
    try {
      const d = await getDoc(doc(fb.db, 'config', 'global'));
      if (d.exists()) return { ...DEFAULT_GLOBAL_CONFIG, ...(d.data() as Partial<GlobalConfig>) };
    } catch {
      /* 내장 기본값 사용 */
    }
  }
  return DEFAULT_GLOBAL_CONFIG;
}

/** 시험장 상황을 모를 때의 기본 유형: 선택과목 구분 시험실 · 5교시로 종료 (유형 2) */
export const DEFAULT_TEMPLATE_ID = csatTemplateId('split', 5);

export function defaultProfile(neisCode: string, templateId = DEFAULT_TEMPLATE_ID): SchoolProfile {
  const situation = csatSituation(templateId);
  return {
    neisCode,
    name: neisCode === 'LOCAL' ? '로컬 실행' : neisCode,
    inquiryRooms: situation?.inquiry,
    endPeriod: situation?.end,
    channels: [{ id: 'main', label: '전체 방송', templateId }],
  };
}

export async function loadSchool(neisCode: string): Promise<SchoolProfile> {
  if (fb && neisCode !== 'LOCAL') {
    try {
      const d = await getDoc(doc(fb.db, 'schools', neisCode));
      if (d.exists()) return { ...defaultProfile(neisCode), ...(d.data() as Partial<SchoolProfile>), neisCode };
    } catch {
      /* 아래 기본값 */
    }
    return defaultProfile(neisCode);
  }
  return loadLocalProfile();
}

export async function loadSchoolAssets(neisCode: string): Promise<Asset[]> {
  if (!fb || neisCode === 'LOCAL') return [];
  try {
    const snap = await getDocs(collection(fb.db, 'schools', neisCode, 'assets'));
    return snap.docs.map((d) => ({ ...(d.data() as Asset), id: d.id }));
  } catch {
    return [];
  }
}

export function loadLocalProfile(): SchoolProfile {
  try {
    const raw = localStorage.getItem(LOCAL_PROFILE_KEY);
    if (raw) return JSON.parse(raw) as SchoolProfile;
  } catch {
    /* 저장소 사용 불가 */
  }
  return defaultProfile('LOCAL');
}

export function saveLocalProfile(p: SchoolProfile) {
  try {
    localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(p));
  } catch {
    /* 저장소 사용 불가 */
  }
}
