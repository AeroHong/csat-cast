# csat-cast — 수능 방송 자동 스케줄러

타종·안내 멘트 음원을 시간표에 맞춰 자동 송출하고, 시험장별 송출 상태를 교육지원청(admin)에서 실시간으로 확인한다.

## 구성
- `web/` — Vite + React PWA (플레이어 `/player`, 상태판 `/admin/status`)
  - `src/core/scheduler.ts` 큐 계산·놓친 큐 정책 (순수 로직, `npm test`)
  - `src/core/clock.ts` 서버 시각 동기화 (`/api/time`, NTP 방식)
  - `src/core/audio.ts` 음원 내려받기·확인, 송출 3분 전 디코딩(끝나면 해제)·정밀 예약 재생 (Web Audio)
  - `src/core/player.ts` 자동 방송 진행기 / `reporter.ts` 실시간 상태·재생 기록 보고
  - `src/data/templates.ts` 2027 수능 안내방송 시간표 6개 유형 (평가원 방송대본 2026-10-05 기준)
- `functions/` — `/api/time` (Firebase Functions, 서울 리전)
- `scripts/` — 평가원 음원 가져오기(import-audio)·Storage 업로드(upload-audio), 초기 데이터 등록(seed)
- `firestore.rules`, `database.rules.json`, `storage.rules`

## 로컬 실행
```
cd web
npm install
npm run dev        # http://localhost:5173 → "로컬 모드로 시작"
npm test
```
Firebase 설정(`web/.env`, `.env.example` 참고)이 없으면 서버 보고 없이 로컬 모드로만 동작한다.

## 시험장 유형 (안내방송 유형 1~6)
평가원 음원은 시험장 상황에 따라 6개 폴더로 나뉘며, 시간표 `csat-1`~`csat-6`이 폴더 번호와 같다.

| 유형 | 4교시 탐구 시험실 | 종료 교시 | 15:30 준비령 | 16:37 종료령 |
|---|---|---|---|---|
| 1 | 선택과목 구분 (혼합 시험실 없음) | 모두 4교시 | A | A |
| 2 | 선택과목 구분 | 모두 5교시 | A | B |
| 3 | 선택과목 구분 | 4·5교시 혼합 | A | C |
| 4 | 선택과목 혼합 시험실 있음 | 모두 4교시 | B | A |
| 5 | 선택과목 혼합 시험실 있음 | 모두 5교시 | B | B |
| 6 | 선택과목 혼합 시험실 있음 | 4·5교시 혼합 | B | C |

- 학교 계정: `seed/schools.csv`의 `inquiryRooms`(구분/혼합), `endPeriod`(4/5/혼합) 열로 유형이 정해진다.
- 로컬 모드: 로그인 화면에서 두 가지 상황을 고르면 유형이 정해진다.
- 13:10 영어 듣기평가 본령은 타종 없이 듣기평가 방송으로 이어지므로 이 앱은 송출하지 않는다.
- 16:05 종료령 파일에는 16:07 두 번째 본령(파일 120초 지점)이 함께 들어 있다. 이 큐는 늦어도 건너뛰지 않고 늦은 만큼 앞부분을 건너뛰어 재생하므로(`catchUp`, 본령 시작 5초 뒤까지 허용) 16:07 본령은 제시각에 나간다. 재생 중 새로고침해도 끊긴 지점부터 이어서 재생한다.
- 연장 시험실(1.5배/1.7배 등) 시간표는 대본에 없어 따로 등록해야 한다.

## 음원 (평가원 안내방송 음원)
음원은 공개 저장소·Hosting에 올리지 않고 **Firebase Storage**(`builtin/audio/`, 로그인한 시험장만 읽기)에서 받는다. 로컬 모드는 개발 PC의 `web/public/audio/builtin` 음원을 쓴다. 평가원 음원 폴더(`타종 타입/1. …` ~ `6. …`)를 저장소 루트에 두고:
```
node scripts/import-audio.ts        # 또는 node scripts/import-audio.ts <폴더 경로>
```
- 폴더 간 같은 파일의 내용 일치, 파일명 시각 = 시간표 시각, 폴더 N 구성 = 시간표 csat-N 을 검사하고, 하나라도 어긋나면 아무것도 바꾸지 않는다.
- 고유 음원 40개(약 115MB)를 `web/public/audio/builtin/<큐 id>.mp3`로 복사하고 `manifest.json`(커밋 대상)을 갱신한다.
- `set GOOGLE_APPLICATION_CREDENTIALS=service-account.json` 후 `node scripts/upload-audio.ts` → Storage에 업로드(바뀐 파일만, 버킷 CORS 설정 포함). Storage 규칙은 `firebase deploy --only storage`로 배포.
- Hosting 배포에서는 mp3를 제외한다(`firebase.json` ignore).
- 음원이 바뀌면 manifest의 해시로 학교 PC 캐시가 자동 갱신된다.
- 서비스 워커는 음원을 미리 캐시하지 않는다. 학교 플레이어가 자기 유형에 필요한 음원만 받아 자체 캐시에 저장한다.

