@echo off
setlocal

set "RUST_BIN=C:\Users\%USERNAME%\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
set "CARGO_BIN=C:\Users\%USERNAME%\.cargo\bin"
set "PATH=%RUST_BIN%;%CARGO_BIN%;%PATH%"

cd /d "%~dp0app"

if not exist "node_modules" call npm install

echo Starting Tauri dev...
call npx tauri dev
