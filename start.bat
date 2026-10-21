@echo off
cd /d "%~dp0"
if not exist node_modules\ws goto install
goto start
:install
echo Installing server dependency...
call npm install
if errorlevel 1 pause & exit /b 1
:start
call npm start
pause
