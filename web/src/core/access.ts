import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { fb } from './firebase';
import type { EndPeriod, InquiryRooms } from './types';

/**
 * 담당 교사 사용 신청·승인.
 * 교사는 본인 구글 계정으로 로그인해 학교를 골라 신청하고(accessRequests/{uid}),
 * 관리자가 승인하면 Functions가 custom claim schoolId를 붙인다. 모든 결정은 auditLogs에 남는다.
 */

export interface DirectorySchool {
  id: string;
  name: string;
  examNo: number | null;
  /** 별도 운영 시험장 (경증 시각장애 1.5배 등) */
  special: boolean;
}

export type AccessStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface AccessRequest {
  uid: string;
  email: string;
  displayName: string;
  name: string;
  phone: string;
  schoolId: string;
  /** 나이스 학교코드 (지금은 확인하지 않음 — 추후 자동 승인용) */
  neisCode: string;
  status: AccessStatus;
  requestedAt?: { toMillis(): number } | null;
  decidedAt?: { toMillis(): number } | null;
  decidedBy?: string;
  reason?: string;
}

const DIRECTORY_CACHE = 'csat-cast:directory';

/** 사용 신청할 학교 목록. 마지막으로 받은 목록을 PC에 저장해 두고 서버가 안 되면 그것을 쓴다. */
export async function loadDirectory(): Promise<DirectorySchool[]> {
  if (fb) {
    try {
      const d = await getDoc(doc(fb.db, 'directory', 'schools'));
      const list = (d.data()?.list ?? []) as DirectorySchool[];
      if (list.length) {
        try {
          localStorage.setItem(DIRECTORY_CACHE, JSON.stringify(list));
        } catch {
          /* 저장소 사용 불가 */
        }
        return list;
      }
    } catch {
      /* 아래 저장본 */
    }
  }
  try {
    return JSON.parse(localStorage.getItem(DIRECTORY_CACHE) ?? '[]') as DirectorySchool[];
  } catch {
    return [];
  }
}

export function schoolLabel(s: Pick<DirectorySchool, 'name' | 'examNo'>) {
  return s.examNo ? `${String(s.examNo).padStart(2, '0')}. ${s.name}` : s.name;
}

/** 나이스 학교코드 형식 검사 (비워 두면 통과 — 지금은 확인하지 않는다) */
export function neisCodeError(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  return /^\d{7}$/.test(t) ? null : '나이스 학교코드는 숫자 7자리입니다.';
}

export function watchMyRequest(uid: string, cb: (r: AccessRequest | null) => void) {
  if (!fb) return () => undefined;
  return onSnapshot(
    doc(fb.db, 'accessRequests', uid),
    (s) => cb(s.exists() ? (s.data() as AccessRequest) : null),
    () => cb(null),
  );
}

export async function submitRequest(r: Pick<AccessRequest, 'uid' | 'email' | 'displayName' | 'name' | 'phone' | 'schoolId' | 'neisCode'>) {
  if (!fb) throw new Error('서버 연결이 필요합니다.');
  await setDoc(doc(fb.db, 'accessRequests', r.uid), { ...r, status: 'pending', requestedAt: serverTimestamp() });
}

function call<T>(name: string) {
  return async (data: T) => {
    if (!fb) throw new Error('서버 연결이 필요합니다.');
    try {
      await httpsCallable(fb.functions, name)(data);
    } catch (e) {
      throw new Error((e as Error).message || `${name} 실패`);
    }
  };
}

export const approveAccess = call<{ uid: string; schoolId?: string }>('approveAccess');
export const rejectAccess = call<{ uid: string; reason?: string }>('rejectAccess');
export const revokeAccess = call<{ uid: string; reason?: string }>('revokeAccess');
export const setSchoolSituation = call<{ schoolId: string; inquiry: InquiryRooms; end: EndPeriod }>('setSchoolSituation');
