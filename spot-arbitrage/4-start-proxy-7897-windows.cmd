@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "NO_PROXY=localhost,127.0.0.1"
echo Using your local HTTP proxy at 127.0.0.1:7897 for exchange requests.
echo Keep your proxy application running. Exchange access restrictions still apply.
call "%~dp02-start-windows.cmd"
exit /b %errorlevel%
