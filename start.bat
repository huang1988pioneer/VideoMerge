@echo off
setlocal
cd /d "%~dp0"

echo.
echo   VideoMerge 本機啟動
echo   --------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js。請先安裝：https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [錯誤] 找不到 npm。請確認 Node.js 安裝完整。
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [OK] Node %%v

if not exist "node_modules\" (
  echo [→] 尚未安裝依賴，正在執行 npm install…
  call npm install
  if errorlevel 1 (
    echo [錯誤] npm install 失敗
    pause
    exit /b 1
  )
  echo [OK] 依賴安裝完成
) else (
  echo [OK] 依賴已就緒
)

if "%PORT%"=="" set PORT=5173

echo [→] 啟動開發伺服器（http://localhost:%PORT%/）
echo [→] 按 Ctrl+C 可停止
echo.

call npm run dev -- --host 127.0.0.1 --port %PORT% --open
if errorlevel 1 pause
endlocal
