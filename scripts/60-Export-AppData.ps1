<#
.SYNOPSIS
  Step 60 - Export app data and configuration before trial expiry, then prove the export reads back (DATA-04, AC-06).

.DESCRIPTION
  Reads every app table from the ars SQL database with YOUR Entra token (read-only), writes one JSON file per
  table plus manifest.json (row counts, SHA-256 per file, config snapshot without credentials), re-reads each file
  and compares counts and hashes. Requires read access to the app database (workspace Contributor+ or item access).
  Output goes to exports\<env>\<timestamp>\ (git-ignored). Treat exports as app data: store them securely.

.EXAMPLE
  .\scripts\60-Export-AppData.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg 'ars'
Assert-NoPlaceholders $appCfg.sql 'apps.ars.sql' -IncludeGenerated

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$out = Join-Path (Get-RepoRoot) "exports\$Environment\$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
# Physical (pluralised) table names, read from the single source of truth in sqlNames.ts.
$src = Get-Content (Join-Path (Get-RepoRoot) 'apps\ars\packages\functions\src\sqlNames.ts') -Raw
$tables = @([regex]::Matches($src, "(?m)^\s+\w+: '([^']+)',") | ForEach-Object { $_.Groups[1].Value })
if ($tables.Count -lt 7) { throw 'Could not read table names from sqlNames.ts.' }
$schema = $appCfg.sql.schema
$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = [ordered]@{ exportedAtUtc = (Get-Date).ToUniversalTime().ToString('o'); environment = $Environment; app = $appCfg.itemName; database = $appCfg.sql.database; tables = @() }

Write-Step "Exporting from $($appCfg.sql.database)"
$conn = Open-FabricSqlConnection $appCfg.sql.server $appCfg.sql.database $cfg.org.tenantId
try {
  foreach ($t in $tables) {
    $dt = Invoke-SqlQuery $conn "SELECT * FROM [$schema].[$t]"
    $rows = foreach ($r in $dt.Rows) {
      $o = [ordered]@{}
      foreach ($c in $dt.Columns) { $v = $r[$c.ColumnName]; $o[$c.ColumnName] = if ($v -is [DBNull]) { $null } elseif ($v -is [datetime]) { $v.ToString('o') } else { $v } }
      [pscustomobject]$o
    }
    $file = Join-Path $out "$t.json"
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject @($rows) -Depth 5), $utf8)
    $manifest.tables += [ordered]@{ table = $t; rows = $dt.Rows.Count; file = "$t.json"; sha256 = (Get-FileSha256 $file) }
    Write-Ok "$t : $($dt.Rows.Count) rows"
  }
} finally { $conn.Close() }

$snapshot = $cfg | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$manifest.configSnapshot = $snapshot
[System.IO.File]::WriteAllText((Join-Path $out 'manifest.json'), ($manifest | ConvertTo-Json -Depth 25), $utf8)

Write-Step 'Read-back verification'
$m = Read-JsonFile (Join-Path $out 'manifest.json')
$bad = 0
foreach ($t in $m.tables) {
  $path = Join-Path $out $t.file
  $count = @((Read-JsonFile $path)).Count
  if ($t.rows -eq 0) { $count = 0 }
  $hashOk = (Get-FileSha256 $path) -eq $t.sha256
  if ($count -ne $t.rows -or -not $hashOk) { Write-Fail "$($t.table): read back $count rows (expected $($t.rows)), hash ok=$hashOk"; $bad++ }
  else { Write-Ok "$($t.table): $count rows read back, hash verified" }
}
if ($bad -gt 0) { throw 'Export read-back failed.' }
Write-Ok "Export complete and readable: $out"
Write-Host 'Record the export in the application register (export is an audited business action: note who, when, where it is stored).'
