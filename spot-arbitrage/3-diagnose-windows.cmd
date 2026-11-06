@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" >nul 2>nul
if errorlevel 1 goto :folder_error
where node >nul 2>nul
if errorlevel 1 goto :node_error
node -e "const v=process.versions.node.split('.').map(Number); if (!(v[0]>20 || (v[0]===20 && v[1]>=18))) { console.error('Node.js 20.18 or newer is required.'); process.exit(1); }"
if errorlevel 1 goto :node_error
if not exist "scripts\diagnose-network.js" goto :missing_files
if not exist "node_modules\.package-lock.json" goto :install_first
echo Stop the trading service before running this independent diagnostic.
echo Public network diagnostics only. No account keys or orders are used.
echo Enter your HTTP proxy in the next prompt, or type direct for no proxy.
echo A restriction or failed check stops further checks for that exchange.
echo This script does not start or configure the trading service.
echo.
node scripts/diagnose-network.js --interactive
if errorlevel 1 goto :diagnostic_error
popd
pause
exit /b 0

:node_error
echo Install Node.js LTS from https://nodejs.org/ and run 1-install-windows.cmd.
goto :failed

:install_first
echo Dependencies are missing. Run 1-install-windows.cmd first.
goto :failed

:missing_files
echo Extract the entire ZIP before running diagnostics.
goto :failed

:diagnostic_error
echo At least one check failed. Read the results above. Do not enable trading.
goto :failed

:folder_error
echo Cannot open the project folder. Extract the entire ZIP to your user folder.
pause
exit /b 1

:failed
popd
pause
exit /b 1
