import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';

initializeApp();
const REGION = 'asia-northeast3';

/**
 * 서버 기준 시각. 모든 시험장의 방송 시각은 이 값에 맞춰진다.
 * 평소에는 0(비용 없음). 수능 주간(11/16~11/19)에는 MIN_INSTANCES=1 로 다시 배포해 콜드스타트를 없앤다.
 * 콜드스타트가 있어도 클라이언트는 RTT 최소 샘플을 쓰므로 정확도에는 영향이 없다.
 */
const MIN_INSTANCES = Number(process.env.MIN_INSTANCES ?? 0);
export const time = onRequest(
  { region: REGION, minInstances: MIN_INSTANCES, cors: true, memory: '128MiB' },
  (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ now: Date.now() });
  },
);

// ───────────────────────── 담당 교사 사용 승인 (관리자 전용) ─────────────────────────
// 담당 교사는 본인 구글 계정으로 로그인해 accessRequests/{uid} 에 사용 신청을 남긴다.
// 관리자가 승인하면 custom claim { role: 'school', schoolId } 가 붙고, 그때부터 그 학교 방송·보고 권한이 생긴다.
// 모든 승인·거절·회수·유형 변경은 auditLogs 에 남는다 (클라이언트는 쓸 수 없음).

const callOpts = { region: REGION, memory: '256MiB' };

function requireAdmin(req) {
  if (req.auth?.token?.role !== 'admin') throw new HttpsError('permission-denied', '관리자만 할 수 있습니다.');
  return { uid: req.auth.uid, email: req.auth.token.email ?? '' };
}

function str(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpsError('invalid-argument', `${name} 값이 없습니다.`);
  return v.trim();
}

async function audit(by, action, detail) {
  await getFirestore()
    .collection('auditLogs')
    .add({ at: FieldValue.serverTimestamp(), by: by.email, byUid: by.uid, action, ...detail });
}

export const approveAccess = onCall(callOpts, async (req) => {
  const by = requireAdmin(req);
  const uid = str(req.data?.uid, 'uid');
  const db = getFirestore();
  const reqRef = db.doc(`accessRequests/${uid}`);
  const snap = await reqRef.get();
  if (!snap.exists) throw new HttpsError('not-found', '사용 신청을 찾을 수 없습니다.');
  // 관리자가 학교를 바꿔 승인할 수 있다 (신청자가 잘못 고른 경우)
  const schoolId = req.data?.schoolId ? str(req.data.schoolId, 'schoolId') : snap.get('schoolId');
  const school = await db.doc(`schools/${schoolId}`).get();
  if (!school.exists) throw new HttpsError('failed-precondition', `등록되지 않은 학교입니다: ${schoolId}`);
  const user = await getAuth().getUser(uid);
  if (user.customClaims?.role === 'admin') throw new HttpsError('failed-precondition', '관리자 계정에는 학교 권한을 줄 수 없습니다.');
  await getAuth().setCustomUserClaims(uid, { role: 'school', schoolId });
  await reqRef.update({
    status: 'approved',
    schoolId,
    decidedAt: FieldValue.serverTimestamp(),
    decidedBy: by.email,
    reason: FieldValue.delete(),
  });
  await audit(by, 'approve', { uid, email: user.email ?? '', schoolId, schoolName: school.get('name') ?? '' });
  return { ok: true };
});

export const rejectAccess = onCall(callOpts, async (req) => {
  const by = requireAdmin(req);
  const uid = str(req.data?.uid, 'uid');
  const reason = typeof req.data?.reason === 'string' ? req.data.reason.slice(0, 200) : '';
  const ref = getFirestore().doc(`accessRequests/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '사용 신청을 찾을 수 없습니다.');
  if (snap.get('status') === 'approved') throw new HttpsError('failed-precondition', '이미 승인된 신청입니다. 권한 회수를 사용하세요.');
  await ref.update({ status: 'rejected', reason, decidedAt: FieldValue.serverTimestamp(), decidedBy: by.email });
  await audit(by, 'reject', { uid, email: snap.get('email') ?? '', schoolId: snap.get('schoolId') ?? '', reason });
  return { ok: true };
});

export const revokeAccess = onCall(callOpts, async (req) => {
  const by = requireAdmin(req);
  const uid = str(req.data?.uid, 'uid');
  const reason = typeof req.data?.reason === 'string' ? req.data.reason.slice(0, 200) : '';
  const user = await getAuth().getUser(uid);
  if (user.customClaims?.role === 'admin') throw new HttpsError('failed-precondition', '관리자 계정은 여기서 회수할 수 없습니다.');
  const schoolId = user.customClaims?.schoolId ?? '';
  await getAuth().setCustomUserClaims(uid, null);
  // 이미 열려 있는 세션도 1시간 안에(토큰 갱신 시) 끊긴다
  await getAuth().revokeRefreshTokens(uid);
  await getFirestore()
    .doc(`accessRequests/${uid}`)
    .set({ status: 'revoked', reason, decidedAt: FieldValue.serverTimestamp(), decidedBy: by.email }, { merge: true });
  await audit(by, 'revoke', { uid, email: user.email ?? '', schoolId, reason });
  return { ok: true };
});

const TYPES = [
  { no: 1, inquiry: 'split', end: 4 },
  { no: 2, inquiry: 'split', end: 5 },
  { no: 3, inquiry: 'split', end: 'mixed' },
  { no: 4, inquiry: 'mixed', end: 4 },
  { no: 5, inquiry: 'mixed', end: 5 },
  { no: 6, inquiry: 'mixed', end: 'mixed' },
];

/** 시험장 상황(4교시 탐구 시험실·종료 교시)을 바꾸고 main 채널 시간표를 그에 맞춘다. web/src/data/templates.ts 의 TYPES와 같아야 한다. */
export const setSchoolSituation = onCall(callOpts, async (req) => {
  const by = requireAdmin(req);
  const schoolId = str(req.data?.schoolId, 'schoolId');
  const { inquiry, end } = req.data ?? {};
  const type = TYPES.find((t) => t.inquiry === inquiry && t.end === end);
  if (!type) throw new HttpsError('invalid-argument', '시험장 상황 값이 올바르지 않습니다.');
  const db = getFirestore();
  const ref = db.doc(`schools/${schoolId}`);
  const before = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', '학교를 찾을 수 없습니다.');
    const channels = snap.get('channels') ?? [];
    const main = channels.find((c) => c.id === 'main');
    const prev = { inquiry: snap.get('inquiryRooms'), end: snap.get('endPeriod'), templateId: main?.templateId };
    tx.update(ref, {
      inquiryRooms: inquiry,
      endPeriod: end,
      channels: channels.map((c) => (c.id === 'main' ? { ...c, templateId: `csat-${type.no}` } : c)),
    });
    return prev;
  });
  await audit(by, 'situation', { schoolId, before, after: { inquiry, end, templateId: `csat-${type.no}` } });
  return { ok: true, templateId: `csat-${type.no}` };
});
