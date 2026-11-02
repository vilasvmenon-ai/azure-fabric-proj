<#
.SYNOPSIS
  Step 31 - Look up the app's Rayfin-managed SQL database coordinates and store them in config (generated values).

.DESCRIPTION
  Read-only Fabric REST lookup, as documented in the Rayfin guide (functions/connections/get-fabric-info.md):
  lists SQLDatabase items in the workspace and reads properties.serverFqdn and properties.databaseName.
  Rayfin creates the database as a child of the Fabric App item; its display name is not documented,
  so the script selects the database whose name contains the app item name, or asks you to pass -SqlDatabaseItemId.

.EXAMPLE
  .\scripts\31-Resolve-AppDatabase.ps1 -App ars
  .\scripts\31-Resolve-AppDatabase.ps1 -App ars -SqlDatabaseItemId 00000000-0000-0000-0000-000000000000
#>
[CmdletBinding()]
param(
  [ValidateSet('ars')][string]$App = 'ars',
  [string]$Environment = 'dev',
  [string]$SqlDatabaseItemId
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg $App
$tenant = $cfg.org.tenantId
$ws = $cfg.fabric.workspaceId

Write-Step 'SQL databases in the workspace'
$dbs = @((Invoke-FabricGet "workspaces/$ws/items?type=SQLDatabase" $tenant).value)
$dbs | ForEach-Object { Write-Host "  - $($_.displayName)  ($($_.id))" }

if ($SqlDatabaseItemId) {
  $pick = @($dbs | Where-Object { $_.id -eq $SqlDatabaseItemId })
} else {
  $pick = @($dbs | Where-Object { $_.displayName -like "*$($appCfg.itemName)*" })
  if ($pick.Count -eq 0) {
    $short = (Get-Content (Join-Path (Get-AppDirectory $cfg $App) 'rayfin\rayfin.yml') | Select-String '^id:\s*(.+)$').Matches[0].Groups[1].Value.Trim()
    $pick = @($dbs | Where-Object { $_.displayName -like "*$short*" })
  }
}
if ($pick.Count -ne 1) {
  throw "Could not identify exactly one SQL database for $($appCfg.itemName) (found $($pick.Count)). Open the Fabric App item in the portal, select its SQL database child item, copy its item id from the URL, and rerun with -SqlDatabaseItemId."
}

Write-Step "Reading coordinates of $($pick[0].displayName)"
$db = Invoke-FabricGet "workspaces/$ws/sqlDatabases/$($pick[0].id)" $tenant
if (-not $db.properties.serverFqdn -or -not $db.properties.databaseName) { throw 'The SQL database did not return serverFqdn/databaseName.' }
$appCfg.sql.server = $db.properties.serverFqdn
$appCfg.sql.database = $db.properties.databaseName
$appCfg.sql.sqlDatabaseItemId = $pick[0].id
Save-IonovaConfig $cfg $Environment
Write-Ok "server=$($appCfg.sql.server) database=$($appCfg.sql.database) (saved to config\ionova.$Environment.json)"
Write-Host "`nThe app identity (item owner) needs access to this database. As the item owner it normally has it; verify with scripts\51-Test-AppSchema.ps1."
Write-Host 'Next: scripts\32-Set-RuntimeConfig.ps1 -App ars'
