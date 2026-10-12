@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title DSH Test Start
cd /d D:\dsh-test

set "DSH_ROOT=D:\dsh-test"
set "DSH_HOME=%DSH_ROOT%\home"
set "DSH_ENTRY=%DSH_ROOT%\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "LAUNCHER=%DSH_ROOT%\launch-dsh-test.cjs"
set "TOKEN_URL=D:\dsh\token-url.cjs"
set "LOGDIR=%DSH_ROOT%\logs"
set "LOG=%LOGDIR%\dsh-test.log"
set "PORTFILE=%LOGDIR%\current-port.txt"
set "PIDFILE=%LOGDIR%\current-pid.txt"
set "START_PORT=40123"

echo ============================================
echo    DSH Test Start
echo ============================================
echo.

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
if not exist "%DSH_ROOT%\tmp" mkdir "%DSH_ROOT%\tmp" >nul 2>&1

if not exist "%DSH_ENTRY%" (
  echo [ERROR] DSH entry was not found:
  echo         %DSH_ENTRY%
  echo.
  pause
  exit /b 1
)
if not exist "%DSH_HOME%\profiles\web\cordis.patch.yml" (
  echo [ERROR] DSH web profile patch was not found:
  echo         %DSH_HOME%\profiles\web\cordis.patch.yml
  echo.
  pause
  exit /b 1
)
if not exist "%LAUNCHER%" (
  echo [ERROR] Test launcher was not found:
  echo         %LAUNCHER%
  echo.
  pause
  exit /b 1
)

rem Reuse a healthy existing test instance instead of starting a duplicate.
if exist "%PIDFILE%" (
  set "RUNPID="
  set /p RUNPID=<"%PIDFILE%"
  if not "!RUNPID!"=="" (
    powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=!RUNPID!'; if($p -and $p.Name -in @('node.exe','node') -and $p.CommandLine -like '*D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js*--profile web*'){exit 0}else{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
      set "RUNPORT="
      if exist "%PORTFILE%" set /p RUNPORT=<"%PORTFILE%"
      if not defined RUNPORT set "RUNPORT=%START_PORT%"
      powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',[int]'!RUNPORT!');exit 0}catch{exit 1}finally{$c.Dispose()}" >nul 2>&1
      if !errorlevel! equ 0 (
        set "URL="
        if exist "%TOKEN_URL%" for /f "usebackq delims=" %%U in (`node "%TOKEN_URL%" "%LOG%" !RUNPORT!`) do set "URL=%%U"
        if defined URL (
          echo [DSH] Existing test instance is healthy: PID !RUNPID!, port !RUNPORT!
          start "" "!URL!"
          echo [DSH] Browser opened.
          ping -n 6 127.0.0.1 >nul 2>&1
          endlocal
          exit /b 0
        )
      )
    )
  )
)

echo [DSH] Starting the test instance from port %START_PORT%...
echo [DSH] Home: %DSH_HOME%
echo [DSH] Log : %LOG%
echo.

set "URL="
for /f "usebackq delims=" %%U in (`node "%LAUNCHER%" "%DSH_ENTRY%" "%DSH_HOME%" %START_PORT% "%LOG%" 40`) do set "URL=%%U"

rem Prefer the token for the port the healthy child actually owns. This avoids
rem opening a URL left by an earlier failed or concurrent launch attempt.
set "RUNPORT="
if exist "%PORTFILE%" set /p RUNPORT=<"%PORTFILE%"
if defined RUNPORT for /f "usebackq delims=" %%U in (`node "%TOKEN_URL%" "%LOG%" !RUNPORT!`) do set "URL=%%U"

if not defined URL (
  echo [ERROR] DSH Test failed to start.
  echo.
  echo ---- Last 25 log lines ----
  powershell -NoProfile -Command "Get-Content -Tail 25 -ErrorAction SilentlyContinue '%LOG%'"
  echo.
  pause
  endlocal
  exit /b 1
)

echo [DSH] Started: %URL%
start "" "%URL%"
echo [DSH] Browser opened. Use stop-dsh-test.bat to stop the test instance.
ping -n 7 127.0.0.1 >nul 2>&1
endlocal
exit /b 0
