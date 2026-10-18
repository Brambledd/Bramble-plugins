# ============================================================================
#  Bramble-plugins 一键安装脚本（Windows PowerShell）
#  用法：  .\install.ps1                              # 自动探测 profile
#         .\install.ps1 -Profile web                  # 指定 profile
#         .\install.ps1 -DataDir D:\my-memory         # 指定数据目录
#  完成：  链接插件 → 写入 bundles/配置（幂等）→ 生成示例知识文件 → 静态验证
#  卸载：  .\uninstall.ps1
# ============================================================================
param(
  [string]$Profile = "",
  [string]$DataDir = ""
)
$ErrorActionPreference = "Stop"

$SrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfilesRoot = Join-Path $DshHome "profiles"

function WriteUtf8NoBom($path, $content) {
  # PS 5.1 的 UTF8 带 BOM，会写坏 package.json 等配置文件
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}
function AppendUtf8NoBom($path, $content) {
  [System.IO.File]::AppendAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "    [X]  $m" -ForegroundColor Red; exit 1 }

# ---------- 1. 探测目标 profile ----------
Step "探测 DSH profile"
if (-not $Profile) {
  $candidates = @("web", "default") | Where-Object { Test-Path (Join-Path $ProfilesRoot "$_\package.json") }
  if ($candidates.Count -eq 0) {
    $all = Get-ChildItem $ProfilesRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName "package.json") }
    if ($all.Count -eq 1) { $candidates = @($all[0].Name) }
    else { Die "未找到 profile，请用 -Profile <名称> 指定。现有：$($all.Name -join ', ')" }
  }
  $Profile = $candidates[0]
}
$ProfileDir = Join-Path $ProfilesRoot $Profile
if (-not (Test-Path (Join-Path $ProfileDir "package.json"))) { Die "profile '$Profile' 不存在（$ProfileDir）" }
Ok "目标 profile：$Profile"

# ---------- 2. 数据目录 ----------
if (-not $DataDir) { $DataDir = Join-Path $DshHome "memory" }
$KnowledgeDir = Join-Path $DataDir "knowledge"
$LessonsDir = Join-Path $KnowledgeDir "lessons"
Step "准备数据目录：$DataDir"
New-Item -ItemType Directory -Force -Path $LessonsDir, (Join-Path $KnowledgeDir "decisions") | Out-Null
Ok "知识目录：$KnowledgeDir"

# ---------- 3. 备份 ----------
Step "备份 profile 配置"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($f in "package.json", "cordis.patch.yml") {
  $p = Join-Path $ProfileDir $f
  if (Test-Path $p) {
    Copy-Item $p "$p.bak-bramble-$stamp" -Force
    Ok "$f -> $f.bak-bramble-$stamp"
  }
}

# ---------- 4. 链接插件包（junction 名 = 包名尾部）----------
Step "链接插件包到 profile"
$LocalNm = Join-Path $ProfileDir "node_modules\@local"
New-Item -ItemType Directory -Force -Path $LocalNm | Out-Null
$packages = @(
  @{ dir = "core";      name = "dsh-memory-core" },
  @{ dir = "decisions"; name = "dsh-memory-decisions" },
  @{ dir = "lessons";   name = "dsh-memory-lessons" },
  @{ dir = "events";    name = "dsh-memory-events" }
)
foreach ($p in $packages) {
  $link = Join-Path $LocalNm $p.name
  $target = Join-Path $SrcDir "packages\$($p.dir)"
  if (-not (Test-Path $target)) { Die "缺少包目录：$target" }
  if (Test-Path $link) {
    $existing = (Get-Item $link).Target
    if ($existing -and ($existing -eq $target -or $existing.Replace('/','\') -eq $target)) { Ok "$($p.name) 已链接（跳过）"; continue }
    Warn "$($p.name) 链接指向别处，重新指向本仓库"
    (Get-Item $link).Delete()
  }
  cmd /c mklink /J "$link" "$target" | Out-Null
  Ok "$($p.name) -> packages\$($p.dir)"
}

# ---------- 5. 写入 dependencies + bundles（幂等）----------
Step "写入 profile 配置"
$pkgPath = Join-Path $ProfileDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue @{} -Force; $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json }
foreach ($p in $packages) {
  $depName = "@local/$($p.name)"
  if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $depName)) {
    $pkg.dependencies | Add-Member -NotePropertyName $depName -NotePropertyValue "file:./node_modules/@local/$($p.name)" -Force
    Ok "dependency + $depName"
  }
}
$bundleList = @($pkg.dsh.profile.bundles)
$added = $false
foreach ($p in $packages) {
  $depName = "@local/$($p.name)"
  if ($bundleList -notcontains $depName) { $bundleList += $depName; $added = $true; Ok "bundle + $depName" }
}
if ($added) {
  $pkg.dsh.profile.bundles = $bundleList
  WriteUtf8NoBom $pkgPath ($pkg | ConvertTo-Json -Depth 10)
} else { Ok "bundles 已包含全部插件（跳过）" }

