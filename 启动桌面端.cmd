@echo off
:: ==========================================================================
:: aftersales-agent desktop launcher  (Windows one-click)
::
:: WHY THIS FILE IS PURE ASCII - measured 2026-10-15, do not "improve" it:
::   cmd.exe parses every line of a .cmd/.bat byte-by-byte using the CURRENT
::   console code page. If the file encoding does not match that code page,
::   multi-byte CJK characters are split wrong and can even swallow the line
::   break, so the rest of a line gets executed as its own command.
::   Observed result: the service never started and the app window opened blank.
::   Putting `chcp` inside the file does NOT help - after a chcp line cmd's
::   line bookkeeping desynchronises and the NEXT line is silently dropped
::   (reproduced with a minimal 5-line case: the line after chcp never ran).
::   => Keep this file ASCII-only, and avoid commands that can be shadowed on
::      PATH: `timeout` is shadowed by GNU timeout under Git Bash / MSYS, so we
::      wait with `ping` instead. If you need to change wording, change the
::      ASCII English text - never trade launcher reliability for CJK output.
:: ==========================================================================

cd /d "%~dp0"
title aftersales-agent-desktop

if "%PORT%"=="" set "PORT=8787"

:: ---- 1. locate node: PATH first, then managed runtime, then common installs ----
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "C:\Users\panda\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=C:\Users\panda\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE if exist "E:\node.exe" set "NODE=E:\node.exe"
if not defined NODE for /d %%d in ("E:\*") do if not defined NODE if exist "%%d\node.exe" set "NODE=%%d\node.exe"
if not defined NODE (
  echo [ERROR] Node.js not found. Install Node 22.18+ or add node.exe to PATH.
  echo         Just want to look around? Double-click demo.html - no Node needed.
  pause
  exit /b 1
)

:: ---- 2. do not start a second service if the port is already listening ----
netstat -ano | findstr :%PORT% | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
  echo Service already running on 127.0.0.1:%PORT% - opening window.
  goto open
)

echo Starting local service: http://127.0.0.1:%PORT% ...
start "aftersales-svc" /min "%NODE%" desktop\server.mjs

:: ---- 3. wait for the port, max ~10s (ping, not timeout) ----
set /a _i=0
:wait
set /a _i+=1
if %_i% geq 10 goto open
ping -n 2 127.0.0.1 >nul 2>&1
netstat -ano | findstr :%PORT% | findstr LISTENING >nul 2>&1
if errorlevel 1 goto wait

:open
:: ---- 4. locate Edge: PATH first, then the usual install locations ----
set "EDGE="
where msedge >nul 2>nul && set "EDGE=msedge"
if not defined EDGE if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if defined EDGE (
  start "" "%EDGE%" --app=http://127.0.0.1:%PORT%
  echo [OK] Edge app window opened (frameless desktop window).
) else (
  start "" http://127.0.0.1:%PORT%
  echo [OK] Opened in your default browser (Edge not found).
)

echo.
echo   - Closing this window does NOT stop the service.
echo   - To stop it: close the minimized window named "aftersales-svc".
echo   - Another port:  set PORT=9000  then run this file again.
echo   - No Node? Double-click demo.html in the project root instead.
echo.
pause
