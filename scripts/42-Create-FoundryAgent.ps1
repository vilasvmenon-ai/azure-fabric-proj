<#
.SYNOPSIS
  Step 42 (NEW environments only) - Create the address-structuring prompt agent in a NEW Foundry project.

.DESCRIPTION
  For a team building its own environment from this repository. Creates the agent defined in foundry\agent\
  (agent.json + address-structuring-lab.instructions.txt, exported read-only from the ioNova dev agent) in the
  Foundry project configured in config\ionova.<env>.json, using the Foundry Agents REST API (api-version v1).

  Safety:
   - REFUSES to do anything if an agent with that name already exists in the target project (it never updates,
     versions, replaces or deletes an agent). The original ioNova agent can therefore never be changed by this script.
   - Checks that the model deployment named in foundry.modelDeployment exists before creating the agent.
   - Supports -WhatIf; asks for confirmation otherwise.
  Requirements: Azure CLI signed in to the Foundry tenant; "Foundry User" (or higher) on the target project;
  a model deployment (default gpt-5-mini) already created in the Foundry resource (docs\SETUP-NEW-ENVIRONMENT.md).

.EXAMPLE
  .\scripts\42-Create-FoundryAgent.ps1 -Environment dev -WhatIf
  .\scripts\42-Create-FoundryAgent.ps1 -Environment dev
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$f = $cfg.foundry
Assert-Guid $f.subscriptionId 'foundry.subscriptionId'
$agentDir = Join-Path (Get-RepoRoot) 'foundry\agent'
$meta = Read-JsonFile (Join-Path $agentDir 'agent.json')
$utf8 = New-Object System.Text.UTF8Encoding($false)
# Normalise to LF (the exported agent instructions use LF; a Windows checkout may convert them to CRLF).
$instructions = [IO.File]::ReadAllText((Join-Path $agentDir $meta.instructionsFile), $utf8).Replace("`r`n", "`n")
$sha = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($utf8.GetBytes($instructions))) -replace '-', '').ToLowerInvariant()
if ($sha -ne $meta.instructionsSha256) { throw "Instructions file does not match agent.json (sha256 $sha). Restore it from Git." }
$agentName = $f.agentName
$modelDeployment = if ($f.PSObject.Properties['modelDeployment'] -and $f.modelDeployment) { $f.modelDeployment } else { $meta.modelDeployment }
$endpoint = $f.projectEndpoint.TrimEnd('/')
if ($f.projectResourceId -notmatch '/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.CognitiveServices/accounts/([^/]+)/projects/([^/]+)$') { throw 'foundry.projectResourceId is not a Foundry project resource id.' }
$rg = $Matches[2]; $account = $Matches[3]

Write-Step "Target: agent '$agentName' in $endpoint"
$token = (Invoke-Native 'az.cmd' @('account', 'get-access-token', '--resource', 'https://ai.azure.com', '--subscription', $f.subscriptionId, '--query', 'accessToken', '-o', 'tsv') -CaptureOutput).Trim()
$headers = @{ Authorization = "Bearer $token" }

# 1. Refuse if the agent already exists.
$exists = $false
try {
  $existing = Invoke-RestMethod -Method Get -Uri "$endpoint/agents/$([uri]::EscapeDataString($agentName))?api-version=v1" -Headers $headers -TimeoutSec 60
  $exists = [bool]$existing
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  if ($code -ne 404) { throw "Could not check for an existing agent (HTTP $code). Check sign-in and your role on the project." }
}
if ($exists) {
  Write-Ok "Agent '$agentName' already exists (latest version $($existing.versions.latest.version)). Nothing to do - this script never modifies an existing agent."
  return
}
Write-Ok "No agent named '$agentName' exists yet."

# 2. The model deployment must exist.
$deps = (Invoke-Native 'az.cmd' @('cognitiveservices', 'account', 'deployment', 'list', '--name', $account, '--resource-group', $rg, '--subscription', $f.subscriptionId, '--query', '[].name', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
if ($deps -notcontains $modelDeployment) { throw "Model deployment '$modelDeployment' not found in $account (found: $($deps -join ', ')). Create it first (docs\SETUP-NEW-ENVIRONMENT.md, step F3)." }
Write-Ok "Model deployment '$modelDeployment' exists."

# 3. Create.
$body = @{ name = $agentName; definition = @{ kind = $meta.kind; model = $modelDeployment; instructions = $instructions } } | ConvertTo-Json -Depth 5
if ($PSCmdlet.ShouldProcess("$agentName in $endpoint", "Create prompt agent (model $modelDeployment)")) {
  $created = Invoke-RestMethod -Method Post -Uri "$endpoint/agents?api-version=v1" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120
  $check = Invoke-RestMethod -Method Get -Uri "$endpoint/agents/$([uri]::EscapeDataString($agentName))?api-version=v1" -Headers $headers -TimeoutSec 60
  $got = ([string]$check.versions.latest.definition.instructions).Replace("`r`n", "`n")
  if ($got.Trim() -ne $instructions.Trim()) { Write-Warn2 'Created, but the stored instructions differ from the file. Inspect the agent in the Foundry portal.' }
  else { Write-Ok "Created agent '$agentName' version $($check.versions.latest.version) with model '$modelDeployment'; instructions verified." }
  $evidence = New-EvidenceFile "foundry-agent-created-$Environment.json"
  Write-JsonFile $evidence ([ordered]@{ atUtc = (Get-Date).ToUniversalTime().ToString('o'); endpoint = $endpoint; agent = $agentName; version = $check.versions.latest.version; model = $modelDeployment; instructionsSha256 = $sha })
  Write-Host "Evidence: $evidence. Set foundry.agentVersionLabel to $($check.versions.latest.version) in config, then continue with script 30."
}
