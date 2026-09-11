# ============================================================================
#  TermChat installer — https://tchat.space-z.ai
#
#  Usage:   irm https://tchat.space-z.ai/i.ps1 | iex
#           (also: /install.ps1)
#  Result:  the native `tchat` CLI installed for your user, PATH configured.
#
#  Env overrides (testing / custom hosts):
#    TCHAT_INSTALL_DIR    where to put tchat.exe
#    TCHAT_DOWNLOAD_BASE  where to download from (default https://tchat.space-z.ai)
# ============================================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 10x faster downloads on PS 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Write-Banner($text, $color = 'Green') { Write-Host $text -ForegroundColor $color }

$Base = if ($env:TCHAT_DOWNLOAD_BASE) { $env:TCHAT_DOWNLOAD_BASE } else { 'https://tchat.space-z.ai' }

$isWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$psep  = if ($isWin) { ';' } else { ':' }

# ---- 1. install location (user scope — no admin needed) --------------------
if ($env:TCHAT_INSTALL_DIR) {
  $Dir = $env:TCHAT_INSTALL_DIR
} elseif ($env:LOCALAPPDATA) {
  $Dir = Join-Path $env:LOCALAPPDATA 'Programs\TermChat'
} else {
  $Dir = Join-Path $HOME '.tchat'
}

# ---- 1b. pick the right native binary for this platform ---------------------
if ($isWin) {
  $Asset = 'tchat-windows-x64.exe.gz'
  $ExeName = 'tchat.exe'
} elseif ($IsMacOS) {
  $arch = 'x64'
  try {
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { $arch = 'arm64' }
  } catch {}
  $Asset = "tchat-darwin-$arch.gz"
  $ExeName = 'tchat'
} else {
  $Asset = 'tchat-linux-x64.gz'
  $ExeName = 'tchat'
}
$Exe = Join-Path $Dir $ExeName

Write-Host ''
Write-Banner '  TermChat installer'
Write-Host "  install dir : $Dir" -ForegroundColor DarkGray

# ---- 2. skip if already up to date -----------------------------------------
try {
  $remoteVer = (Invoke-WebRequest -UseBasicParsing "$Base/version.txt").Content.Trim()
} catch { $remoteVer = '' }
if (Test-Path $Exe) {
  try {
    $localVer = (& $Exe --version 2>$null | Select-Object -First 1)
    if ($localVer -match '^tchat\s+([^\s-]+)') { $localVer = $Matches[1] } else { $localVer = '' }
  } catch { $localVer = '' }
  if ($remoteVer -and ($localVer -eq $remoteVer)) {
    Write-Banner "  Already up to date (tchat $localVer). Nothing to do."
    Write-Host ''
    Write-Host '  Join a room:  ' -NoNewline; Write-Banner 'tchat join 7XK92' 'White'
    Write-Host ''
    return
  }
}

# ---- 3. download ------------------------------------------------------------
$Url = "$Base/dl/$Asset"
Write-Host "  downloading : $Url" -ForegroundColor DarkGray
Write-Host '  (native single binary, ~25-40 MB — one time only)' -ForegroundColor DarkGray

$Gz = "$Exe.gz"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Gz
} catch {
  Write-Banner "  Download failed: $($_.Exception.Message)" 'Red'
  Write-Host '  Check your connection and re-run, or use the browser:' -ForegroundColor Gray
  Write-Banner '  https://tchat.space-z.ai' 'White'
  return
}
if (-not (Test-Path $Gz) -or (Get-Item $Gz).Length -lt 1000000) {
  Write-Banner '  Download looks wrong (too small) — aborting.' 'Red'
  return
}

# ---- 4. gunzip -> tchat.exe -------------------------------------------------
try { Add-Type -AssemblyName System.IO.Compression } catch {}
$inStream = [IO.File]::OpenRead($Gz)
try {
  $gzStream = New-Object IO.Compression.GzipStream($inStream, [IO.Compression.CompressionMode]::Decompress)
  try {
    $outStream = [IO.File]::Create($Exe)
    try { $gzStream.CopyTo($outStream) } finally { $outStream.Dispose() }
  } finally { $gzStream.Dispose() }
} finally { $inStream.Dispose() }
Remove-Item $Gz -Force
if (-not $isWin) { try { & chmod +x $Exe } catch {} }

# sanity check
$verLine = ''
try { $verLine = (& $Exe --version | Select-Object -First 1) } catch {}
if (-not $verLine) {
  Write-Banner '  Installed binary did not run correctly.' 'Red'
  return
}

# ---- 5. PATH (user scope, survives new windows) -----------------------------
$pathNote = $false
if ($isWin) {
  try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $Dir) {
      [Environment]::SetEnvironmentVariable('Path', (($userPath, $Dir) -join ';').Trim(';'), 'User')
      $pathNote = $true
    }
  } catch {}
}
if (($env:PATH -split $psep) -notcontains $Dir) { $env:PATH = "$Dir$psep$env:PATH" }

# ---- 6. success banner -------------------------------------------------------
Write-Host ''
Write-Banner "  Installed:  $verLine"
Write-Host "             at $Exe"
Write-Host ''
Write-Host '  Join a room right now:'
Write-Host ''
Write-Host '      tchat join lobby            ' -NoNewline; Write-Host '# public lobby'      -ForegroundColor DarkGray
Write-Host '      tchat join 7XK92            ' -NoNewline; Write-Host '# any room code'      -ForegroundColor DarkGray
Write-Host '      tchat join 7XK92 -n Sam     ' -NoNewline; Write-Host '# with a guest name'  -ForegroundColor DarkGray
if ($pathNote) {
  Write-Host ''
  Write-Host '  NOTE: PATH updated for NEW terminal windows.' -ForegroundColor Yellow
  Write-Host '  In THIS window the full path works:' -ForegroundColor Yellow
  Write-Host "      & `"$Exe`" join lobby" -ForegroundColor Gray
}
Write-Host ''
Write-Host '  Web (no install): https://tchat.space-z.ai/r/lobby' -ForegroundColor DarkGray
Write-Host "  Uninstall:        Remove-Item `"$Dir`" -Recurse" -ForegroundColor DarkGray
Write-Host ''

# ---- 7. optional: launch right now -------------------------------------------
$canPrompt = $false
try { $canPrompt = [Console]::KeyAvailable; $canPrompt = $true } catch { $canPrompt = $false }
if ($canPrompt -and [Environment]::UserInteractive) {
  Write-Host '  Launch tchat now? [Y/n] (auto-yes in 5s) ' -NoNewline
  $choice = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    while ($sw.Elapsed.TotalSeconds -lt 5 -and -not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 120 }
    if ([Console]::KeyAvailable) { $key = [Console]::ReadKey($true); if ($key.Key -eq 'N') { $choice = 'n' } }
  } catch {}
  Write-Host ''
  if ($choice -ne 'n') {
    Write-Host ''
    & $Exe
  }
}
