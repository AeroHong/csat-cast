/**
 * 수능이 끝난 뒤 평가원 기본 음원을 Firebase Storage(builtin/audio/)에서 지운다 (admin 전용, 서비스 계정 키 필요).
 * 원본은 이 PC의 web/public/audio/builtin 과 `타종 타입/`에 남아 있으므로 다음 수능 때 upload-audio.ts로 다시 올린다.
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=service-account.json
 *   node scripts/delete-builtin-audio.ts          # 지울 목록만 보여 준다
 *   node scripts/delete-builtin-audio.ts --yes    # 실제로 지운다
 *
 * 학교가 올린 음원(schools/{코드}/assets/)은 건드리지 않는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'builtin/audio/';
const yes = process.argv.includes('--yes');

function bucketFromEnv() {
  const env = join(ROOT, 'web/.env');
  if (!existsSync(env)) return undefined;
  return /^VITE_FIREBASE_STORAGE_BUCKET=(.+)$/m.exec(readFileSync(env, 'utf8'))?.[1].trim();
}

const name = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? bucketFromEnv();
if (!name) {
  console.error('버킷 이름을 인자로 주거나 web/.env 에 VITE_FIREBASE_STORAGE_BUCKET 을 설정하세요.');
  process.exit(1);
}

initializeApp();
const bucket = getStorage().bucket(name);
const [files] = await bucket.getFiles({ prefix: PREFIX });
const total = files.reduce((n, f) => n + Number(f.metadata.size ?? 0), 0);
console.log(`${name}/${PREFIX}: 파일 ${files.length}개, ${(total / 1024 / 1024).toFixed(1)}MB`);
for (const f of files) console.log(`  ${f.name}`);
if (!yes) {
  console.log('\n확인만 했습니다. 실제로 지우려면 --yes 를 붙이세요.');
  process.exit(0);
}
for (const f of files) await f.delete();
console.log(`\n${files.length}개 삭제 완료.`);
