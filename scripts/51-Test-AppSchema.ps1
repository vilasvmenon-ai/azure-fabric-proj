<#
.SYNOPSIS
  Step 51 - Confirm the physical SQL tables/columns Rayfin created match what the functions expect (R-09, D-24). Read-only.

.DESCRIPTION
  Parses EXPECTED_COLUMNS and TABLES from apps\ars\packages\functions\src\sqlNames.ts (single source of truth),
  connects to the app's Fabric SQL database with YOUR Entra token, and compares INFORMATION_SCHEMA.COLUMNS.
  If names differ, change ONLY sqlNames.ts, rebuild and redeploy Functions.

.EXAMPLE
  .\scripts\51-Test-AppSchema.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg 'ars'
Assert-NoPlaceholders $appCfg.sql 'apps.ars.sql' -IncludeGenerated

$src = Get-Content (Join-Path (Get-RepoRoot) 'apps\ars\packages\functions\src\sqlNames.ts') -Raw
$expected = [ordered]@{}
foreach ($m in [regex]::Matches($src, "(?m)^\s+(\w+): \[([^\]]+)\],")) {
  $expected[$m.Groups[1].Value] = @([regex]::Matches($m.Groups[2].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
}
if ($expected.Count -lt 7) { throw "Could not parse EXPECTED_COLUMNS from sqlNames.ts (found $($expected.Count))." }
# Physical table names (TABLES map: Entity: 'PhysicalName'), e.g. AddressRequest -> AddressRequests.
$physical = @{}
foreach ($m in [regex]::Matches($src, "(?m)^\s+(\w+): '([^']+)',")) { $physical[$m.Groups[1].Value] = $m.Groups[2].Value }

Write-Step "Connecting to $($appCfg.sql.database) on $($appCfg.sql.server)"
$conn = Open-FabricSqlConnection $appCfg.sql.server $appCfg.sql.database $cfg.org.tenantId
try {
  $rows = Invoke-SqlQuery $conn 'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s' @{ s = $appCfg.sql.schema }
} finally { $conn.Close() }

$failures = 0
foreach ($entity in $expected.Keys) {
  $table = if ($physical.ContainsKey($entity)) { $physical[$entity] } else { $entity }
  $cols = @($rows | Where-Object { $_.TABLE_NAME -eq $table })
  if ($cols.Count -eq 0) { Write-Fail "Table $($appCfg.sql.schema).$table not found"; $failures++; continue }
  $missing = @($expected[$entity] | Where-Object { $cols.COLUMN_NAME -notcontains $_ })
  $maxCols = @($cols | Where-Object { $_.CHARACTER_MAXIMUM_LENGTH -eq -1 } | ForEach-Object { $_.COLUMN_NAME })
  if ($missing.Count) { Write-Fail "$table missing columns: $($missing -join ', ')"; $failures++ } else { Write-Ok "$table ($($cols.Count) columns)" }
  if ($maxCols.Count) { Write-Warn2 "$table has NVARCHAR(MAX) columns: $($maxCols -join ', ') (known Rayfin GraphQL issue - every @text needs max)" }
}
$file = New-EvidenceFile "schema-$Environment.csv"
$rows | Export-Csv -NoTypeInformation -Path $file
Write-Ok "Evidence: $file"
if ($failures -gt 0) { exit 1 }
Write-Ok 'Physical schema matches sqlNames.ts.'
