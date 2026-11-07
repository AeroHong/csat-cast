/**
 * 에뮬레이터 시연 데이터 (실제 서버에는 절대 쓰지 않는다 — demo- 프로젝트 전용).
 *
 * 1) 에뮬레이터:  npx firebase-tools emulators:start --only auth,firestore,database,functions --project demo-csat-cast
 * 2) 다른 창에서 (scripts 폴더):
 *      set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
 *      set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
 *      set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000
 *      set GCLOUD_PROJECT=demo-csat-cast
 *      node seed.ts templates && node seed.ts schools ../seed/schools.csv && node emulator-demo.ts
 * 3) web 폴더:  set VITE_USE_EMULATOR=1 && npx vite --port 5181
 *    → 관리자 admin@demo.kr / 교사 teacher@demo.kr (비밀번호 demo1234, 로그인 화면 '관리자·테스트 계정')
 *
 * 학교 PC 보고를 흉내 내 20곳의 상태를 테스트 방송으로 채운다: 대부분 정상 송출,
 * 한 곳은 건너뜀, 한 곳은 연결 끊김(송출 보고 없음), 한 곳은 PC 2대 중복 실행.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { cuesHash, toTimeline } from '../web/src/core/board.ts';
import { buildPlan, resolveCues, type CueState } from '../web/src/core/scheduler.ts';
import type { SchoolProfile } from '../web/src/core/types.ts';
import { BUILTIN_TEMPLATES } from '../web/src/data/templates.ts';

const PROJECT = process.env.GCLOUD_PROJECT ?? '';
if (!PROJECT.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('에뮬레이터(demo- 프로젝트) 전용입니다. 위 주석의 환경 변수를 설정하세요.');
  process.exit(1);
}

initializeApp({ projectId: PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${PROJECT}-default-rtdb` });
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase();

async function user(email: string, name: string, claims: object | null) {
  let u;
  try {
    u = await auth.getUserByEmail(email);
  } catch {
    u = await auth.createUser({ email, password: 'demo1234', displayName: name });
  }
  await auth.setCustomUserClaims(u.uid, claims);
  return u.uid;
}

await user('admin@demo.kr', '교육지원청 담당자', { role: 'admin' });
const teacher = await user('teacher@demo.kr', '시연 교사', null);
// 승인 대기 중인 신청 1건 (관리자 화면 [사용 신청]에서 승인해 볼 수 있음)
await db.doc(`accessRequests/${teacher}`).set({
  uid: teacher,
  email: 'teacher@demo.kr',
  displayName: '시연 교사',
  name: '시연 교사',
  phone: '010-0000-0000',
  schoolId: 'd13-01',
  neisCode: '',
  status: 'pending',
  requestedAt: new Date(),
});

// 테스트 방송: 시간표를 지금 기준으로 당겨 '오전 방송은 끝났고 오후 방송이 남은' 상황을 만든다
const schools = (await db.collection('schools').get()).docs.map((d) => ({ ...(d.data() as SchoolProfile), neisCode: d.id }));
const now = Date.now();
const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
let i = 0;
for (const s of schools) {
  const ch = s.channels.find((c) => c.id === 'main')!;
  const cues = resolveCues(BUILTIN_TEMPLATES.find((t) => t.id === ch.templateId), ch);
  if (!cues.length) continue;
  const base = buildPlan(cues, today);
  // 13:50(4교시 직전)이 지금이 되도록 이동
  const shift = now - base.find((p) => p.cue.time >= '13:50:00')!.at;
  const plan = base.map((p) => ({ ...p, at: p.at + shift }));
  const states: Record<string, CueState> = {};
  const started: Record<string, number> = {};
  for (const p of plan) {
    if (p.at > now) states[p.cue.id] = 'pending';
    else {
      states[p.cue.id] = 'done';
      started[p.cue.id] = p.at + Math.round(Math.random() * 80);
    }
  }
  const n = i++;
  const offline = n === 4; // 연결 끊김
  if (n === 7) states[plan.find((p) => p.at < now && p.cue.kind === 'ment')!.cue.id] = 'skipped';
  // 연결 끊긴 학교는 최근 2개 방송을 보고하지 못한 것으로
  if (offline) for (const p of plan.filter((x) => x.at < now).slice(-2)) states[p.cue.id] = 'pending';
  const timeline = toTimeline(plan, states, started, []);
  const v = Object.values(states);
  await rtdb.ref(`status/${s.neisCode}/main`).set({
    online: !offline,
    lastSeen: offline ? now - 5 * 60_000 : now,
    schoolName: s.name,
    channelLabel: ch.label,
    templateId: ch.templateId,
    mode: 'test',
    clockSynced: true,
    clockOffsetMs: Math.round(Math.random() * 40 - 20),
    osClockDriftMs: 0,
    cacheReady: true,
    missingAssets: 0,
    audioUnlocked: true,
    soundConfirmed: true,
    autoplayAllowed: true,
    alarms: [],
    armed: true,
    nextCue: null,
    lastCue: null,
    doneCount: v.filter((x) => x === 'done').length,
    failedCount: 0,
    skippedCount: v.filter((x) => x === 'skipped').length,
    appVersion: '0.3.0',
    operator: `${s.name.replace('고등학교', '고')} 담당`,
    deviceId: `demo-${n}`,
    planHash: cuesHash(cues),
    timeline,
    runDate: null,
  });
  const devices: Record<string, object> = { [`demo-${n}`]: { uid: 'demo', name: `${s.name} 방송실`, since: now - 3600_000, armed: true } };
  if (n === 10) devices['demo-x'] = { uid: 'demo2', name: '교무실 PC', since: now - 600_000, armed: false };
  if (!offline) await rtdb.ref(`presence/${s.neisCode}/main`).set(devices);
}
console.log(`시연 데이터: 계정 2개(admin@demo.kr, teacher@demo.kr / demo1234), 학교 ${i}곳 상태`);
process.exit(0);
