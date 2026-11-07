# csat-cast — 수능 방송 자동 스케줄러

타종·안내 멘트 음원을 시간표에 맞춰 자동 송출하고, 시험장별 송출 상태를 교육지원청(admin)에서 실시간으로 확인한다.

## 구성
- `web/` — Vite + React PWA (플레이어 `/player`, 상태판 `/admin/status`)
  - `src/core/scheduler.ts` 큐 계산·놓친 큐 정책 (순수 로직, `npm test`)
  - `src/core/clock.ts` 서버 시각 동기화 (`/api/time`, NTP 방식)
  - `src/core/audio.ts` 음원 내려받기·확인, 송출 3분 전 디코딩(끝나면 해제)·정밀 예약 재생 (Web Audio)
  - `src/core/player.ts` 자동 방송 진행기 / `reporter.ts` 실시간 상태·재생 기록 보고
  - `src/data/templates.ts` 2027 수능 안내방송 시간표 6개 유형 (평가원 방송대본 2026-10-05 기준)
  - `src/core/board.ts` 관리자 송출 현황판 판정 (학교 × 방송 칸 상태, 시간표 지문, 중복 PC) / `access.ts` 사용 신청·승인 / `presence.ts` 접속 PC
- `functions/` — `/api/time`, 사용 승인 `approveAccess`·`rejectAccess`·`revokeAccess`, 시험장 유형 변경 `setSchoolSituation` (Firebase Functions, 서울 리전)
- `scripts/` — 평가원 음원 가져오기(import-audio)·Storage 업로드(upload-audio), 초기 데이터 등록(seed)
- `firestore.rules`, `database.rules.json`, `storage.rules`

## 로그인 (2027 시범 운영: 제13시험지구)
- **담당 교사**: [Google 계정으로 로그인] → 처음 한 번 학교를 골라 사용 신청 → 교육지원청 관리자가 승인하면 자동으로 방송 화면이 열린다. 이후 그 PC(전용 실행 아이콘 프로필)에서는 로그인이 유지된다.
  - 승인 = Functions가 custom claim `{ role: 'school', schoolId }`을 붙임. 보안 규칙은 이 claim으로 자기 학교만 허용한다.
  - 학교 공용 비밀번호가 없다. 담당자가 바뀌면 관리자가 [권한 회수] (claim 제거 + 세션 토큰 폐기, 열린 화면은 1시간 안에 끊김).
  - 자동 방송 중 로그인이 끊겨도 방송 화면은 닫히지 않고 그대로 송출한다 (서버 보고만 중단, 화면에 경고).
  - 신청서의 나이스 학교코드 칸은 형식만 검사한다 (추후 자동 확인용).
- **관리자**: `node scripts/seed.ts admin <이메일>`로 role=admin을 준 계정. Google 또는 '관리자·테스트 계정'(이메일·비밀번호)으로 로그인.
- **테스트 학교 9999999**: 예전 방식의 공용 계정(`9999999@csat-cast.app`)도 계속 쓸 수 있다.
- 학교 id: 나이스 코드를 모르는 시험장은 `d{지구}-{시험장 번호}`(예: 선유고 `d13-20`).
- 처음 배포할 때 Firebase 콘솔 → Authentication → 로그인 방법에서 **Google**을 사용 설정해야 한다 (승인된 도메인: `csat-cast.web.app`, `localhost`).

## 관리자 화면 (`/admin/status`)
- **송출 현황**: 일반 시험장 학교 × 방송 시각 표. 칸마다 송출(오차)·수동·건너뜀·실패·**송출 보고 없음**(시각 15초 경과)·연결 끊김을 표시하고, 전체 다음 방송·카운트다운과 학교별 다음 방송을 보여 준다.
  - **별도 운영 시험장**(`special`, 선유고 경증 시각장애 1.5배)은 표 위 별도 영역에 세로 타임라인으로 표시. 자체 시간표가 없으면 '1.5배 시간표 미등록' 경고.
  - 빨강 판정: 연결 끊김, 소리 꺼짐, 재생 실패, 송출 보고 없음, **PC 시간표가 서버 설정과 다름**(시간표 지문 비교), **같은 채널을 PC 2대 이상이 열어 둠**(이중 송출 위험), 1.5배 시간표 미등록.
  - 이 화면은 관찰만 한다. 닫히거나 끊겨도 학교 방송에는 영향이 없다.
