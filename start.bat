@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   Malleable Resume - 一键启动
echo ========================================
echo.

:: 检查后端端口
netstat -ano | findstr ":3000" >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] 后端服务器已在运行 (端口 3000)
) else (
    echo [启动] 后端服务器...
    start "后端服务器" cmd /k "cd server && node index.js"
    timeout /t 2 >nul
)

:: 检查前端端口
netstat -ano | findstr ":8080" >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] 前端服务器已在运行 (端口 8080)
) else (
    echo [启动] 前端 HTTP 服务器...
    start "前端服务器" cmd /k "npx http-server -p 8080 -c-1"
    timeout /t 3 >nul
)

echo.
echo ========================================
echo   启动完成！
echo ========================================
echo.
echo 访问地址：http://localhost:8080/test3.html
echo.
echo 后端 API: http://localhost:3000
echo.
echo 关闭所有窗口可停止服务器
echo.
pause

:: 自动打开浏览器
start http://localhost:8080/test3.html
