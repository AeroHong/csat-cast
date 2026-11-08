/**
 * 초기 데이터 등록 (admin 전용, 서비스 계정 키 필요).
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=path\to\service-account.json
 *   node scripts/seed.ts templates                 # 기본 시간표·전역 설정 업로드
 *   node scripts/seed.ts schools seed/schools.csv  # 시험장 프로필 + 사용 신청용 학교 목록 등록
 *   node scripts/seed.ts admin someone@example.com # admin 권한 부여
 *
 * schools.csv 형식 (첫 줄 헤더, UTF-8):
 *   id,examNo,name,venueType,inquiryRooms,endPeriod,special,inquiryNote[,extRooms,password]
 *   d13-01,1,○○고등학교,일반,구분,4,,탐구 사
 * id: 학교 id. 나이스 학교코드(7~10자리) 또는 시험장 번호(d{지구}-{번호}, 예: d13-20). 헤더가 neisCode여도 된다.
 * inquiryRooms: 4교시 탐구 시험실 — 구분(1·2과목 선택자를 시험실별로 나눔) / 혼합(섞인 시험실 있음)
 * endPeriod: 시험장 종료 교시 — 4 / 5 / 혼합
 *   → 평가원 안내방송 유형 1~6(시간표 csat-1~6)이 정해진다. 값이 틀리면 그 학교는 건너뛴다.
 * special: 1이면 별도 운영 시험장(경증 시각장애 1.5배 등). 채널 1개, 학교 자체 시간표로 방송하고 관리자 화면에 따로 표시된다.
 * extRooms: 연장 시험실 템플릿 접미사를 | 로 구분 (예: 1.5x|1.7x) → 채널 ext-1.5x 등 생성
 *
 * 로그인: 담당 교사가 본인 구글 계정으로 로그인해 학교를 골라 사용 신청 → 관리자가 승인 (functions/index.js).
 * password 열이 있는 줄만 예전 방식의 학교 공용 계정({id}@csat-cast.app)을 만든다 (테스트 학교용).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import type { EndPeriod, InquiryRooms } from '../web/src/core/types.ts';
import { BUILTIN_TEMPLATES, DEFAULT_GLOBAL_CONFIG, csatTemplateId } from '../web/src/data/templates.ts';

/** 2027 대본 이전의 초안 시간표 (csat-1~6으로 대체됨) */
const LEGACY_TEMPLATE_IDS = ['general-4', 'general-5'];

initializeApp();
const auth = getAuth();
const db = getFirestore();
const [cmd, arg] = process.argv.slice(2);

