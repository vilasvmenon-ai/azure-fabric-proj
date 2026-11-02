# Shared helpers for the ioNova AI Lab setup and deployment scripts.
# Windows PowerShell 5.1 compatible. ASCII only (PS 5.1 reads BOM-less files as ANSI).
#
# Rules followed by every script:
#  - stop on the first error ($ErrorActionPreference = 'Stop', native exit codes checked)
#  - read explicit IDs from config/ionova.<env>.json; never guess
#  - read-only checks before changes; -WhatIf / dry-run where the tool supports it
#  - never print tokens; never write credentials to disk

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Get-RepoRoot { $script:RepoRoot }

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "  [FAIL] $Message" -ForegroundColor Red }

function Update-SessionPath {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-ConfigPath([string]$Environment) {
  Join-Path (Get-RepoRoot) "config\ionova.$Environment.json"
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { throw "File not found: $Path" }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  return [System.IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Object) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 20), $utf8)
}

function Read-IonovaConfig([string]$Environment = 'dev') {
  $path = Get-ConfigPath $Environment
  if (-not (Test-Path $path)) {
    throw "Missing $path. Copy config\ionova.dev.example.json to config\ionova.$Environment.json and fill in the values (docs\MANUAL-STEPS.md M-09)."
  }
  $cfg = Read-JsonFile $path
  if ($cfg.environment -ne $Environment) { throw "config environment '$($cfg.environment)' does not match -Environment '$Environment'." }
  return $cfg
}

function Save-IonovaConfig($Config, [string]$Environment = 'dev') {
  Write-JsonFile (Get-ConfigPath $Environment) $Config
}

# Returns the list of property paths that still hold a <placeholder> (or GENERATED, when -IncludeGenerated).
function Find-Placeholders($Object, [string]$Prefix = '', [switch]$IncludeGenerated) {
  $found = @()
  if ($null -eq $Object) { return $found }
  if ($Object -is [string]) {
    if ($Object -match '<[^>]+>' -or ($IncludeGenerated -and $Object -like 'GENERATED*')) { $found += $Prefix }
    return $found
  }
  if ($Object -is [System.Array]) {
    for ($i = 0; $i -lt $Object.Count; $i++) { $found += Find-Placeholders $Object[$i] "$Prefix[$i]" -IncludeGenerated:$IncludeGenerated }
    return $found
  }
  if ($Object -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $Object.PSObject.Properties) {
      if ($p.Name -like '$*') { continue }
      $found += Find-Placeholders $p.Value ($(if ($Prefix) { "$Prefix.$($p.Name)" } else { $p.Name })) -IncludeGenerated:$IncludeGenerated
    }
  }
  return $found
}

function Assert-NoPlaceholders($Object, [string]$What, [switch]$IncludeGenerated) {
  $missing = @(Find-Placeholders $Object -IncludeGenerated:$IncludeGenerated)
  if ($missing.Count -gt 0) {
    throw "$What still has placeholder values: $($missing -join ', ')"
  }
}

function Assert-Guid([string]$Value, [string]$Name) {
  $g = [Guid]::Empty
  if (-not [Guid]::TryParse($Value, [ref]$g)) { throw "$Name must be a GUID (got '$Value')." }
}

function Get-AppConfig($Config, [string]$App) {
  $a = $Config.apps.PSObject.Properties[$App]
  if (-not $a) { throw "Unknown app '$App'. Known: $(@($Config.apps.PSObject.Properties.Name) -join ', ')" }
  return $a.Value
}

function Get-AppDirectory($Config, [string]$App) {
  $dir = Join-Path (Get-RepoRoot) (Get-AppConfig $Config $App).path
  if (-not (Test-Path (Join-Path $dir 'rayfin\rayfin.yml'))) { throw "No Rayfin project at $dir" }
  return $dir
}