# ---------- 6. 追加 patch 配置（幂等）----------
Step "写入插件配置（cordis.patch.yml）"
$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
$patch = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { "[]" }
$dbPath = ($DataDir -replace '\\', '/') + "/evidence.sqlite"
$kRoot  = ($KnowledgeDir -replace '\\', '/')
$lRoot  = ($LessonsDir -replace '\\', '/')
if ($patch -match 'dsh-memory-core') {
  Ok "配置已存在（跳过）"
} else {
  $dataDirFwd = $DataDir -replace '\\', '/'
  $addition = @"

# ---- Bramble-plugins memory suite ----
- id: dsh-memory-core
  name: '@local/dsh-memory-core'
  config:
    dbPath: $($dataDirFwd)/evidence.sqlite
    roots: [$($kRoot)]
    maxResults: 8
    reindexOnStart: true
    promptHint: true
    vector:
      enabled: true
      backfillBatch: 64
- id: dsh-memory-decisions
  name: '@local/dsh-memory-decisions'
  config:
    dbPath: $($dataDirFwd)/evidence.sqlite
    owner: default
    perTurnMax: 1
    dailyMax: 10
- id: dsh-memory-lessons
  name: '@local/dsh-memory-lessons'
  config:
    dbPath: $($dataDirFwd)/lessons.sqlite
    lessonsRoot: $($lRoot)
    evidenceDbPath: $($dataDirFwd)/evidence.sqlite
    evidenceRoot: $($kRoot)
- id: dsh-memory-events
  name: '@local/dsh-memory-events'
  config:
    dbPath: $($dataDirFwd)/events.sqlite
"@
  # 兼容三种现状：空数组文档（替换）、既有内容（--- 分隔的多文档）
  $trimmed = "$patch".Trim()
  if ($trimmed -eq '[]' -or $trimmed -eq '') {
    WriteUtf8NoBom $patchPath ($addition.TrimStart("`r`n") + "`n")
  } else {
    AppendUtf8NoBom $patchPath ("`n---" + $addition)
  }
  Ok "四个插件配置已追加"
}

# ---------- 7. 示例知识文件（首装时）----------
$sampleAdr = Join-Path $KnowledgeDir "decisions\ADR-001-first-decision.md"
if (-not (Test-Path $sampleAdr)) {
  Step "生成示例决策文件"
  $adrContent = @'
---
title: "第一个决策：把重要结论写成决策记录"
status: accepted
kind: decision
summary: "重要技术选型与结论写成 decisions/ 下的决策记录，agent 会在相关话题自动引用。"
keywords: "决策, 示例"
---

# ADR-001: 把重要结论写成决策记录

这是一个示例决策。把你的真实决策按这个格式放进 decisions/ 目录，
agent 在相关话题的对话中会自动收到提醒并可以读取原文验证。
'@
  WriteUtf8NoBom $sampleAdr $adrContent
  Ok "示例：$sampleAdr"
}

# ---------- 8. 静态验证 ----------
Step "静态验证配置组合"
$dshCmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
if (-not $dshCmd) { $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue }
if ($dshCmd) {
  # 绕过 .cmd shim 的参数转发问题：直接用 node 调 dsh 的 bin.js
  $shimDir = Split-Path -Parent $dshCmd.Source
  $binJs = Join-Path $shimDir "node_modules\@deepseek-ai\dsh\lib\bin.js"
  $nodeExe = Join-Path $shimDir "node.exe"
  if (-not (Test-Path $nodeExe)) { $nodeExe = "node" }
  if (Test-Path $binJs) {
    $out = & $nodeExe $binJs --profile $Profile --dump-config 2>&1 | Out-String
    $bad = [regex]::Matches($out, 'skipping|not found|error').Count
    $hit = [regex]::Matches($out, '- id: dsh-memory-(core|decisions|lessons|events)').Count
    if ($hit -ge 4 -and $bad -eq 0) { Ok "四个插件全部正确进入配置树" }
    else { Warn "验证输出异常（插件 $hit/4，问题 $bad），请检查上面的输出；配置备份在 .bak-bramble-$stamp" }
  } else {
    Warn "未找到 dsh 入口（$binJs），跳过验证"
  }
} else {
  Warn "未找到 dsh 命令，跳过验证"
}

Write-Host "`n=============================================================" -ForegroundColor Cyan
Write-Host " 安装完成。重启 DSH（profile: $Profile）后新开会话即可使用。" -ForegroundColor Cyan
Write-Host " 数据目录：$DataDir （知识文件放 $KnowledgeDir）"
Write-Host " 卸载：.\uninstall.ps1 -Profile $Profile"
Write-Host "=============================================================`n" -ForegroundColor Cyan
