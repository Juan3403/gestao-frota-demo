@echo off
chcp 65001 >nul
title Gestão RM - Servidor
cd /d "%~dp0"

echo ==================================================
echo   Gestão RM — Central de Gestão (SUL - NTE)
echo ==================================================
echo.

REM Instala as dependencias automaticamente na primeira vez
if not exist "node_modules" (
  echo Primeira execucao: baixando componentes necessarios...
  echo Isso pode levar 1-2 minutos. Aguarde.
  call npm install
  echo.
)

set "PORT=3001"
echo Iniciando o servidor na porta %PORT%...
echo Abra no navegador:  http://localhost:%PORT%
echo (Para encerrar, feche esta janela ou pressione Ctrl + C)
echo.

node backend/server.js
pause
