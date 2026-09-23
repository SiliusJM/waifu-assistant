[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('omniroute', 'groq', 'gemini', 'openrouter')][string] $Profile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'provider-credentials.psm1') -Force

try {
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  $exitCode = Invoke-YukiProviderProfile -Profile $Profile -Starter {
    param($environment, $selectedProfile)
    Start-YukiInteractiveProcess -Environment $environment -RepositoryRoot $repositoryRoot
  }
  exit ([int]$exitCode)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
