@echo off
setlocal

echo ============================================
echo   Anvil - Production Build (full optimize)
echo ============================================
echo.

set "RUST_BIN=C:\Users\%USERNAME%\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
set "CARGO_BIN=C:\Users\%USERNAME%\.cargo\bin"
set "PATH=%RUST_BIN%;%CARGO_BIN%;%PATH%"

:: Verify tools
where cargo >nul 2>&1 || (echo ERROR: cargo not found. Install Rust from https://rustup.rs & exit /b 1)
where node >nul 2>&1 || (echo ERROR: node not found. Install Node.js from https://nodejs.org & exit /b 1)

:: Move to app directory
cd /d "%~dp0app"

:: Install npm dependencies if needed
if not exist "node_modules" (
    echo [1/3] Installing npm dependencies...
    call npm install || (echo ERROR: npm install failed & exit /b 1)
) else (
    echo [1/3] npm dependencies already installed.
)

:: Build with Tauri
echo [2/3] Building Tauri app (this may take a few minutes)...
call npx tauri build 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Tauri build failed with code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)

:: Copy all outputs to dist/
echo [3/3] Copying to dist...
set "DIST_DIR=%~dp0dist"
set "RELEASE_DIR=%~dp0app\src-tauri\target\release"
set "BUNDLE_DIR=%RELEASE_DIR%\bundle"

:: Clean and create dist
if exist "%DIST_DIR%" rd /s /q "%DIST_DIR%"
mkdir "%DIST_DIR%"

:: Copy standalone exe
if exist "%RELEASE_DIR%\anvil.exe" (
    copy /Y "%RELEASE_DIR%\anvil.exe" "%DIST_DIR%\" >nul
    echo   - anvil.exe
) else (
    echo ERROR: anvil.exe not found in %RELEASE_DIR%
    exit /b 1
)

:: Copy data directory (system prompts, etc.)
if exist "%RELEASE_DIR%\data" (
    xcopy /Y /E /I "%RELEASE_DIR%\data" "%DIST_DIR%\data" >nul
    echo   - data\
)

:: Copy sidecar (Agent SDK bridge)
set "SIDECAR_SRC=%~dp0sidecar"
set "SIDECAR_DST=%DIST_DIR%\sidecar"
if exist "%SIDECAR_SRC%\sidecar.js" (
    mkdir "%SIDECAR_DST%" 2>nul
    copy /Y "%SIDECAR_SRC%\sidecar.js" "%SIDECAR_DST%\" >nul
    copy /Y "%SIDECAR_SRC%\package.json" "%SIDECAR_DST%\" >nul
    copy /Y "%SIDECAR_SRC%\package-lock.json" "%SIDECAR_DST%\" >nul
    echo   - sidecar\
    echo     Installing sidecar dependencies...
    pushd "%SIDECAR_DST%"
    call npm install --production >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo WARNING: sidecar npm install failed
    ) else (
        echo     sidecar dependencies installed.
    )
    popd
) else (
    echo WARNING: sidecar\sidecar.js not found — agent SDK will not work
)

:: Copy WebView2Loader if present
if exist "%RELEASE_DIR%\WebView2Loader.dll" (
    copy /Y "%RELEASE_DIR%\WebView2Loader.dll" "%DIST_DIR%\" >nul
    echo   - WebView2Loader.dll
)

:: Copy NSIS installer if present
if exist "%BUNDLE_DIR%\nsis\*.exe" (
    copy /Y "%BUNDLE_DIR%\nsis\*.exe" "%DIST_DIR%\" >nul
    echo   - NSIS installer
)

:: Copy MSI installer if present
if exist "%BUNDLE_DIR%\msi\*.msi" (
    copy /Y "%BUNDLE_DIR%\msi\*.msi" "%DIST_DIR%\" >nul
    echo   - MSI installer
)

echo.
echo ============================================
echo   Build complete! Output in dist\
echo ============================================
dir /b "%DIST_DIR%"
echo.
pause