async function seedTemplates() {
  const batch = db.batch();
  for (const t of BUILTIN_TEMPLATES) batch.set(db.doc(`templates/${t.id}`), t);
  for (const id of LEGACY_TEMPLATE_IDS) batch.delete(db.doc(`templates/${id}`));
  batch.set(db.doc('config/global'), DEFAULT_GLOBAL_CONFIG);
  await batch.commit();
  console.log(`시간표 ${BUILTIN_TEMPLATES.length}개 + 전역 설정 등록 완료 (초안 시간표 ${LEGACY_TEMPLATE_IDS.join(', ')} 삭제)`);
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
  const out: string[] = ['id,name,password'];
  const directory: { id: string; name: string; examNo: number | null; special: boolean }[] = [];
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const code = r.id || r.neisCode;
    if (!/^(\d{7,10}|d\d{2}-\d{2})$/.test(code ?? '')) {
      console.warn(`건너뜀 (학교 id 형식 오류): ${code}`);
      continue;
    }
    const inquiry = ({ 구분: 'split', 혼합: 'mixed' } as Record<string, InquiryRooms>)[r.inquiryRooms];
    const end = ({ '4': 4, '5': 5, 혼합: 'mixed' } as Record<string, EndPeriod>)[r.endPeriod];
    if (!inquiry || end === undefined) {
      console.warn(`건너뜀 (시험장 상황 오류: inquiryRooms=${r.inquiryRooms}, endPeriod=${r.endPeriod}): ${code} ${r.name}`);
      continue;
    }
    const special = r.special === '1';
    const examNo = r.examNo ? Number(r.examNo) : null;
    if (r.password) {
      const email = `${code}@csat-cast.app`;
      try {
        await auth.updateUser((await auth.getUserByEmail(email)).uid, { password: r.password });
      } catch {
        await auth.createUser({ email, password: r.password, displayName: r.name });
      }
      out.push(`${code},${r.name},(지정값)`);
    }
    const ext = (r.extRooms ?? '').split('|').filter(Boolean);
    // 학교가 직접 만든 시간표(customCues)와 관리자가 바꾼 시험장 상황은 다시 등록해도 지우지 않는다
    const prevDoc = (await db.doc(`schools/${code}`).get()).data();
    const prev = (prevDoc?.channels ?? []) as { id: string; customCues?: unknown }[];
    const keep = (id: string) => {
      const custom = prev.find((c) => c.id === id)?.customCues;
      return custom ? { customCues: custom } : {};
    };
    const inq = (prevDoc?.inquiryRooms as InquiryRooms | undefined) ?? inquiry;
    const fin = (prevDoc?.endPeriod as EndPeriod | undefined) ?? end;
    if (prevDoc && (inq !== inquiry || fin !== end)) console.log(`  (${r.name}: 관리자가 바꾼 시험장 상황 유지 — ${inq}/${fin})`);
    await db.doc(`schools/${code}`).set(
      {
        name: r.name,
        examNo,
        special,
        venueType: r.venueType ?? '',
        inquiryRooms: inq,
        endPeriod: fin,
        lastPeriod: FieldValue.delete(),
        inquiryNote: r.inquiryNote ?? '',
        channels: [
          {
            id: 'main',
            label: special ? `${r.venueType || '별도 시험장'} 방송` : '전체 방송',
            templateId: csatTemplateId(inq, fin),
            ...keep('main'),
          },
          ...ext.map((x) => ({ id: `ext-${x}`, label: `연장 시험실 ${x}`, templateId: `ext-${x}`, ...keep(`ext-${x}`) })),
        ],
      },
      { merge: true },
    );
    directory.push({ id: code, name: r.name, examNo, special });
    console.log(`✓ ${code} ${r.name}${special ? ' (별도 운영)' : ''}`);
  }
  directory.sort((a, b) => (a.examNo ?? 999) - (b.examNo ?? 999) || a.name.localeCompare(b.name, 'ko'));
  await db.doc('directory/schools').set({ list: directory, updatedAt: FieldValue.serverTimestamp() });
  console.log(`사용 신청용 학교 목록 ${directory.length}곳 → directory/schools`);
  if (out.length > 1) {
    writeFileSync('seed/accounts-out.csv', '﻿' + out.join('\n') + '\n');
    console.log('공용 계정 목록 → seed/accounts-out.csv');
  }
}

async function makeAdmin(email: string) {
  const u = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(u.uid, { role: 'admin' });
  console.log(`${email} 에 admin 권한 부여 (다시 로그인해야 적용)`);
}

/**
 * ID·비밀번호로 로그인하는 관리자 계정을 만들거나 비밀번호를 바꾼다.
 * 로그인 화면 '관리자·테스트 계정'에 ID만 입력하면 {id}@csat-cast.app 으로 로그인된다.
 */
async function makeAdminId(id: string, password: string | undefined) {
  if (!/^[a-z][a-z0-9._-]{2,29}$/i.test(id)) throw new Error('ID는 영문자로 시작하는 3~30자(영문·숫자·._-)로 정하세요.');
  if (/^\d{7,10}$/.test(id) || /^d\d+-\d+$/i.test(id)) throw new Error('학교 코드·시험장 번호와 같은 형식의 ID는 쓸 수 없습니다.');
  if (!password || password.length < 8) throw new Error('비밀번호는 8자 이상으로 정하세요.');
  const email = `${id.toLowerCase()}@csat-cast.app`;
  let uid: string;
  try {
    const u = await auth.getUserByEmail(email);
    if (u.customClaims?.schoolId) throw new Error(`${email} 은 학교 권한이 있는 계정이라 관리자로 바꿀 수 없습니다.`);
    await auth.updateUser(u.uid, { password, disabled: false });
    uid = u.uid;
    console.log(`${email} 비밀번호를 바꿨습니다.`);
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e;
    uid = (await auth.createUser({ email, password, displayName: `관리자 ${id}` })).uid;
    console.log(`${email} 계정을 만들었습니다.`);
  }
  await auth.setCustomUserClaims(uid, { role: 'admin' });
  console.log(`admin 권한 부여 — 로그인 화면 [관리자·테스트 계정]에서 ID '${id}'로 로그인`);
}

if (cmd === 'templates') await seedTemplates();
else if (cmd === 'schools' && arg) await seedSchools(arg);
else if (cmd === 'admin' && arg) await makeAdmin(arg);
else if (cmd === 'admin-id' && arg) await makeAdminId(arg, process.argv[4]);
else console.log('사용법: node scripts/seed.ts templates | schools <csv> | admin <email> | admin-id <id> <password>');
