@echo off
setlocal
set "DSH_HOME=D:\dsh-test\home"
set "DSH_EXE=%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
set "DSH_VERSION_CHECK=D:\dsh-test\tools\check-dsh-desktop-version.ps1"
rem Run the Host on a real node.exe instead of the pointer-compressed Electron
rem binary, whose V8 heap is hard-capped at ~4 GiB. The runtime is the dsh/
rem tree unpacked out of app.asar so real node can read it.
set "DSH_HOST_NODE=%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
set "DSH_RUNTIME_DIR=%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\dsh-host"

if not exist "%DSH_HOME%\.credentials.yaml" (
  echo [DSH] Test home not found: %DSH_HOME%
  pause
  exit /b 1
)

if not exist "%DSH_EXE%" (
  echo [DSH] Desktop executable not found: %DSH_EXE%
  pause
  exit /b 1
)

if not exist "%DSH_VERSION_CHECK%" (
  echo [DSH] Version gate not found: %DSH_VERSION_CHECK%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_VERSION_CHECK%" -DshHome "%DSH_HOME%" -DesktopExe "%DSH_EXE%"
if errorlevel 1 (
  echo.
  echo [DSH] Desktop launch refused because the test home and desktop runtime are not compatible.
  pause
  exit /b 1
)

start "" "%DSH_EXE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\focus-dsh-desktop.ps1" -TimeoutSeconds 15
endlocal
