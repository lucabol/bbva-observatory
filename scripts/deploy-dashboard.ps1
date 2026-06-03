[CmdletBinding()]
param(
  [string]$AppName = "bbva-observatory",

  [string]$ResourceGroup = "bbva-observatory-rg",
  [string]$Location = "eastus",
  [string]$PlanName = "bbva-observatory-plan",
  [string]$Sku = "B1",
  [string]$Runtime = "NODE:22-lts",
  [string]$RuntimeDir = "/home/site/wwwroot/data/runtime",
  [string]$Port = "8080",
  [string]$SubscriptionId = "",
  [switch]$IncludeSampleData
)

$ErrorActionPreference = "Stop"

# This script uses Azure PowerShell (Az.* modules) rather than the Azure CLI.
# The Owner role on the target subscription is bound to the Azure PowerShell
# client application, so `az` tokens are rejected with AuthorizationFailed even
# when the role is active. The Az cmdlets authenticate as the matching app.

function Assert-AzModule {
  param([string]$Name)

  if (-not (Get-Module -ListAvailable -Name $Name)) {
    throw "Required PowerShell module '$Name' was not found. Install it with: Install-Module $Name -Scope CurrentUser"
  }
}

# Maps an App Service SKU (e.g. B1, S1, P1V3) to the Tier + WorkerSize that the
# Az PowerShell New-AzAppServicePlan cmdlet expects.
function Resolve-PlanTier {
  param([string]$SkuName)

  $tierByName = @{
    "F1" = "Free"
    "D1" = "Shared"
    "B1" = "Basic"; "B2" = "Basic"; "B3" = "Basic"
    "S1" = "Standard"; "S2" = "Standard"; "S3" = "Standard"
    "P1V2" = "PremiumV2"; "P2V2" = "PremiumV2"; "P3V2" = "PremiumV2"
    "P1V3" = "PremiumV3"; "P2V3" = "PremiumV3"; "P3V3" = "PremiumV3"
  }
  $sizeByDigit = @{ "1" = "Small"; "2" = "Medium"; "3" = "Large" }

  $key = $SkuName.ToUpper()
  $tier = $tierByName[$key]
  if (-not $tier) { $tier = "Basic" }

  $digits = ($SkuName -replace "[^0-9]", "")
  $size = if ($digits) { $sizeByDigit[$digits.Substring(0, 1)] } else { $null }
  if (-not $size) { $size = "Small" }

  return @{ Tier = $tier; WorkerSize = $size }
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

function Get-BasicPublishingPolicyAllow {
  param(
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$AppName,
    [string]$PolicyName
  )

  $Path = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName/basicPublishingCredentialsPolicies/${PolicyName}?api-version=2023-12-01"
  $Response = Invoke-AzRestMethod -Method GET -Path $Path
  if ($Response.StatusCode -ge 400) {
    throw "Failed to read $PolicyName publishing credential policy (HTTP $($Response.StatusCode)): $($Response.Content)"
  }

  return [bool](($Response.Content | ConvertFrom-Json).properties.allow)
}

function Set-BasicPublishingPolicyAllow {
  param(
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$AppName,
    [string]$PolicyName,
    [bool]$Allow
  )

  $Path = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName/basicPublishingCredentialsPolicies/${PolicyName}?api-version=2023-12-01"
  $Body = @{ properties = @{ allow = $Allow } } | ConvertTo-Json -Depth 5
  $Response = Invoke-AzRestMethod -Method PUT -Path $Path -Payload $Body
  if ($Response.StatusCode -ge 400) {
    throw "Failed to set $PolicyName publishing credential policy to '$Allow' (HTTP $($Response.StatusCode)): $($Response.Content)"
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "bbva-dashboard-deploy-$([System.Guid]::NewGuid().ToString('N'))"
$PackageRoot = Join-Path $TempRoot "package"
$ZipPath = Join-Path $TempRoot "dashboard.zip"

try {
  Assert-AzModule "Az.Accounts"
  Assert-AzModule "Az.Websites"
  Assert-AzModule "Az.Resources"

  $Context = Get-AzContext
  if (-not $Context) {
    throw "Not signed in to Azure PowerShell. Run Connect-AzAccount first."
  }

  if ($SubscriptionId) {
    Write-Host "> Set-AzContext -Subscription $SubscriptionId"
    Set-AzContext -Subscription $SubscriptionId | Out-Null
    $Context = Get-AzContext
  }

  $SubId = $Context.Subscription.Id
  Write-Host "Using subscription: $($Context.Subscription.Name) ($SubId)"

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

  Write-Host "> New-AzResourceGroup -Name $ResourceGroup -Location $Location"
  New-AzResourceGroup -Name $ResourceGroup -Location $Location -Force | Out-Null

  $ExistingPlan = Get-AzAppServicePlan -ResourceGroupName $ResourceGroup -Name $PlanName -ErrorAction SilentlyContinue
  if (-not $ExistingPlan) {
    $PlanTier = Resolve-PlanTier -SkuName $Sku
    Write-Host "> New-AzAppServicePlan -Name $PlanName -Tier $($PlanTier.Tier) -WorkerSize $($PlanTier.WorkerSize) -Linux"
    try {
      New-AzAppServicePlan `
        -ResourceGroupName $ResourceGroup `
        -Name $PlanName `
        -Location $Location `
        -Tier $PlanTier.Tier `
        -WorkerSize $PlanTier.WorkerSize `
        -Linux | Out-Null
    } catch {
      if ($_.Exception.Message -match "No available instances|not available in the location|capacity") {
        throw @"
Azure App Service capacity is temporarily unavailable for this plan request.

Fastest mitigations:
1. Retry in a nearby region:
   .\scripts\deploy-dashboard.ps1 -AppName '$AppName' -ResourceGroup '$ResourceGroup' -Location 'westus2' -PlanName '$PlanName' -Sku '$Sku'

2. Retry with a different SKU:
   .\scripts\deploy-dashboard.ps1 -AppName '$AppName' -ResourceGroup '$ResourceGroup' -Location '$Location' -PlanName '$PlanName' -Sku 'S1'

Original error:
$($_.Exception.Message)
"@
      }
      throw
    }
  } else {
    Write-Host "App Service plan '$PlanName' already exists in '$ResourceGroup'."
  }

  $ExistingApp = Get-AzWebApp -ResourceGroupName $ResourceGroup -Name $AppName -ErrorAction SilentlyContinue
  if (-not $ExistingApp) {
    Write-Host "> New-AzWebApp -Name $AppName -AppServicePlan $PlanName"
    New-AzWebApp `
      -ResourceGroupName $ResourceGroup `
      -Name $AppName `
      -Location $Location `
      -AppServicePlan $PlanName | Out-Null
  } else {
    Write-Host "Web app '$AppName' already exists in '$ResourceGroup'."
  }

  $IncludeSampleDataValue = if ($IncludeSampleData) { "true" } else { "false" }
  $AppSettings = @{
    "PORT"                = $Port
    "WEBSITES_PORT"       = $Port
    "INCLUDE_SAMPLE_DATA" = $IncludeSampleDataValue
    "RUNTIME_DIR"         = $RuntimeDir
  }

  Write-Host "> Set-AzWebApp -AppSettings (PORT, WEBSITES_PORT, INCLUDE_SAMPLE_DATA, RUNTIME_DIR)"
  Set-AzWebApp `
    -ResourceGroupName $ResourceGroup `
    -Name $AppName `
    -AppSettings $AppSettings | Out-Null

  # New-AzWebApp / Set-AzWebApp cannot set the Linux runtime stack or the startup
  # command, so patch the site config directly. "NODE:22-lts" -> "NODE|22-lts".
  $LinuxFxVersion = $Runtime -replace ":", "|"
  $ConfigPath = "/subscriptions/$SubId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName/config/web?api-version=2023-12-01"
  $ConfigBody = @{
    properties = @{
      linuxFxVersion = $LinuxFxVersion
      appCommandLine = "npm start"
    }
  } | ConvertTo-Json -Depth 5

  Write-Host "> PATCH site config (linuxFxVersion=$LinuxFxVersion, appCommandLine='npm start')"
  $ConfigResponse = Invoke-AzRestMethod -Method PATCH -Path $ConfigPath -Payload $ConfigBody
  if ($ConfigResponse.StatusCode -ge 400) {
    throw "Failed to set site configuration (HTTP $($ConfigResponse.StatusCode)): $($ConfigResponse.Content)"
  }

  $OriginalScmBasicPublishingAllowed = Get-BasicPublishingPolicyAllow `
    -SubscriptionId $SubId `
    -ResourceGroup $ResourceGroup `
    -AppName $AppName `
    -PolicyName "scm"

  try {
    if (-not $OriginalScmBasicPublishingAllowed) {
      Write-Host "> Temporarily enabling SCM basic publishing credentials for zip deployment"
      Set-BasicPublishingPolicyAllow `
        -SubscriptionId $SubId `
        -ResourceGroup $ResourceGroup `
        -AppName $AppName `
        -PolicyName "scm" `
        -Allow $true
    }

    Write-Host "> Publish-AzWebApp -ArchivePath $ZipPath"
    Publish-AzWebApp `
      -ResourceGroupName $ResourceGroup `
      -Name $AppName `
      -ArchivePath $ZipPath `
      -Force | Out-Null
  } finally {
    if (-not $OriginalScmBasicPublishingAllowed) {
      Write-Host "> Restoring SCM basic publishing credentials policy to disabled"
      Set-BasicPublishingPolicyAllow `
        -SubscriptionId $SubId `
        -ResourceGroup $ResourceGroup `
        -AppName $AppName `
        -PolicyName "scm" `
        -Allow $false
    }
  }

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