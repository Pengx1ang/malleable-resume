@echo off
echo.
echo ========================================
echo   Malleable Resume - 本地开发服务器
echo ========================================
echo.
echo 正在启动本地服务器...
echo.
echo 访问地址：http://localhost:8080
echo.
echo 按 Ctrl+C 停止服务器
echo.

:: 尝试使用 Python 启动简单 HTTP 服务器
python -m http.server 8080

:: 如果 Python 不可用，提示用户
if %errorlevel% neq 0 (
    echo.
    echo [错误] Python 未安装或不在 PATH 中
    echo.
    echo 请选择以下任一方案：
    echo.
    echo 方案 1: 安装 Python (https://www.python.org/downloads/)
    echo.
    echo 方案 2: 使用 Node.js 启动（如果已安装）
    echo   运行：npx http-server -p 8080
    echo.
    echo 方案 3: 使用 VS Code Live Server 插件
    echo   右键 test3.html → "Open with Live Server"
    echo.
    pause
)
