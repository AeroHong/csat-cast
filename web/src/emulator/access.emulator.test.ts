/**
 * 권한 규칙·사용 승인 Functions 통합 시험 (Firebase 에뮬레이터 필요). 평소 `npm test`에서는 건너뛴다.
 *
 *   npx firebase-tools emulators:exec --only auth,firestore,database,functions --project demo-csat-cast "cd web && npx vitest run src/emulator"
 *
 * demo- 프로젝트라 실제 서버에는 아무것도 쓰지 않는다.
 */
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, ref, set } from 'firebase/database';
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc,
  terminate,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const env = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}) as Record<string, string | undefined>;
const ON = !!env.FIRESTORE_EMULATOR_HOST;
const PROJECT = env.GCLOUD_PROJECT ?? 'demo-csat-cast';
const HOST = '127.0.0.1';

function client(name: string) {
  const app = initializeApp(
    { projectId: PROJECT, apiKey: 'fake-key', databaseURL: `http://${HOST}:9000/?ns=${PROJECT}-default-rtdb` },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, 8080);
  const rtdb = getDatabase(app);
  connectDatabaseEmulator(rtdb, HOST, 9000);
  const fns = getFunctions(app, 'asia-northeast3');
  connectFunctionsEmulator(fns, HOST, 5001);
  return { app, auth, db, rtdb, fns, call: (n: string, data: unknown) => httpsCallable(fns, n)(data) };
}

