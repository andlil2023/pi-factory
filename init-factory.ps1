param(
  [string]$Target = ".",
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = [System.IO.Path]::GetFullPath($Target)
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
$cmd = @('--experimental-strip-types', (Join-Path $root 'src/init.ts'), $dest)
if ($Force) { $cmd += '--force' }
& node @cmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
