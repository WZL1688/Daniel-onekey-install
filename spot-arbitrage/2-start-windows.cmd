@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" >nul 2>nul
if errorlevel 1 goto :folder_error
where node >nul 2>nul
if errorlevel 1 goto :node_error
node -e "const v=process.versions.node.split('.').map(Number); if (!(v[0]>20 || (v[0]===20 && v[1]>=18))) { console.error('Node.js 20.18 or newer is required.'); process.exit(1); }"
if errorlevel 1 goto :node_error
if not exist "src\server.js" goto :missing_files
if not exist "node_modules\.package-lock.json" goto :install_first
echo Starting the local management page. Keep this window open.
echo Wait for the server to report that it has started, then open a browser.
echo The default address is http://127.0.0.1:8888
echo If you configured PORT yourself, use the port shown by the server.
echo Auto trading remains OFF after every restart.
echo Press Ctrl+C to stop. Closing this window also stops the service.
echo.
node src/server.js
if errorlevel 1 goto :start_error
popd
pause
exit /b 0

:node_error
echo Install Node.js LTS from https://nodejs.org/ and run 1-install-windows.cmd.
goto :failed

:install_first
echo Dependencies are missing. Close this window and run 1-install-windows.cmd first.
goto :failed

:missing_files
echo Required project files were not found. Extract the entire ZIP before starting.
goto :failed

:start_error
echo The service stopped with an error. Read the error above before restarting.
echo If the port or data folder is already in use, close the other instance first.
echo Do not delete process.lock or risk state to bypass a startup error.
goto :failed

:folder_error
echo Cannot open the project folder. Extract the entire ZIP to your user folder.
pause
exit /b 1

:failed
popd
pause
exit /b 1
