@echo off
REM Burnglass - launcher (Windows). Forwards all args to server.js.
REM Usage: burnglass.cmd [--port N] [--summary] [--inspect-schema]
node "%~dp0server.js" %*
