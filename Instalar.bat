@echo off
if /I "%~1"=="RELAUNCHED" goto :main
start "WhatsApp CRM - Instalacao" cmd /k call "%~f0" RELAUNCHED
exit /b

:main
chcp 65001 >nul
title WhatsApp CRM - Instalacao
cd /d "%~dp0"

echo ============================================
echo   WhatsApp CRM - Instalacao
echo ============================================
echo.
echo Pasta atual:
echo %cd%
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao foi encontrado neste computador.
    echo.
    echo Baixe e instale o Node.js ^(versao LTS^) em:
    echo   https://nodejs.org
    echo.
    echo Depois de instalar, feche esta janela e clique
    echo novamente em "Instalar.bat".
    echo.
    goto :end
)

echo Node.js encontrado:
node -v
echo.
echo Instalando, aguarde...
echo (na primeira vez pode levar alguns minutos - baixa uns 150 MB)
echo.

call npm install
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar.
    echo Copie o texto de erro acima e envie para o Claude.
    echo.
    goto :end
)

echo.
echo Criando atalhos na Area de Trabalho e no Menu Iniciar...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\criar-atalho.ps1"

echo.
echo ============================================
echo   Instalacao concluida com sucesso!
echo ============================================
echo.
echo Da proxima vez, abra pelo atalho "WhatsApp CRM" na Area de Trabalho
echo (ou pelo arquivo "Iniciar WhatsApp CRM.bat" desta pasta).
echo.
echo Abrindo o WhatsApp CRM agora...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

:end
echo.
echo [Esta janela pode ser fechada.]
pause
