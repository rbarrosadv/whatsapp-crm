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

rem Rodando de dentro do .zip (sem extrair) o Windows usa uma pasta
rem temporaria que e apagada depois - o atalho ficaria quebrado.
echo %cd% | findstr /I /C:"\AppData\Local\Temp" /C:".zip" >nul
if not errorlevel 1 (
    echo [ATENCAO] Parece que voce abriu o Instalar.bat de DENTRO do arquivo .zip.
    echo.
    echo Faca assim:
    echo   1. Feche esta janela.
    echo   2. Clique com o botao direito no arquivo whatsapp-crm.zip
    echo      e escolha "Extrair tudo...". Extraia em C:\
    echo   3. Abra a pasta C:\whatsapp-crm e de duplo-clique em Instalar.bat
    echo.
    goto :end
)
echo %cd% | findstr /I /C:"OneDrive" >nul
if not errorlevel 1 (
    echo [AVISO] Esta pasta esta dentro do OneDrive. Recomendo mover a pasta
    echo whatsapp-crm para C:\ e rodar o Instalar.bat de la.
    echo Continuando mesmo assim em 10 segundos...
    timeout /t 10 >nul
)

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

if exist "node_modules\electron" if not exist "node_modules\electron\dist\electron.exe" rmdir /s /q "node_modules\electron"
call npm install
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar.
    echo Copie o texto de erro acima e envie para o Claude.
    echo.
    goto :end
)

rem Confere se o Electron (o "motor" do app) foi baixado; se nao, tenta de novo.
if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Baixando o Electron novamente...
    call node node_modules\electron\install.js
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo [ERRO] Nao consegui baixar o Electron.
    echo Verifique a internet e se o antivirus nao bloqueou o download,
    echo e rode o Instalar.bat de novo.
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
