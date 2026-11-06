@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" >nul 2>nul
if errorlevel 1 goto :folder_error
where node >nul 2>nul
if errorlevel 1 goto :node_error
node -e "const v=process.versions.node.split('.').map(Number); if (!(v[0]>20 || (v[0]===20 && v[1]>=18))) { console.error('Node.js 20.18 or newer is required.'); process.exit(1); }"
if errorlevel 1 goto :node_error
where npm >nul 2>nul
if errorlevel 1 goto :npm_error
if not exist "package.json" goto :missing_files
if not exist "package-lock.json" goto :missing_files
if not exist "src\server.js" goto :missing_files
echo Installing the exact dependencies from package-lock.json...
echo Dependency install scripts are disabled. No trading will be enabled.
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto :install_error
echo.
echo Installation finished. Double-click 2-start-windows.cmd to start.
popd
pause
exit /b 0

:node_error
echo.
echo Install the current Node.js LTS for Windows from https://nodejs.org/
echo Keep the default option that adds Node.js to PATH.
echo Then close this window and double-click this installer again.
goto :failed

:npm_error
echo npm was not found. Reinstall the official Node.js LTS with npm enabled.
goto :failed

:missing_files
echo Required project files were not found. Extract the entire ZIP before starting.
goto :failed

:install_error
echo Installation failed. Read the error above and try again after fixing it.
echo Do not disable TLS verification or run as administrator to bypass errors.
goto :failed

:folder_error
echo Cannot open the project folder. Extract the entire ZIP to your user folder.
pause
exit /b 1

:failed
popd
pause
exit /b 1
