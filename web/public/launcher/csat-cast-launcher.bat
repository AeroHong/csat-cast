@echo off
chcp 65001 > nul
rem ================================================================
rem  수능 방송 스케줄러 전용 실행 아이콘
rem  - 클릭 없이도 소리가 나도록 자동재생 허용 (새로고침/재시작 후에도 방송 유지)
rem  - 다른 창에 가려지거나 최소화돼도 타이머가 느려지지 않도록 설정
rem  - 평소 쓰는 크롬과 분리된 전용 프로필 사용 (위 옵션이 확실히 적용되도록)
rem ================================================================
set "URL=https://csat-cast.web.app/player?launcher=1"
set "PROFILE=%LocalAppData%\csat-cast-browser"

set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" goto notfound

start "" "%BROWSER%" --user-data-dir="%PROFILE%" --app="%URL%" --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check
exit /b 0

:notfound
echo 크롬 또는 엣지 브라우저를 찾을 수 없습니다. 크롬을 설치한 뒤 다시 실행하세요.
pause
exit /b 1
