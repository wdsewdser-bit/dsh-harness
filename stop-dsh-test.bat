@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title DSH Test Stop
cd /d D:\dsh-test

set "DSH_ROOT=D:\dsh-test"
set "LOGDIR=%DSH_ROOT%\logs"
set "PORTFILE=%LOGDIR%\current-port.txt"
set "PIDFILE=%LOGDIR%\current-pid.txt"
set "KILLED=0"

echo ============================================
echo    DSH Test Stop
echo ============================================
echo.
echo [DSH] Stopping only the DSH Test instance...

rem 1) Stop the recorded process only when its command line belongs to DSH Test.
if exist "%PIDFILE%" (
  set "RUNPID="
  set /p RUNPID=<"%PIDFILE%"
  if not "!RUNPID!"=="" (
    powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=!RUNPID!'; if($p -and $p.Name -in @('node.exe','node') -and $p.CommandLine -like '*D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js*--profile web*'){exit 0}else{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
      echo [DSH] Stopping recorded PID !RUNPID!
      taskkill /F /T /PID !RUNPID! >nul 2>&1 && set "KILLED=1"
    )
  )
  del /q "%PIDFILE%" >nul 2>&1
)

rem 2) Stop any listener on the port recorded by this test instance.
if exist "%PORTFILE%" (
  set "RUNPORT="
  set /p RUNPORT=<"%PORTFILE%"
  if not "!RUNPORT!"=="" (
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":!RUNPORT! " ^| findstr LISTENING') do (
      powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%%P'; if($p -and $p.Name -in @('node.exe','node') -and $p.CommandLine -like '*D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js*--profile web*'){exit 0}else{exit 1}" >nul 2>&1
      if !errorlevel! equ 0 (
        echo [DSH] Stopping listener on port !RUNPORT!, PID %%P
        taskkill /F /T /PID %%P >nul 2>&1 && set "KILLED=1"
      )
    )
  )
  del /q "%PORTFILE%" >nul 2>&1
)

rem 3) Clean up remaining Node processes whose command line is under DSH Test.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$items=Get-CimInstance Win32_Process; foreach($p in $items){if($p.Name -in @('node.exe','node') -and $p.CommandLine -like '*D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js*--profile web*'){$p.ProcessId}}"`) do (
  echo [DSH] Stopping remaining test PID %%P
  taskkill /F /T /PID %%P >nul 2>&1 && set "KILLED=1"
)

if "!KILLED!"=="1" (
  echo [DSH] Test instance stopped.
) else (
  echo [DSH] No running DSH Test process was found.
)
echo.
ping -n 5 127.0.0.1 >nul 2>&1
endlocal
exit /b 0