- **사용 신청·학교 관리**: 신청 승인(학교를 바꿔 승인 가능)·반려, 승인된 교사 권한 회수, 학교별 시험장 유형(4교시 탐구 구분/혼합 × 종료 4/5/혼합) 변경(자동 방송 중에는 불가), 시간표 미리 보기, 감사 기록.
- **송출 기록**: 날짜·실전/테스트별 `playLogs`, 실패·건너뜀 먼저, CSV 내려받기 (기록은 수정·삭제 불가).

## 에뮬레이터로 시험하기 (실제 서버에 쓰지 않음)
```
# 권한 규칙·승인 Functions 통합 시험
npx firebase-tools emulators:exec --only auth,firestore,database,functions --project demo-csat-cast "cd web && npx vitest run src/emulator"

# 연수 시연: 창 1
npx firebase-tools emulators:start --only auth,firestore,database,functions --project demo-csat-cast
# 창 2 (scripts 폴더)
set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000
set GCLOUD_PROJECT=demo-csat-cast
node seed.ts templates && node seed.ts schools ../seed/schools.csv && node emulator-demo.ts
# 창 3 (web 폴더)
set VITE_USE_EMULATOR=1&& npx vite --port 5181
```
`http://localhost:5181` → '관리자·테스트 계정'으로 `admin@demo.kr` / `demo1234`. 20개교가 테스트 방송 중인 것처럼 채워지고(건너뜀·연결 끊김·PC 중복 각 1곳), `teacher@demo.kr`의 사용 신청이 대기 중이다.
시험장 CSV(`seed/schools.csv`, 커밋 안 함)는 시험지구 일람표 엑셀에서 만든다: 탐구 열에 `사·과`가 있으면 혼합, 제2외국어 X → 종료 4, O → 혼합(관리자 화면에서 학교별 조정).

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
- 본령이 늦게 울리면(소리 꺼짐 복구, 담당자 [지금 재생] 등) 늦은 만큼 그 시험의 뒤 방송(종료 n분 전·종료령)을 늦춰 시험 시간을 보장한다. 다음 교시는 원래 시각대로라 쉬는 시간이 줄어든다. 늦춘 시각은 시간표에 `+m:ss`로 표시된다.
- 16:05 종료령 파일에는 16:07 두 번째 본령(파일 120초 지점)이 함께 들어 있다. 앞을 잘라 내지 않고, 늦어도 10분까지는 처음부터 끝까지 틀며(늦은 만큼 16:32·16:37도 늦춤), 재생 중 끊기면 처음부터 다시 튼다.
- 연장 시험실(1.5배/1.7배 등) 시간표는 대본에 없어 따로 등록해야 한다.

## 학교 자체 시간표 (경증 시각장애 시험장 등)
평가원 음원·시간표가 맞지 않는 시험장(운영 시간·안내 내용이 다른 경증 시각장애 시험장 등)은 학교 플레이어의 **[시간표 편집]** 탭에서 직접 만든다.
- 음원 올리기: mp3·wav, 20MB 이하. 올리기 전에 재생 가능 여부를 검사하고 길이를 기록한다. Storage `schools/{코드}/assets/` + Firestore `schools/{코드}/assets/{id}` (id는 내용 해시라 같은 파일은 한 번만 저장).
- 시간표: 평가원 시간표를 복사하거나 빈 시간표에서 시작해 방송마다 시각·교시·내용·종류·음원(학교 음원/평가원 음원)·시험 시작/종료를 정한다. [저장]해야 방송에 반영되고, 저장하면 채널 설정 `customCues`로 평가원 유형 대신 이 시간표만 방송한다. [평가원 시간표로 되돌리기]로 해제.
- 저장 전 검사: 시각 형식, 내용·음원 누락, 삭제된 음원(저장 불가) / 같은 시각 겹침, 종료 없는 시험 시작(확인 요청).
- 자동 방송 중에는 편집·미리 듣기 불가. 시간표에서 쓰는 음원은 삭제 불가.
- `seed.ts schools`로 학교를 다시 등록해도 `customCues`는 유지된다.
- 로컬 모드는 이 PC(localStorage·브라우저 캐시)에만 저장된다.
- **타종 붙여 새 음원 만들기**: TTS(클로바더빙 등)로 만든 멘트 앞뒤에 타종을 붙인다. 블록(평가원 참고 타종 5개 / 학교 음원 / 내 PC 파일)을 순서대로 놓고 블록 사이 간격·음량만 정하면, 앞뒤 무음 자르기와 음량 자동 맞추기를 거쳐 모노 32kHz WAV(1분 약 3.8MB)로 합쳐 학교 음원으로 저장한다 (`web/src/core/audioMix.ts`, `pages/AudioComposer.tsx`).