# Run a native command; throw on non-zero exit. Arguments are passed as an array (no string concatenation).
# Success is judged ONLY by the exit code: in Windows PowerShell 5.1, with $ErrorActionPreference = 'Stop',
# any stderr text from a native tool (for example "npm warn deprecated ...") would otherwise be treated as a
# terminating error. Stderr lines are still shown.
function Invoke-Native([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $null, [switch]$CaptureOutput) {
  $old = Get-Location
  $prevEap = $ErrorActionPreference
  try {
    if ($WorkingDirectory) { Set-Location $WorkingDirectory }
    $ErrorActionPreference = 'Continue'
    if ($CaptureOutput) {
      $out = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
      $code = $LASTEXITCODE
      $ErrorActionPreference = $prevEap
      if ($code -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $code`n$($out -join "`n")" }
      return ($out -join "`n")
    }
    & $File @Arguments 2>&1 | ForEach-Object { Write-Host "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($code -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $code" }
  } finally {
    $ErrorActionPreference = $prevEap
    Set-Location $old
  }
}

# Run a native command and write $InputText to its standard input as UTF-8 WITHOUT a byte-order mark.
# Windows PowerShell 5.1 prefixes EF BB BF when piping text to native programs (even with $OutputEncoding set),
# which corrupts values passed to `rayfin secret set --stdin`. Nothing is written to disk; output is not echoed
# unless -ShowOutput (so secrets are never displayed). Returns the exit code.
function Invoke-NativeWithStdin([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [string]$InputText, [switch]$ShowOutput) {
  # Use the full path: batch shims such as npx.cmd locate their own files via %~dp0, which is wrong when
  # cmd.exe is given only the bare name.
  $resolved = (Get-Command $File -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $File = $resolved
  $quoted = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /c `"`"$File`" $quoted`""
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # .NET Framework builds the child's stdin writer from [Console]::InputEncoding and writes its preamble (BOM)
  # immediately, so use a BOM-less UTF-8 console input encoding while starting the process.
  $prevIn = [Console]::InputEncoding
  try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $p = [System.Diagnostics.Process]::Start($psi)
  } finally {
    [Console]::InputEncoding = $prevIn
  }
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($InputText)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.BaseStream.Flush()
  $p.StandardInput.Close()
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit()
  if ($ShowOutput) { foreach ($l in (($stdout.Result + $stderr.Result) -split "`r?`n")) { if ($l.Trim()) { Write-Host "  $l" } } }
  return $p.ExitCode
}

# Run the project-pinned Rayfin CLI (node_modules) inside an app directory.
function Invoke-Rayfin([string]$AppDirectory, [string[]]$Arguments, [switch]$CaptureOutput) {
  $env:RAYFIN_TELEMETRY_OPTOUT = '1'
  Invoke-Native 'npx.cmd' (@('--no-install', 'rayfin') + $Arguments) $AppDirectory -CaptureOutput:$CaptureOutput
}

function Get-RayfinStatus([string]$AppDirectory) {
  $raw = Invoke-Rayfin $AppDirectory @('up', 'status', '--json') -CaptureOutput
  $start = $raw.IndexOf('{')
  if ($start -lt 0) { throw "rayfin up status did not return JSON:`n$raw" }
  return $raw.Substring($start) | ConvertFrom-Json
}

# Find a property anywhere in a nested object (rayfin status JSON shape is not fully documented).
function Find-JsonValue($Object, [string[]]$Names) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Management.Automation.PSCustomObject]) {
    foreach ($n in $Names) {
      $p = $Object.PSObject.Properties[$n]
      if ($p -and $p.Value -and ($p.Value -is [string] -or $p.Value -is [ValueType])) { return $p.Value }
    }
    foreach ($p in $Object.PSObject.Properties) {
      $v = Find-JsonValue $p.Value $Names
      if ($v) { return $v }
    }
  } elseif ($Object -is [System.Array]) {
    foreach ($i in $Object) { $v = Find-JsonValue $i $Names; if ($v) { return $v } }
  }
  return $null
}

# Azure CLI access token for a resource (read into memory only; never printed).
function Get-AzToken([string]$Resource, [string]$TenantId) {
  $args2 = @('account', 'get-access-token', '--resource', $Resource, '--query', 'accessToken', '-o', 'tsv')
  if ($TenantId) { $args2 += @('--tenant', $TenantId) }
  $token = (Invoke-Native 'az.cmd' $args2 -CaptureOutput).Trim()
  if (-not $token) { throw "Could not get an access token for $Resource. Run scripts\10-Connect-Tenant.ps1." }
  return $token
}

# Read-only Fabric REST call (GET) used for coordinates and readiness checks, as the Rayfin guide recommends.
function Invoke-FabricGet([string]$RelativePath, [string]$TenantId) {
  $token = Get-AzToken 'https://api.fabric.microsoft.com' $TenantId
  $uri = "https://api.fabric.microsoft.com/v1/$RelativePath"
  return Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 60
}

# Open a SQL connection to a Fabric SQL database with the signed-in admin's Entra token (.NET Framework SqlClient).
function Open-FabricSqlConnection([string]$Server, [string]$Database, [string]$TenantId) {
  $token = Get-AzToken 'https://database.windows.net/' $TenantId
  $host1, $port = $Server.Split(',')
  if (-not $port) { $port = '1433' }
  $cs = "Server=tcp:$host1,$port;Initial Catalog=$Database;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;"
  $conn = New-Object System.Data.SqlClient.SqlConnection($cs)
  $conn.AccessToken = $token
  $conn.Open()
  return $conn
}

function Invoke-SqlQuery($Connection, [string]$Query, [hashtable]$Parameters = @{}) {
  $cmd = $Connection.CreateCommand()
  $cmd.CommandText = $Query
  $cmd.CommandTimeout = 120
  foreach ($k in $Parameters.Keys) { [void]$cmd.Parameters.AddWithValue("@$k", $Parameters[$k]) }
  $table = New-Object System.Data.DataTable
  $reader = $cmd.ExecuteReader()
  try { $table.Load($reader) } finally { $reader.Close() }
  return ,$table
}

function Get-FileSha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function New-EvidenceFile([string]$Name) {
  $dir = Join-Path (Get-RepoRoot) 'evidence'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  return Join-Path $dir "$stamp-$Name"
}

Export-ModuleMember -Function *
