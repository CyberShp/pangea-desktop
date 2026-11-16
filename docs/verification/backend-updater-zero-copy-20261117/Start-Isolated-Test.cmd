@echo off
setlocal
cd /d "%~dp0"
set "PANGEA_USER_DATA_DIR=%~dp0test-profile"
set "PANGEA_LOCAL_SKILLS_ROOT=%~dp0local-skills"
set "PANGEA_NODE="
set "PYTHONPATH="
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0PANGEA Desktop.exe"
endlocal
