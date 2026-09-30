@echo off
chcp 65001 >nul
set API_KEY=ВСТАВЬ_КЛЮЧ_DEEPSEEK
set REPLICATE_API_TOKEN=ВСТАВЬ_ТОКЕН_REPLICATE
node server.cjs
pause
