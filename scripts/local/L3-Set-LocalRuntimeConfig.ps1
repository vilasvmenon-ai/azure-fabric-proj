<#
.SYNOPSIS
  Local step L3 - Point the local Functions host at the Docker SQL container and the existing Foundry agent.

.DESCRIPTION
  Run while L2 is running. Reads `rayfin dev --export-env` (the Docker provider's environment), finds the SQL
  container port, login and password (values are never printed), finds the app database by looking for the
  AddressRequest table, and writes two entries into the git-ignored apps\ars\packages\functions\local.settings.json:
    IONOVA_RUNTIME_CONFIG      - same JSON shape as deployed, with environment "local" and sql.auth "sqlLogin"
    IONOVA_LOCAL_SQL_PASSWORD  - the local container password (local only; config.ts rejects sqlLogin elsewhere)
  The export-env variable names are not documented; if detection is ambiguous the script lists the variable
  NAMES and asks you to pass -PortVariable / -UserVariable / -PasswordVariable.

.EXAMPLE
  .\scripts\local\L3-Set-LocalRuntimeConfig.ps1
  .\scripts\local\L3-Set-LocalRuntimeConfig.ps1 -PortVariable MSSQL_PORT -PasswordVariable MSSQL_SA_PASSWORD
#>
[CmdletBinding()]
param(
  [string]$PortVariable,
  [string]$UserVariable,
  [string]$PasswordVariable,
  [string]$Database
)

Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'IonovaDeploy.psm1') -Force
Update-SessionPath
$root = Get-RepoRoot
$cfg = Read-JsonFile (Join-Path $root 'config\ionova.local.json')
Assert-NoPlaceholders $cfg 'config\ionova.local.json'
$ars = Join-Path $root 'apps\ars'
$env:RAYFIN_FEATURE_FLAGS = 'docker-local-dev'

Write-Step 'Reading the Docker provider environment (rayfin dev --export-env)'
$raw = Invoke-Rayfin $ars @('dev', '--export-env') -CaptureOutput
$vars = @{}
foreach ($line in ($raw -split "`r?`n")) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
}
if (-not $vars.Count) { throw 'No variables returned. Is L2 running and healthy? (npx rayfin dev status)' }
Write-Host "  Variables found (names only): $(@($vars.Keys | Sort-Object) -join ', ')"

function Pick([string]$Explicit, [string]$Pattern, [string]$What) {
  if ($Explicit) { if (-not $vars.ContainsKey($Explicit)) { throw "Variable $Explicit not found." }; return $vars[$Explicit] }
  $keys = @($vars.Keys | Where-Object { $_ -match $Pattern })
  if ($keys.Count -eq 1) { return $vars[$keys[0]] }
  throw "Could not identify the SQL $What variable (candidates: $($keys -join ', ')). Rerun with -$($What)Variable <NAME>."
}
$port = Pick $PortVariable '(?i)(mssql|sql|db).*port' 'Port'
$user = if ($UserVariable) { Pick $UserVariable '' 'User' } else { $u = @($vars.Keys | Where-Object { $_ -match '(?i)(mssql|sql|db).*user' }); if ($u.Count -eq 1) { $vars[$u[0]] } else { 'sa' } }
$password = Pick $PasswordVariable '(?i)(mssql|sql|db|sa).*pass' 'Password'
if (-not ($port -as [int])) { throw "SQL port '$port' is not a number." }

Write-Step "Finding the app database on localhost,$port (login $user)"
$cs = "Server=tcp:localhost,$port;User ID=$user;Password=$password;Encrypt=True;TrustServerCertificate=True;Connection Timeout=15;"
$conn = New-Object System.Data.SqlClient.SqlConnection($cs)
$conn.Open()
try {
  if (-not $Database) {
    $dbs = Invoke-SqlQuery $conn 'SELECT name FROM sys.databases WHERE database_id > 4'
    $found = @()
    foreach ($r in $dbs.Rows) {
      $n = $r.name -replace ']', ']]'
      $hit = Invoke-SqlQuery $conn "SELECT COUNT(*) AS c FROM [$n].INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'AddressRequest'"
      if ($hit.Rows[0].c -gt 0) { $found += $r.name }
    }
    if ($found.Count -ne 1) { throw "Expected one database containing AddressRequest, found $($found.Count) ($($found -join ', ')). Has Rayfin applied the schema? Rerun with -Database <name>." }
    $Database = $found[0]
  }
} finally { $conn.Close() }
Write-Ok "App database: $Database"

$runtime = [ordered]@{
  orgId = $cfg.org.code; projectId = $cfg.project.code; appId = $cfg.app.appId; appName = $cfg.app.appName
  environment = 'local'; release = $cfg.app.release; ownerEmail = @($cfg.app.bootstrapAdminEmails)[0].ToLowerInvariant()
  foundry = [ordered]@{
    projectEndpoint = $cfg.foundry.projectEndpoint; agentName = $cfg.foundry.agentName; agentVersionLabel = $cfg.foundry.agentVersionLabel
    apiVersion = $cfg.foundry.apiVersion; timeoutMs = [int]$cfg.foundry.timeoutMs; maxRetries = [int]$cfg.foundry.maxRetries; totalBudgetMs = [int]$cfg.foundry.totalBudgetMs
  }
  sql = [ordered]@{ server = 'localhost'; port = [int]$port; database = $Database; schema = 'dbo'; auth = 'sqlLogin'; user = $user; trustServerCertificate = $true }
  bootstrapAdminEmails = @($cfg.app.bootstrapAdminEmails | ForEach-Object { $_.ToLowerInvariant() })
  faultInjection = $cfg.app.faultInjection
}

$settingsPath = Join-Path $ars 'packages\functions\local.settings.json'
$settings = if (Test-Path $settingsPath) { Read-JsonFile $settingsPath } else { [pscustomobject]@{ IsEncrypted = $false; Values = [pscustomobject]@{} } }
if (-not $settings.PSObject.Properties['Values']) { $settings | Add-Member -NotePropertyName Values -NotePropertyValue ([pscustomobject]@{}) }
$settings.Values | Add-Member -NotePropertyName IONOVA_RUNTIME_CONFIG -NotePropertyValue ($runtime | ConvertTo-Json -Depth 5 -Compress) -Force
$settings.Values | Add-Member -NotePropertyName IONOVA_LOCAL_SQL_PASSWORD -NotePropertyValue $password -Force
Write-JsonFile $settingsPath $settings
Write-Ok "Updated $settingsPath (git-ignored; password value not displayed)"
Write-Host "`nNow stop L2 (Ctrl+C) and start it again so the Functions host loads these settings."
Write-Host 'Then follow docs\LOCAL-TESTING.md "Test checklist".'
