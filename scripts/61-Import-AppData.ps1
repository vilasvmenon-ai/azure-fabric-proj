<#
.SYNOPSIS
  Step 61 - Restore an export made by 60-Export-AppData.ps1 into an EMPTY app database (dry run by default).

.DESCRIPTION
  Use it to move App A data to a new Fabric App item (for example after trial expiry or into a new workspace).
  Deploy the target app first (script 30) and resolve its database (script 31); do NOT bootstrap it, so its
  tables stay empty.

  Checks before writing:
   - manifest.json is present and every table file matches its recorded SHA-256 and row count;
   - every exported column exists in the target table (target columns are read from INFORMATION_SCHEMA);
   - every target table being imported is EMPTY (the script never merges or overwrites rows).
  Without -Apply it only reports what it would do. With -Apply it inserts all rows in ONE transaction
  (all or nothing), then re-counts every table.

  Identity limits (record them in the register when you use this):
   - User subjects (`*_sub` columns) are specific to the Fabric App item that issued the token. In a NEW item the
     same person gets a different subject. -ResetUserBindings sets AppMemberships.user_sub to NULL so each member
     is re-bound by email on their next sign-in (D-14). Without it, members are refused (membership.subject_mismatch).
   - Ownership of requests (AddressRequests.creator_sub) is NOT rewritten: in a new item, users no longer see their
     own historical requests in "My requests"; reviewers, admins and auditors still see them. Audit rows keep their
     historical actor subjects so the hash chain stays valid.
  Requires write access to the target database (workspace Admin/Member, as with script 51).

.EXAMPLE
  .\scripts\61-Import-AppData.ps1 -Environment dev -ExportPath .\exports\dev\20261026T120135Z
  .\scripts\61-Import-AppData.ps1 -Environment dev -ExportPath .\exports\dev\20261026T120135Z -ResetUserBindings -Apply
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$Environment = 'dev',
  [Parameter(Mandatory = $true)][string]$ExportPath,
  [string[]]$SkipTables = @(),
  [switch]$ResetUserBindings,
  [switch]$Apply
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg 'ars'
Assert-NoPlaceholders $appCfg.sql 'apps.ars.sql' -IncludeGenerated
$schema = $appCfg.sql.schema
$ExportPath = (Resolve-Path $ExportPath).Path

# Restore order: configuration and memberships first, audit last (no foreign keys exist; order is for readability).
$order = @('AppConfigs', 'AppMemberships', 'SampleAddresses', 'AddressRequests', 'AddressResults', 'ReviewHistories', 'AuditEvents')

Write-Step "Checking export $ExportPath"
$manifestPath = Join-Path $ExportPath 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw 'manifest.json not found. Pass the folder created by 60-Export-AppData.ps1.' }
$manifest = Read-JsonFile $manifestPath
$plan = @()
foreach ($t in $manifest.tables) {
  if ($order -notcontains $t.table) { throw "Unexpected table '$($t.table)' in the manifest." }
  if ($SkipTables -contains $t.table) { Write-Warn2 "$($t.table): skipped (-SkipTables)"; continue }
  $path = Join-Path $ExportPath $t.file
  if ((Get-FileSha256 $path) -ne $t.sha256) { throw "$($t.file) does not match its SHA-256 in manifest.json. The export was changed or damaged." }
  $rows = @()
  # PS 5.1 ConvertFrom-Json returns a JSON array as one object; piping enumerates it.
  if ($t.rows -gt 0) { $rows = @((Read-JsonFile $path) | ForEach-Object { $_ }) }
  if ($rows.Count -ne $t.rows) { throw "$($t.file) has $($rows.Count) rows; the manifest says $($t.rows)." }
  $plan += [pscustomobject]@{ table = $t.table; rows = $rows; sort = [array]::IndexOf($order, $t.table) }
  Write-Ok "$($t.table): $($t.rows) rows, hash verified"
}
$plan = @($plan | Sort-Object sort)
Write-Host "  Exported from: $($manifest.app) / $($manifest.database) at $($manifest.exportedAtUtc)"
Write-Host "  Target:        $($appCfg.itemName) / $($appCfg.sql.database)"
if ($manifest.database -eq $appCfg.sql.database) { throw 'The target database is the database the export came from. Restore only into a different (new, empty) app database.' }

