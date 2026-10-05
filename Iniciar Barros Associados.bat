@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
    echo A instalacao ainda nao foi feita.
    echo Clique em "Instalar.bat" primeiro.
    echo.
    pause
    exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
