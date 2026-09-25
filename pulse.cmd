@echo off
REM Pulse was renamed Burnglass in v2.0.0. This shim keeps old scripts and
REM shortcuts working - it runs the same server as burnglass.cmd.
call "%~dp0burnglass.cmd" %*
