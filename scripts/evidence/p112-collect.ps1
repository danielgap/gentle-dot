# Functional evidence for PR #112 at head 9c4f6a8 (temporary branch, never merged).
#
# Produces, on a real windows-latest runner, against the NSIS-installed runtime:
#   - installer identity (sha256, bytes) and silent-install outcomes
#   - installed runtime versions (pi / engram / gentle-ai engine)
#   - fresh isolated-profile first launch: provisioning, /health, ownership + DACL of the data tree
#   - existing-profile relaunch: no re-provision (identity + token hashes)
#   - safe refusals: data-folder claim, port already held; rejected startups leave data unchanged
#   - NSIS uninstall: app gone, per-user data preserved
#
# Headless by design: the standalone daemon has no app channel (the app owns it), no conversation
# is sent, and the GUI (panel, tray, clean app-owned shutdown) is covered by the human recording.
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
function Out-To($name, $text) { $text | Out-File -FilePath (Join-Path $OutDir $name) -Encoding utf8 }
function Hash-Core([string]$path) {
  if (-not (Test-Path $path)) { return 'ABSENT' }
  $files = Get-ChildItem $path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '\.log$' -and $_.Name -notmatch 'claim|lock|\.pid$' } |
    Sort-Object FullName
  if (-not $files) { return 'EMPTY' }
  ($files | ForEach-Object { "$($_.FullName.Substring($path.Length))=$([System.BitConverter]::ToString((Get-FileHash $_.FullName -Algorithm SHA256).Hash))" }) -join "`n"
}
function Wait-Health($port, $seconds) {
  $dl = Get-Date; $body = ''
  while (((Get-Date) - $dl).TotalSeconds -lt $seconds) {
    try { $body = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3).Content; break } catch { Start-Sleep -Milliseconds 700 }
  }
  "health=$body waited=$([int]((Get-Date)-$dl).TotalSeconds)s"
}
function Wait-Line($file, $pattern, $seconds) {
  $dl = Get-Date
  while (((Get-Date) - $dl).TotalSeconds -lt $seconds) {
    if ((Get-Content $file -ErrorAction SilentlyContinue) -match $pattern) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
$Port = 14317

# ---------- 0. environment ----------
$s0 = @("image=$env:IMAGE_OS/$env:IMAGE_VERSION", "runner=$env:RUNNER_NAME")
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$s0 += "os=$($cv.ProductName) build=$($cv.CurrentBuild).$($cv.UBR) arch=$env:PROCESSOR_ARCHITECTURE"
foreach ($t in 'node','pnpm','rustc','git') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  $s0 += "$t=$(if ($c) { (& $t --version 2>&1 | Select-Object -First 1) } else { 'not-found' })"
}
$s0 += "go=$(go version 2>&1)"
$s0 | Write-Host; Out-To '0-environment.txt' ($s0 -join "`n")

# ---------- 1. installer identity ----------
$bundle = Join-Path $RepoRoot 'apps\desktop\src-tauri\target\release\bundle'
$setup = Get-ChildItem (Join-Path $bundle 'nsis') -Filter '*x64-setup.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $setup) { throw "no NSIS installer under $bundle\nsis" }
$s1 = @("installer=$($setup.FullName)", "bytes=$($setup.Length)", "sha256=$((Get-FileHash $setup.FullName -Algorithm SHA256).Hash)", "built=$($setup.LastWriteTime)")
$s1 | Write-Host; Out-To '1-installer.txt' ($s1 -join "`n")

# ---------- 2. silent NSIS install ----------
$instDir = Join-Path $OutDir 'install'
$p2 = Start-Process -FilePath $setup.FullName -ArgumentList "/S /D=$instDir" -Wait -PassThru
$exe = Join-Path $instDir 'Gentle Dot.exe'
$runtime = Join-Path $instDir 'runtime'
$rv = @()
$piCmd = Join-Path $runtime 'bin\pi.cmd'
if (Test-Path $piCmd) { $rv += "pi=$(cmd /c "`"$piCmd`" --version" 2>&1 | Select-Object -First 1)" }
$engram = Join-Path $runtime 'bin\engram.exe'
if (Test-Path $engram) { $rv += "engram=$(& $engram --version 2>&1 | Select-Object -First 1)" }
$engine = Get-ChildItem $runtime -Recurse -Filter 'gentle-ai*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($engine) { $rv += "engine=$(& $engine.FullName --version 2>&1 | Select-Object -First 1)" }
$arp = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Gentle Dot' -ErrorAction SilentlyContinue
$rootExes = @(Get-ChildItem $instDir -File -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object Name)
$s2 = @(
  "nsis-exit=$($p2.ExitCode)",
  "root-exes=$($rootExes -join ', ')",
  "exe-present=$(@($rootExes | Where-Object { $_ -ne 'uninstall.exe' }).Count -gt 0)",
  "runtime-file-count=$(@(Get-ChildItem $runtime -Recurse -File).Count)",
  ($rv -join '; '),
  "arp-entry=$([bool]$arp)",
  "install-dir-owner=$((Get-Acl $instDir).Owner)"
)
$s2 | Write-Host; Out-To '2-install.txt' ($s2 -join "`n")

# ---------- daemon launch: replicates daemon.rs launch_spec against the installed runtime ----------
$nodeExe = Join-Path $runtime 'node\node.exe'
$cliMjs = Join-Path $runtime 'daemon\cli.mjs'
$daemonPath = "$(Join-Path $runtime 'bin');$(Join-Path $runtime 'node');$env:SystemRoot\system32;$env:SystemRoot"
function Start-Daemon([string]$dataDir, [int]$port, [string]$stdout, [string]$stderr) {
  $saved = @{ PATH = $env:PATH; RT = $env:GENTLE_DOT_RUNTIME; DATA = $env:GENTLE_DOT_DATA_DIR; PORT = $env:GENTLE_DOT_PORT }
  $env:PATH = $daemonPath
  $env:GENTLE_DOT_RUNTIME = $runtime
  $env:GENTLE_DOT_DATA_DIR = $dataDir
  $env:GENTLE_DOT_PORT = "$port"
  $p = Start-Process -FilePath $nodeExe -ArgumentList "`"$cliMjs`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $env:PATH = $saved.PATH; $env:GENTLE_DOT_RUNTIME = $saved.RT; $env:GENTLE_DOT_DATA_DIR = $saved.DATA; $env:GENTLE_DOT_PORT = $saved.PORT
  $p
}
function Run-Daemon-Exit([string]$dataDir, [int]$port, [string]$stdout, [string]$stderr, [int]$waitSec) {
  $p = Start-Daemon $dataDir $port $stdout $stderr
  if (-not $p.WaitForExit($waitSec * 1000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $p.WaitForExit(); "exit=timeout-forced" } else { "exit=$($p.ExitCode)" }
}

# ---------- 3. fresh isolated profile: first launch ----------
$dataA = Join-Path $OutDir 'data-a'
$pA = Start-Daemon $dataA $Port (Join-Path $OutDir '3-a-stdout.txt') (Join-Path $OutDir '3-a-stderr.txt')
$ready = Wait-Line (Join-Path $OutDir '3-a-stdout.txt') 'Gentle Dot is running' 90
$health = Wait-Health $Port 30
$s3 = @("ready-line-seen=$ready pid=$($pA.Id) alive=$(-not $pA.HasExited)", $health)
$s3 += 'data-tree:'; $s3 += (Get-ChildItem $dataA -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object FullName)
$s3 += "data-dir-owner=$((Get-Acl $dataA).Owner)"
$s3 += 'icacls (boundary paths):'
foreach ($p in @($dataA, (Join-Path $dataA 'agent'), (Join-Path $dataA 'sessions'), (Join-Path $dataA 'workspace'), (Join-Path $dataA 'token'))) {
  if (Test-Path $p) { $s3 += (icacls $p /C 2>&1) }
}
$hashA0 = Hash-Core $dataA
$tokPre = if (Test-Path (Join-Path $dataA 'token')) { (Get-FileHash (Join-Path $dataA 'token') -Algorithm SHA256).Hash } else { 'ABSENT' }
$idPre = if (Test-Path (Join-Path $dataA 'identity.md')) { (Get-FileHash (Join-Path $dataA 'identity.md') -Algorithm SHA256).Hash } else { 'ABSENT' }
$sessPre = Hash-Core (Join-Path $dataA 'sessions')
$s3 += "token-sha256=$tokPre"
$s3 += "identity-md-sha256=$idPre"
$s3 += "sessions-state=$sessPre"
$s3 | Write-Host; Out-To '3-fresh-first-launch.txt' ($s3 -join "`n")

# ---------- 4. safe refusals ----------
$bExit = Run-Daemon-Exit $dataA ($Port + 1) (Join-Path $OutDir '4-b-stdout.txt') (Join-Path $OutDir '4-b-stderr.txt') 60
$cExit = Run-Daemon-Exit (Join-Path $OutDir 'data-c') $Port (Join-Path $OutDir '4-c-stdout.txt') (Join-Path $OutDir '4-c-stderr.txt') 60
$hashA1 = Hash-Core $dataA
$healthA = Wait-Health $Port 15
$s4 = @(
  "B(same data dir, other port) $bExit", ((Get-Content (Join-Path $OutDir '4-b-stderr.txt') -ErrorAction SilentlyContinue) -join "`n"),
  '', "C(other data dir, same port) $cExit", ((Get-Content (Join-Path $OutDir '4-c-stderr.txt') -ErrorAction SilentlyContinue) -join "`n"),
  '', "A-core-unchanged-after-rejections=$($hashA0 -eq $hashA1)", "A-still-healthy: $healthA"
)
$s4 | Write-Host; Out-To '4-refusals.txt' ($s4 -join "`n")

# ---------- 5. existing profile: relaunch without re-provisioning ----------
Stop-Process -Id $pA.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$pA2 = Start-Daemon $dataA $Port (Join-Path $OutDir '5-a2-stdout.txt') (Join-Path $OutDir '5-a2-stderr.txt')
$ready2 = Wait-Line (Join-Path $OutDir '5-a2-stdout.txt') 'Gentle Dot is running' 90
$health2 = Wait-Health $Port 30
$hashA2 = Hash-Core $dataA
$tokPost = if (Test-Path (Join-Path $dataA 'token')) { (Get-FileHash (Join-Path $dataA 'token') -Algorithm SHA256).Hash } else { 'ABSENT' }
$idPost = if (Test-Path (Join-Path $dataA 'identity.md')) { (Get-FileHash (Join-Path $dataA 'identity.md') -Algorithm SHA256).Hash } else { 'ABSENT' }
$sessPost = Hash-Core (Join-Path $dataA 'sessions')
$s5 = @(
  "ready-line-seen=$ready2", $health2,
  "token-content-preserved=$($tokPre -eq $tokPost) ($($tokPost.Substring(0,16))…)",
  "identity-md-content-preserved=$($idPre -eq $idPost) ($($idPost.Substring(0,16))…)",
  "sessions-preserved=$($sessPre -eq $sessPost)"
)
$s5 += 'note: identity.md is re-staged from the packaged source on every start (white-label identityArgs); its mtime refreshing is by design, the content hash above is the meaningful comparison.'
$s5 += 'identity files:'
foreach ($f in 'identity.md','token') { $fp = Join-Path $dataA $f; if (Test-Path $fp) { $s5 += "  $f mtime=$((Get-Item $fp).LastWriteTime.ToString('s')) sha=$((Get-FileHash $fp -Algorithm SHA256).Hash.Substring(0,16))" } }
$s5 | Write-Host; Out-To '5-existing-relaunch.txt' ($s5 -join "`n")
Stop-Process -Id $pA2.Id -Force -ErrorAction SilentlyContinue

# ---------- 6. uninstall ----------
$hashDataBefore = Hash-Core $dataA
$p6 = Start-Process -FilePath (Join-Path $instDir 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
Start-Sleep -Seconds 5
$arp2 = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Gentle Dot' -ErrorAction SilentlyContinue
$s6 = @("uninstall-exit=$($p6.ExitCode)", "exe-gone=$(-not (Test-Path $exe))", "user-data-preserved=$($hashDataBefore -eq (Hash-Core $dataA))", "arp-entry-gone=$(-not $arp2)")
$s6 | Write-Host; Out-To '6-uninstall.txt' ($s6 -join "`n")

# ---------- 7. manifest ----------
@{
  script = 'p112-collect.ps1'; head = '9c4f6a8'; port = $Port
  installer = $setup.FullName; installerSha256 = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash
  finished = (Get-Date -Format 's')
  files = @(Get-ChildItem $OutDir -File | Select-Object -ExpandProperty Name)
} | ConvertTo-Json | Out-File (Join-Path $OutDir 'manifest.json') -Encoding utf8
Write-Host "EVIDENCE DONE: $OutDir"