$conn = Open-FabricSqlConnection $appCfg.sql.server $appCfg.sql.database $cfg.org.tenantId
try {
  Write-Step 'Checking the target tables'
  $colInfo = Invoke-SqlQuery $conn 'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s' @{ s = $schema }
  $problems = 0
  foreach ($p in $plan) {
    $targetCols = @($colInfo.Rows | Where-Object { $_.TABLE_NAME -eq $p.table })
    if ($targetCols.Count -eq 0) { Write-Fail "$($p.table) does not exist in the target. Deploy the app (script 30) first."; $problems++; continue }
    $missing = @()
    $count = [int](Invoke-SqlQuery $conn "SELECT COUNT(*) AS n FROM [$schema].[$($p.table)]").Rows[0].n
    if ($count -gt 0) { Write-Fail "$($p.table) already has $count rows. The script only restores into empty tables (or use -SkipTables)."; $problems++ }
    if ($p.rows.Count -gt 0) {
      $missing = @($p.rows[0].PSObject.Properties.Name | Where-Object { $targetCols.COLUMN_NAME -notcontains $_ })
      if ($missing.Count) { Write-Fail "$($p.table): target lacks columns $($missing -join ', ')"; $problems++ }
    }
    if ($count -eq 0 -and $missing.Count -eq 0) { Write-Ok "$($p.table): empty, columns compatible" }
  }
  if ($problems -gt 0) { throw "$problems problem(s) found. Nothing was written." }
  if ($ResetUserBindings) { Write-Host '  AppMemberships.user_sub will be cleared so members re-bind by email on next sign-in.' }

  if (-not $Apply) {
    Write-Ok "Dry run complete: $(($plan | ForEach-Object { $_.rows.Count } | Measure-Object -Sum).Sum) rows would be inserted. Rerun with -Apply."
    return
  }
  if (-not $PSCmdlet.ShouldProcess("$($appCfg.sql.database)", 'Insert exported rows in one transaction')) { return }

  Write-Step 'Importing (one transaction)'
  $tx = $conn.BeginTransaction()
  try {
    foreach ($p in $plan) {
      $types = @{}
      foreach ($c in @($colInfo.Rows | Where-Object { $_.TABLE_NAME -eq $p.table })) { $types[$c.COLUMN_NAME] = $c.DATA_TYPE }
      foreach ($r in $p.rows) {
        $names = @($r.PSObject.Properties.Name)
        $cmd = $conn.CreateCommand()
        $cmd.Transaction = $tx
        $cmd.CommandTimeout = 120
        $cmd.CommandText = "INSERT INTO [$schema].[$($p.table)] ($((@($names | ForEach-Object { "[$_]" })) -join ', ')) VALUES ($((@(0..($names.Count - 1) | ForEach-Object { "@p$_" })) -join ', '))"
        for ($i = 0; $i -lt $names.Count; $i++) {
          $v = $r.($names[$i])
          if ($ResetUserBindings -and $p.table -eq 'AppMemberships' -and $names[$i] -eq 'user_sub') { $v = $null }
          if ($null -ne $v) {
            switch -Regex ($types[$names[$i]]) {
              '^uniqueidentifier$' { $v = [guid]$v }
              '^(datetime2|datetime|date)$' { if ($v -isnot [datetime]) { $v = [datetime]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } }
              '^int$' { $v = [int]$v }
              '^bigint$' { $v = [long]$v }
              '^bit$' { $v = [bool]$v }
            }
          }
          [void]$cmd.Parameters.AddWithValue("@p$i", $(if ($null -eq $v) { [DBNull]::Value } else { $v }))
        }
        [void]$cmd.ExecuteNonQuery()
      }
      Write-Ok "$($p.table): $($p.rows.Count) rows inserted"
    }
    $tx.Commit()
  } catch {
    $tx.Rollback()
    throw "Import failed and was rolled back; the target is unchanged. $($_.Exception.Message)"
  }

  Write-Step 'Verifying row counts'
  $bad = 0
  foreach ($p in $plan) {
    $count = [int](Invoke-SqlQuery $conn "SELECT COUNT(*) AS n FROM [$schema].[$($p.table)]").Rows[0].n
    if ($count -ne $p.rows.Count) { Write-Fail "$($p.table): $count rows (expected $($p.rows.Count))"; $bad++ } else { Write-Ok "$($p.table): $count rows" }
  }
  if ($bad -gt 0) { throw 'Row counts differ after import.' }
} finally { $conn.Close() }

$evidence = New-EvidenceFile "import-$Environment.json"
Write-JsonFile $evidence ([ordered]@{ atUtc = (Get-Date).ToUniversalTime().ToString('o'); exportPath = $ExportPath; sourceDatabase = $manifest.database; targetDatabase = $appCfg.sql.database; resetUserBindings = [bool]$ResetUserBindings; tables = @($plan | ForEach-Object { [ordered]@{ table = $_.table; rows = $_.rows.Count } }) })
Write-Ok "Import complete. Evidence: $evidence"
Write-Host 'Next: sign in as an app_admin or auditor and use Audit > Verify integrity; record the restore in the application register.'