/** 에뮬레이터 관리 API로 custom claim 설정 (관리자 계정 만들기용) */
async function setClaims(uid: string, claims: object) {
  const r = await fetch(`http://${HOST}:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) }),
  });
  if (!r.ok) throw new Error(await r.text());
}

/** 규칙에 막혔는가 (Firestore: permission-denied, RTDB: PERMISSION_DENIED) */
const denied = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x as { code?: string; message?: string },
  );
  expect(e, '허용되면 안 되는 요청이 허용됨').not.toBeNull();
  expect(`${e!.code} ${e!.message}`).toMatch(/permission[-_]denied/i);
};

describe.skipIf(!ON)('사용 신청·승인과 권한 규칙 (에뮬레이터)', () => {
  const apps: FirebaseApp[] = [];
  let admin: ReturnType<typeof client>;
  let teacher: ReturnType<typeof client>;
  let other: ReturnType<typeof client>;
  let tUid = '';
  const stamp = Date.now();

  beforeAll(async () => {
    admin = client('admin');
    teacher = client('teacher');
    other = client('other');
    apps.push(admin.app, teacher.app, other.app);
    const a = await createUserWithEmailAndPassword(admin.auth, `admin${stamp}@example.com`, 'pw123456');
    await setClaims(a.user.uid, { role: 'admin' });
    await a.user.getIdToken(true);
    // 학교 2곳 + 학교 목록
    for (const [id, name] of [
      ['d13-01', '경인고등학교'],
      ['d13-20', '선유고등학교'],
    ]) {
      await setDoc(doc(admin.db, 'schools', id), {
        name,
        inquiryRooms: 'split',
        endPeriod: 4,
        channels: [{ id: 'main', label: '전체 방송', templateId: 'csat-1' }],
      });
    }
    await setDoc(doc(admin.db, 'directory', 'schools'), { list: [{ id: 'd13-01', name: '경인고등학교', examNo: 1, special: false }] });
    await setDoc(doc(admin.db, 'templates', 'csat-1'), { id: 'csat-1', name: 't', description: '', verified: true, cues: [] });
    const t = await createUserWithEmailAndPassword(teacher.auth, `teacher${stamp}@example.com`, 'pw123456');
    tUid = t.user.uid;
    await createUserWithEmailAndPassword(other.auth, `other${stamp}@example.com`, 'pw123456');
  }, 30_000);

  afterAll(async () => {
    for (const x of [admin, teacher, other]) await terminate(x.db).catch(() => undefined);
    await Promise.all(apps.map((a) => deleteApp(a)));
  });

  it('승인 전: 학교 목록만 읽을 수 있고 시간표·학교 설정·상태 보고는 막힌다', async () => {
    expect((await getDoc(doc(teacher.db, 'directory', 'schools'))).exists()).toBe(true);
    await denied(getDoc(doc(teacher.db, 'templates', 'csat-1')));
    await denied(getDoc(doc(teacher.db, 'schools', 'd13-01')));
    await denied(set(ref(teacher.rtdb, 'status/d13-01/main'), { online: true }));
  });

  it('신청은 본인 문서에 대기 상태로만 만들 수 있다', async () => {
    const base = { uid: tUid, email: 'x', displayName: '', name: '홍길동', phone: '', schoolId: 'd13-01', neisCode: '', requestedAt: serverTimestamp() };
    await denied(setDoc(doc(teacher.db, 'accessRequests', tUid), { ...base, status: 'approved' }));
    await denied(setDoc(doc(teacher.db, 'accessRequests', 'someone-else'), { ...base, uid: 'someone-else', status: 'pending' }));
    await denied(setDoc(doc(teacher.db, 'accessRequests', tUid), { ...base, status: 'pending', role: 'admin' }));
    await setDoc(doc(teacher.db, 'accessRequests', tUid), { ...base, status: 'pending' });
    // 다른 사람은 남의 신청을 볼 수 없다
    await denied(getDoc(doc(other.db, 'accessRequests', tUid)));
  });

  it('승인·유형 변경 Functions는 관리자만 호출할 수 있다', async () => {
    await expect(teacher.call('approveAccess', { uid: tUid })).rejects.toThrow(/관리자/);
    await expect(other.call('setSchoolSituation', { schoolId: 'd13-01', inquiry: 'mixed', end: 5 })).rejects.toThrow(/관리자/);
  });

  it('관리자가 승인하면 그 학교 권한만 생긴다', async () => {
    await admin.call('approveAccess', { uid: tUid });
    await teacher.auth.currentUser!.getIdToken(true);
    expect((await teacher.auth.currentUser!.getIdTokenResult()).claims.schoolId).toBe('d13-01');
    expect((await getDoc(doc(teacher.db, 'accessRequests', tUid))).data()?.status).toBe('approved');

    // 자기 학교: 설정 읽기·상태 보고·접속 기록·송출 기록 가능
    expect((await getDoc(doc(teacher.db, 'schools', 'd13-01'))).exists()).toBe(true);
    expect((await getDoc(doc(teacher.db, 'templates', 'csat-1'))).exists()).toBe(true);
    await set(ref(teacher.rtdb, 'status/d13-01/main'), { online: true });
    await set(ref(teacher.rtdb, `presence/d13-01/main/dev1`), { uid: tUid, since: 1 });
    await addDoc(collection(teacher.db, 'playLogs'), { school: 'd13-01', channel: 'main', result: 'played' });

    // 다른 학교: 모두 막힘
    await denied(getDoc(doc(teacher.db, 'schools', 'd13-20')));
    await denied(set(ref(teacher.rtdb, 'status/d13-20/main'), { online: true }));
    await denied(set(ref(teacher.rtdb, `presence/d13-20/main/dev1`), { uid: tUid, since: 1 }));
    await denied(addDoc(collection(teacher.db, 'playLogs'), { school: 'd13-20', channel: 'main', result: 'played' }));
    // 접속 기록 형식이 틀리면 거부
    await expect(set(ref(teacher.rtdb, `presence/d13-01/main/dev2`), { foo: 1 })).rejects.toThrow();
    // 승인된 신청을 스스로 고칠 수 없다
    await denied(setDoc(doc(teacher.db, 'accessRequests', tUid), { uid: tUid, schoolId: 'd13-20', status: 'pending' }));
  });

  it('감사 기록은 Functions만 쓰고 관리자만 읽는다', async () => {
    await denied(addDoc(collection(teacher.db, 'auditLogs'), { action: 'approve' }));
    await denied(getDocs(collection(teacher.db, 'auditLogs')));
    const logs = (await getDocs(collection(admin.db, 'auditLogs'))).docs.map((d) => d.data());
    expect(logs.some((l) => l.action === 'approve' && l.uid === tUid && l.schoolId === 'd13-01')).toBe(true);
  });

  it('관리자가 시험장 유형을 바꾸면 main 채널 시간표가 바뀌고 기록이 남는다', async () => {
    const r = await admin.call('setSchoolSituation', { schoolId: 'd13-01', inquiry: 'mixed', end: 'mixed' });
    expect((r.data as { templateId: string }).templateId).toBe('csat-6');
    const s = (await getDoc(doc(admin.db, 'schools', 'd13-01'))).data()!;
    expect(s.channels[0].templateId).toBe('csat-6');
    expect(s.endPeriod).toBe('mixed');
    await expect(admin.call('setSchoolSituation', { schoolId: 'd13-01', inquiry: 'x', end: 4 })).rejects.toThrow(/올바르지/);
    // 학교는 시험장 상황을 직접 바꿀 수 없다 (channels만 수정 가능)
    await denied(setDoc(doc(teacher.db, 'schools', 'd13-01'), { endPeriod: 4 }, { merge: true }));
  });

  it('권한을 회수하면 학교 권한이 사라지고 다시 신청할 수 있다', async () => {
    await admin.call('revokeAccess', { uid: tUid, reason: '담당자 변경' });
    // 회수 후에는 토큰 갱신이 거부되므로 다시 로그인해야 한다 (열린 세션이 끊기는 것)
    await signInWithEmailAndPassword(teacher.auth, `teacher${stamp}@example.com`, 'pw123456');
    expect((await teacher.auth.currentUser!.getIdTokenResult(true)).claims.schoolId).toBeUndefined();
    await denied(getDoc(doc(teacher.db, 'schools', 'd13-01')));
    await denied(set(ref(teacher.rtdb, 'status/d13-01/main'), { online: true }));
    expect((await getDoc(doc(teacher.db, 'accessRequests', tUid))).data()?.status).toBe('revoked');
    await setDoc(doc(teacher.db, 'accessRequests', tUid), {
      uid: tUid,
      email: 'x',
      displayName: '',
      name: '홍길동',
      phone: '',
      schoolId: 'd13-01',
      neisCode: '',
      status: 'pending',
      requestedAt: serverTimestamp(),
    });
  });

  it('반려하면 사유가 남고, 관리자 계정에는 학교 권한을 줄 수 없다', async () => {
    await admin.call('rejectAccess', { uid: tUid, reason: '학교 확인 필요' });
    const d = (await getDoc(doc(teacher.db, 'accessRequests', tUid))).data()!;
    expect([d.status, d.reason]).toEqual(['rejected', '학교 확인 필요']);
    const adminUid = admin.auth.currentUser!.uid;
    await setDoc(doc(admin.db, 'accessRequests', adminUid), {
      uid: adminUid,
      email: '',
      displayName: '',
      name: 'a',
      phone: '',
      schoolId: 'd13-01',
      neisCode: '',
      status: 'pending',
      requestedAt: serverTimestamp(),
    });
    await expect(admin.call('approveAccess', { uid: adminUid })).rejects.toThrow(/관리자 계정/);
  });
});
