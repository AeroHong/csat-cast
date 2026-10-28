/**
 * 초기 데이터 등록 (admin 전용, 서비스 계정 키 필요).
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=path\to\service-account.json
 *   node scripts/seed.ts templates                 # 기본 시간표·전역 설정 업로드
 *   node scripts/seed.ts schools seed/schools.csv  # 시험장 계정·프로필 일괄 생성
 *   node scripts/seed.ts admin someone@example.com # admin 권한 부여
 *
 * schools.csv 형식 (첫 줄 헤더, UTF-8):
 *   neisCode,name,venueType,lastPeriod,inquiryNote,extRooms,password
 *   7010000,○○고등학교,일반,5,과탐 위주,1.5x,초기비밀번호
 * extRooms: 연장 시험실 템플릿 접미사를 | 로 구분 (예: 1.5x|1.7x) → 채널 ext-1.5x 등 생성
 * password를 비워 두면 무작위 생성 후 결과 파일(seed/accounts-out.csv)에 기록한다.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { BUILTIN_TEMPLATES, DEFAULT_GLOBAL_CONFIG } from '../web/src/data/templates.ts';

initializeApp();
const auth = getAuth();
const db = getFirestore();
const [cmd, arg] = process.argv.slice(2);

async function seedTemplates() {
  const batch = db.batch();
  for (const t of BUILTIN_TEMPLATES) batch.set(db.doc(`templates/${t.id}`), t);
  batch.set(db.doc('config/global'), DEFAULT_GLOBAL_CONFIG);
  await batch.commit();
  console.log(`시간표 ${BUILTIN_TEMPLATES.length}개 + 전역 설정 등록 완료`);
}

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const keys = head.split(',').map((k) => k.trim());
  return lines.filter(Boolean).map((l) => {
    const vals = l.split(',');
    return Object.fromEntries(keys.map((k, i) => [k, (vals[i] ?? '').trim()]));
  });
}

async function seedSchools(path: string) {
  const out: string[] = ['neisCode,name,password'];
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const code = r.neisCode;
    if (!/^\d{7,10}$/.test(code)) {
      console.warn(`건너뜀 (학교코드 형식 오류): ${code}`);
      continue;
    }
    const email = `${code}@csat-cast.app`;
    const password = r.password || randomBytes(6).toString('base64url');
    try {
      await auth.getUserByEmail(email);
      if (r.password) await auth.updateUser((await auth.getUserByEmail(email)).uid, { password });
    } catch {
      await auth.createUser({ email, password, displayName: r.name });
    }
    const lastPeriod = r.lastPeriod === '4' ? 4 : 5;
    const ext = (r.extRooms ?? '').split('|').filter(Boolean);
    await db.doc(`schools/${code}`).set(
      {
        name: r.name,
        venueType: r.venueType ?? '',
        lastPeriod,
        inquiryNote: r.inquiryNote ?? '',
        channels: [
          { id: 'main', label: '전체 방송', templateId: `general-${lastPeriod}` },
          ...ext.map((x) => ({ id: `ext-${x}`, label: `연장 시험실 ${x}`, templateId: `ext-${x}` })),
        ],
      },
      { merge: true },
    );
    out.push(`${code},${r.name},${r.password ? '(지정값)' : password}`);
    console.log(`✓ ${code} ${r.name}`);
  }
  writeFileSync('seed/accounts-out.csv', '﻿' + out.join('\n') + '\n');
  console.log('계정 목록 → seed/accounts-out.csv (비밀번호 포함, 배부 후 삭제하세요)');
}

async function makeAdmin(email: string) {
  const u = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(u.uid, { role: 'admin' });
  console.log(`${email} 에 admin 권한 부여 (다시 로그인해야 적용)`);
}

if (cmd === 'templates') await seedTemplates();
else if (cmd === 'schools' && arg) await seedSchools(arg);
else if (cmd === 'admin' && arg) await makeAdmin(arg);
else console.log('사용법: node scripts/seed.ts templates | schools <csv> | admin <email>');
