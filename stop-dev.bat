@echo off
setlocal enabledelayedexpansion
rem backend/frontendが待ち受けている番号のプロセスをkillして止める（再起動はしない）。
rem restart-dev.batも止める段でこれを呼び、決めた番号を受け取る。用途はrestart-dev.batの冒頭コメント参照。
rem frontendの番号はbackendの設定（CORSの許可元の最初のオリジン。.envの上書きを含む）から読む。
rem backendはこのオリジンからの要求だけを許すので、frontendはここで動いていないとAPIを呼べない。
rem 引数にnopauseを渡すと最後に待たない。

set "ROOT=%~dp0"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT="

pushd "%ROOT%backend"
for /f "usebackq delims=" %%P in (`.venv\Scripts\python.exe -c "from urllib.parse import urlsplit; from app.config import settings; print(urlsplit(settings.cors_allowed_origins_list[0]).port or '')"`) do set "FRONTEND_PORT=%%P"
popd

if not defined FRONTEND_PORT (
    echo Could not read the frontend port from cors_allowed_origins in the backend settings.
    echo Check backend\.venv and the first origin in CORS_ALLOWED_ORIGINS of backend\.env.
    if /i not "%~1"=="nopause" pause
    exit /b 1
)

echo Stopping RideCompass local dev servers...
echo.

call :kill_port %BACKEND_PORT% backend
call :kill_port %FRONTEND_PORT% frontend

if /i not "%~1"=="nopause" (
    echo.
    echo Done.
    pause
)
endlocal & set "BACKEND_PORT=%BACKEND_PORT%" & set "FRONTEND_PORT=%FRONTEND_PORT%" & exit /b 0

:kill_port
set "PORT=%~1"
set "LABEL=%~2"
set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
    echo Stopping %LABEL% process on port %PORT% (PID=%%P^)
    taskkill /F /PID %%P >nul 2>nul
    set "FOUND=1"
)
if "!FOUND!"=="0" echo No %LABEL% process found on port %PORT%
goto :eof
