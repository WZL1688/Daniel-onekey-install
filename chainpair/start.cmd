@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node -e "if (24 > Number(process.versions.node.split('.')[0])) { console.error('Node.js 24 or newer is required'); process.exit(1) }"
if errorlevel 1 (pause & exit /b 1)
if not exist node_modules (
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (pause & exit /b 1)
)
call npm start
pause