## 음원 (평가원 안내방송 음원)
음원은 공개 저장소·Hosting에 올리지 않고 **Firebase Storage**(`builtin/audio/`, 로그인한 시험장만 읽기)에서 받는다. 로컬 모드는 개발 PC의 `web/public/audio/builtin` 음원을 쓴다. 평가원 음원 폴더(`타종 타입/1. …` ~ `6. …`)를 저장소 루트에 두고:
```
node scripts/import-audio.ts        # 또는 node scripts/import-audio.ts <폴더 경로>
```
- 폴더 간 같은 파일의 내용 일치, 파일명 시각 = 시간표 시각, 폴더 N 구성 = 시간표 csat-N 을 검사하고, 하나라도 어긋나면 아무것도 바꾸지 않는다.
- 고유 음원 40개와 폴더 `7. (참고) 타종`의 멜로디 없는 타종 5개(`ref-bell-*`, 학교 음원 만들기용)를 합쳐 약 115MB를 `web/public/audio/builtin/<큐 id>.mp3`로 복사하고 `manifest.json`(커밋 대상)을 갱신한다.
- `set GOOGLE_APPLICATION_CREDENTIALS=service-account.json` 후 `node scripts/upload-audio.ts` → Storage에 업로드(바뀐 파일만, 버킷 CORS 설정 포함). Storage 규칙은 `firebase deploy --only storage`로 배포.
- Hosting 배포에서는 mp3를 제외한다(`firebase.json` ignore).
- 음원이 바뀌면 manifest의 해시로 학교 PC 캐시가 자동 갱신된다.
- 서비스 워커는 음원을 미리 캐시하지 않는다. 학교 플레이어가 자기 유형에 필요한 음원만 받아 자체 캐시에 저장한다.

## 배포
```
cd scripts && npm install && cd ..
cd functions && npm install && cd ..
cd web && npm run build && cd ..
firebase deploy            # hosting, functions(승인 기능 포함), firestore·database·storage 규칙
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

## 작업 현황 (2026-11-07 기준)
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
- [x] 시험장 목록 CSV로 학교 등록 — 제13시험지구 20곳 `d13-01`~`d13-20`, 사용 신청용 학교 목록 `directory/schools` (2026-11-07)
- [x] 담당 교사 Google 로그인 + 관리자 승인(custom claim), 권한 회수·감사 기록, 방송 중 로그인 끊김에도 송출 유지 (2026-11-07)
- [x] 관리자 학교 × 방송 송출 표, 선유고 별도 영역, 시간표 지문·이중 PC 감지, 송출 기록 CSV, 에뮬레이터 통합 시험·시연 데이터 (2026-11-07)
- [x] 위 변경 배포 (2026-11-07): Hosting·Functions(승인 4종)·Firestore/RTDB/Storage 규칙, 시험장 20곳 등록, Google 로그인 사용 설정 확인
- [ ] 관리자 계정 지정(`seed.ts admin <이메일>`) 후 연수 전 실서버 리허설 (교사 신청 → 승인 → 테스트 방송 → 현황판)
- [x] 방송 결과 기록(테스트·리허설·실전 회차별 결과·사고, 반복 문제), 화면 꺼짐 방지 항상 켜기·전원(배터리) 점검·현황판 경고·절전 설정 안내, 송출 완료 방송 재송출 막기 (2026-11-07)
- [x] 학교당 담당 교사 여러 명: 이중 송출 경고는 자동 방송 2대 이상일 때만, 다른 PC가 저장한 시간표를 방송 PC가 따라감(방송 중이면 멈춘 뒤) (2026-11-07)
- [x] 학교 시간표 엑셀 일괄 가져오기(교시·구분·타종시간), 음원 여러 개 올리기 + 파일 이름 시각(1710_….mp3)으로 자동 연결·교체, 저장 전 편집 내용 이 PC에 보관 (2026-11-07)
- [ ] 선유고 1.5배 자체 시간표: 엑셀 가져오기 → 음원 제작·업로드(파일 이름 앞에 시각) → 저장 (5교시 대본 작업 중)
- [x] 학교 자체 시간표 편집·음원 업로드 (2026-11-03, 경증 시각장애 시험장용)
- [x] 관리자 관리 화면(학교 시간표 확인 포함), 학교×교시 송출 표 (2026-11-07)
- [x] 화면 틀 MUI로 통일(StudentHub 구성: 왼쪽 메뉴·상단바, 수능 방송용 남색 테마·어두운 화면, FHD 기준), 현황판 일반 시험장 위·선유고 우측 사이드, 학교 한 줄·가로 자동 스크롤 (2026-11-07)
- [ ] 수능 주간 Functions `MIN_INSTANCES=1` 재배포
