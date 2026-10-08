# zenbox 一键启动（Windows PowerShell）：仓库根目录执行。
Set-Location -Path $PSScriptRoot
node start.js start @args
exit $LASTEXITCODE
