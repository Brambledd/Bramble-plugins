# ============================================================================
#  Bramble-plugins 卸载脚本（Windows PowerShell）
#  用法：  .\uninstall.ps1                # 自动探测（同 install）
#         .\uninstall.ps1 -Profile web
#  效果：  移除 bundles/dependencies/junction/patch 配置；数据目录保留。
# ============================================================================
param(
  [string]$Profile = ""
)
$ErrorActionPreference = "Stop"

$SrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfilesRoot = Join-Path $DshHome "profiles"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [OK] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "    [X]  $m" -ForegroundColor Red; exit 1 }

if (-not $Profile) {
  $candidates = Get-ChildItem $ProfilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "node_modules\@local\dsh-memory-core") } |
    ForEach-Object { $_.Name }
  if ($candidates.Count -eq 0) { Die "未发现安装了 Bramble-plugins 的 profile" }
  if ($candidates.Count -eq 1) { $Profile = $candidates[0] }
  else { Die "多个 profile 安装过（$($candidates -join ', ')），请用 -Profile 指定" }
}
$ProfileDir = Join-Path $ProfilesRoot $Profile
Step "卸载 profile：$Profile"

# 1. 移除 bundles 与 dependencies
$pkgPath = Join-Path $ProfileDir "package.json"
if (Test-Path $pkgPath) {
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $names = @("dsh-memory-core", "dsh-memory-decisions", "dsh-memory-lessons", "dsh-memory-events")
  $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $keep = $_; -not ($names | Where-Object { $keep -eq "@local/$_" }) }
  $pkg.dsh.profile.bundles = $bundles
  foreach ($n in $names) {
    $depName = "@local/$n"
    if ($pkg.dependencies.PSObject.Properties.Name -contains $depName) {
      $pkg.dependencies.PSObject.Properties.Remove($depName)
    }
  }
  $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
  Ok "bundles / dependencies 已清理"
}

# 2. 移除 patch 配置块
$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
if ((Test-Path $patchPath) -and (Select-String -Path $patchPath -Pattern 'Bramble-plugins memory suite' -Quiet)) {
  $lines = Get-Content $patchPath
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $lines) {
    if ($line -match '^# ---- Bramble-plugins memory suite') { $skipping = $true; continue }
    if ($skipping -and $line -match '^- id: ' -and $line -notmatch 'dsh-memory') { $skipping = $false }
    if (-not $skipping) { $out.Add($line) }
  }
  Set-Content $patchPath $out -Encoding UTF8
  Ok "patch 配置块已移除"
}

# 3. 移除 junction
$localNm = Join-Path $ProfileDir "node_modules\@local"
foreach ($n in @("dsh-memory-core", "dsh-memory-decisions", "dsh-memory-lessons", "dsh-memory-events")) {
  $link = Join-Path $localNm $n
  if (Test-Path $link) { (Get-Item $link).Delete(); Ok "移除 junction $n" }
}

Write-Host "`n卸载完成。重启 DSH 后生效。数据目录（~/.dsh/memory）未动，可手动删除。" -ForegroundColor Cyan
