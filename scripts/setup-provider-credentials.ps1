[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('omniroute', 'groq', 'gemini', 'openrouter')][string] $Profile,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'provider-credentials.psm1') -Force

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows credential bootstrap is supported only on Windows.'
  }
  $path = Get-YukiCredentialPath -Profile $Profile
  if ((Test-Path -LiteralPath $path -PathType Leaf) -and -not $Force) {
    Write-Host "Credential for '$Profile' already exists and was kept. Re-run with -Force to replace this profile only."
    exit 0
  }

  $credential = Get-Credential -Message "Enter the $Profile API key in the Password field. The username is only a label."
  if ($null -eq $credential) { Write-Host 'Credential setup cancelled; no files changed.'; exit 0 }
  $savedPath = Save-YukiProviderCredential -Profile $Profile -Credential $credential -Force:$Force
  Write-Host "Windows-protected credential saved for '$Profile' outside the repository."
  $credential = $null
  $savedPath = $null
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