## 배포
```
cd scripts && npm install && cd ..
cd functions && npm install && cd ..
cd web && npm run build && cd ..
firebase deploy
set GOOGLE_APPLICATION_CREDENTIALS=service-account.json
node scripts/seed.ts templates
node scripts/seed.ts schools seed/schools.csv
node scripts/seed.ts admin <관리자 이메일>
```
Functions(`minInstances: 1`) 사용으로 Blaze 요금제가 필요하다.

## 다른 PC에서 이어서 작업하기
git에 올라가지 않는 파일을 직접 복사해야 한다.
- `service-account.json` (프로젝트 루트) — 초기 데이터 등록용 비밀 키
- `web/.env` — Firebase 웹 설정 (`web/.env.example` 참고, 값은 Firebase 콘솔 → 프로젝트 설정)
- `타종 타입/` — 평가원 음원 폴더 → 복사 후 `node scripts/import-audio.ts`

```
cd web && npm install && npm test && npm run dev
npx firebase-tools login      # 배포할 때만
```
개발 서버에서 `http://localhost:5173/player?devArmed=1` → 오늘을 방송일로 가정하고 60배속으로 자동 방송을 시험할 수 있다.

## 작업 현황 (2026-10-28 기준)
완료
- 자동 방송 엔진(서버 시각 동기화, 정밀 예약 재생), 학교 플레이어, 관리자 실시간 상태판
- Firebase 배포: Hosting(https://csat-cast.web.app), Functions `/api/time`(서울), 보안 규칙, 시간표 초안 업로드, 관리자 권한, 테스트 학교 계정(9999999)
- 안정성 강화: 방송 중 앱 업데이트 금지, 방송일 자동 시작, 새로고침 후 이어하기(중복 송출 방지), 오디오 꺼짐·PC 절전 감시,
  같은 채널 이중 탭 차단, 스피커 확인, 오프라인 재시작 시 저장된 시각 사용, 잘못된 시간표 차단, 상태판 경고음, 전용 실행 아이콘(`web/public/launcher`)

남은 일
- [x] 새로고침 이어하기 브라우저 실측 확인 (2026-10-30, 전용 실행 아이콘과 같은 옵션의 크롬에서 큐 사이·재생 중·타종 직전 새로고침 모두 정상)
  - 함께 고침: 타종 직전(예약 상태) 새로고침 시 안 울렸는데 송출 완료 처리되던 문제, 소리 꺼짐 중 큐가 송출 완료로 기록되고 켜질 때 늦게 울리던 문제, 음원 캐시 저장 오류로 음원 전체가 준비 실패되던 문제
- [ ] 위 변경사항 Hosting 재배포 (`cd web && npm run build && cd .. && npx firebase-tools deploy --only hosting`)
- [x] 실제 mp3 교체, 2027 방송대본 기준 시간표 6개 유형 반영 (2026-10-30)
- [ ] 연장 시험실 시간표 등록 (시험장 시나리오·대본 확인 후 별도 작업)
- [x] `node scripts/seed.ts templates`로 csat-1~6 등록(초안 general-4/5 삭제), 테스트 학교 9999999 → csat-2, 음원 Storage 업로드 (2026-10-30)
- [ ] 시험장 목록 CSV로 학교 계정 일괄 생성
- [ ] 학교별 시간표 조정 화면(큐 끄기/켜기, 자체 mp3 업로드), 관리자 관리 화면, 학교×교시 송출 표
- [ ] 수능 주간 Functions `MIN_INSTANCES=1` 재배포
