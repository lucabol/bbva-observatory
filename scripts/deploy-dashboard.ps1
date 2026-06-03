[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [string]$ResourceGroup = "bbva-observatory-rg",
  [string]$Location = "westeurope",
  [string]$PlanName = "bbva-observatory-plan",
  [string]$Sku = "B1",
  [string]$Runtime = "NODE:22-lts",
  [string]$RuntimeDir = "/home/site/wwwroot/data/runtime",
  [string]$Port = "8080",
  [string]$SubscriptionId = "",
  [switch]$IncludeSampleData
)

$ErrorActionPreference = "Stop"

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found. Install it and retry."
  }
}

function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  Write-Host "> az $($Arguments -join ' ')"
  $Output = & az @Arguments 2>&1
  $ExitCode = $LASTEXITCODE
  $Output | ForEach-Object { Write-Host $_ }

  if ($ExitCode -ne 0) {
    $OutputText = $Output | Out-String
    if ($OutputText -match "No available instances to satisfy this request") {
      $NewResourceGroup = "$ResourceGroup-$((Get-Date).ToString('yyyyMMddHHmmss'))"
      throw @"
Azure App Service capacity is temporarily unavailable for this plan request.

Fastest mitigations:
1. Retry with a new resource group:
   .\scripts\deploy-dashboard.ps1 -AppName '$AppName' -ResourceGroup '$NewResourceGroup' -Location '$Location' -PlanName '$PlanName' -Sku '$Sku'

2. Retry in a nearby region:
   .\scripts\deploy-dashboard.ps1 -AppName '$AppName' -ResourceGroup '$ResourceGroup' -Location 'northeurope' -PlanName '$PlanName' -Sku '$Sku'

Original Azure CLI output:
$OutputText
"@
    }

    throw "Azure CLI command failed: az $($Arguments -join ' ')"
  }
}

function Copy-IfExists {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (Test-Path $Source) {
    Copy-Item -Path $Source -Destination $Destination -Recurse -Force
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "bbva-dashboard-deploy-$([System.Guid]::NewGuid().ToString('N'))"
$PackageRoot = Join-Path $TempRoot "package"
$ZipPath = Join-Path $TempRoot "dashboard.zip"

try {
  Assert-Command "az"

  if ($SubscriptionId) {
    Invoke-Az account set --subscription $SubscriptionId
  }

  New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

  Push-Location $RepoRoot
  try {
    Copy-IfExists "package.json" $PackageRoot
    Copy-IfExists "README.md" $PackageRoot
    Copy-IfExists "src" $PackageRoot
    Copy-IfExists "public" $PackageRoot
    Copy-IfExists "scripts" $PackageRoot
    Copy-IfExists ".github" $PackageRoot

    New-Item -ItemType Directory -Path (Join-Path $PackageRoot "data") -Force | Out-Null
    Copy-IfExists (Join-Path "data" "sample") (Join-Path $PackageRoot "data")
  } finally {
    Pop-Location
  }

  Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -Force

  Invoke-Az group create --name $ResourceGroup --location $Location

  Invoke-Az appservice plan create `
    --name $PlanName `
    --resource-group $ResourceGroup `
    --sku $Sku `
    --is-linux

  $ExistingApp = az webapp show --name $AppName --resource-group $ResourceGroup --query name -o tsv 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $ExistingApp) {
    Invoke-Az webapp create `
      --name $AppName `
      --resource-group $ResourceGroup `
      --plan $PlanName `
      --runtime $Runtime
  } else {
    Write-Host "Web app '$AppName' already exists in '$ResourceGroup'."
  }

  $IncludeSampleDataValue = if ($IncludeSampleData) { "true" } else { "false" }
  $AppSettings = @(
    "PORT=$Port",
    "WEBSITES_PORT=$Port",
    "INCLUDE_SAMPLE_DATA=$IncludeSampleDataValue",
    "RUNTIME_DIR=$RuntimeDir"
  )

  Invoke-Az webapp config appsettings set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --settings @AppSettings

  Invoke-Az webapp config set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --startup-file "npm start"

  Invoke-Az webapp deployment source config-zip `
    --name $AppName `
    --resource-group $ResourceGroup `
    --src $ZipPath

  $BaseUrl = "https://$AppName.azurewebsites.net"
  Write-Host ""
  Write-Host "Dashboard deployed: $BaseUrl"
  Write-Host "Health check:        $BaseUrl/api/health"
  Write-Host "Trace endpoint:      $BaseUrl/otel/v1/traces"
  Write-Host ""
  Write-Host "Set OTEL_TRACE_URL in the cloud agent or VS Code agent hook to:"
  Write-Host "$BaseUrl/otel/v1/traces"
} finally {
  if (Test-Path $TempRoot) {
    Remove-Item -Path $TempRoot -Recurse -Force
  }
}