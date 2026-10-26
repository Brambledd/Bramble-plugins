# Build the publishable shell: sync the five plugin packages into plugins/.
# Run from the bramble-memory directory before `npm publish`.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Split-Path -Parent $here

foreach ($p in @("core", "capture", "decisions", "lessons", "events")) {
  $dest = Join-Path $here "plugins\$p"
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  robocopy (Join-Path $src $p) $dest /E /XD node_modules dev /NFL /NDL /NJH /NJS /NP | Out-Null
  Write-Host "synced plugins/$p"
}
Write-Host "build complete — run: npm publish --access public"
