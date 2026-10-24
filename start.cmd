@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ==============================================
rem  一键宏配置工具 - 启动脚本（支持自动管理员提权）
rem  1. 双击本脚本：自动检测权限，非管理员时请求提权（UAC）
rem  2. 提权后以管理员身份启动服务，并自动打开浏览器
rem  3. 关闭本窗口 = 退出程序
rem  如需禁止自动打开浏览器：set MACRO_NO_BROWSER=1 后运行
rem  如需在控制台打印日志：set LOG=DEBUG 后运行（默认静默）
rem ==============================================

rem 检测是否具有管理员权限（net session 仅管理员可执行）
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 未检测到管理员权限，正在请求提权...
    echo 请在 UAC 弹窗中点击「是」以管理员身份运行
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

echo 已获得管理员权限，正在启动一键宏配置工具...
echo 本窗口为服务窗口，关闭即退出程序。
node D:/keep/play-macro/src/server.js
pause
