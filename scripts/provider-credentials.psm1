Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProviderCredentialProfiles = @{
  omniroute = @{ CredentialRelativePath = 'omniroute-credential.xml'; CredentialEnvName = 'OMNIROUTE_API_KEY'; ModelEnvName = 'OMNIROUTE_MODEL' }
  groq      = @{ CredentialRelativePath = 'providers/groq-credential.xml'; CredentialEnvName = 'GROQ_API_KEY'; ModelEnvName = 'GROQ_MODEL' }
  gemini    = @{ CredentialRelativePath = 'providers/gemini-credential.xml'; CredentialEnvName = 'GEMINI_API_KEY'; ModelEnvName = 'GEMINI_MODEL' }
  openrouter = @{ CredentialRelativePath = 'providers/openrouter-credential.xml'; CredentialEnvName = 'OPENROUTER_API_KEY'; ModelEnvName = 'OPENROUTER_MODEL' }
}

$script:CredentialEnvironmentNames = @(
  'AI_API_KEY', 'OMNIROUTE_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'
)

function Get-YukiProviderProfile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string] $Profile)

  $normalized = $Profile.Trim().ToLowerInvariant()
  if (-not $script:ProviderCredentialProfiles.ContainsKey($normalized)) {
    throw "Unknown provider profile '$Profile'. Choose omniroute, groq, gemini or openrouter."
  }
  return [pscustomobject]@{
    Id = $normalized
    CredentialRelativePath = $script:ProviderCredentialProfiles[$normalized].CredentialRelativePath
    CredentialEnvName = $script:ProviderCredentialProfiles[$normalized].CredentialEnvName
    ModelEnvName = $script:ProviderCredentialProfiles[$normalized].ModelEnvName
  }
}

function Get-YukiCredentialRoot {
  [CmdletBinding()]
  param([string] $RootPath)

  if ($RootPath) { return [IO.Path]::GetFullPath($RootPath) }
  if (-not $env:APPDATA) { throw 'APPDATA is not available; cannot resolve the Windows credential directory.' }
  return [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'WaifuAssistant'))
}

function Get-YukiCredentialPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Profile,
    [string] $RootPath
  )

  $profileInfo = Get-YukiProviderProfile -Profile $Profile
  $root = Get-YukiCredentialRoot -RootPath $RootPath
  $path = [IO.Path]::GetFullPath((Join-Path $root ($profileInfo.CredentialRelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)))
  $rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved credential path is outside the credential directory.'
  }
  return $path
}

function Save-YukiProviderCredential {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Profile,
    [Parameter(Mandatory)][PSCredential] $Credential,
    [string] $RootPath,
    [switch] $Force
  )

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows credential bootstrap is supported only on Windows.'
  }
  if ($Credential.Password.Length -eq 0) { throw 'Credential password cannot be empty.' }

  $path = Get-YukiCredentialPath -Profile $Profile -RootPath $RootPath
  if ((Test-Path -LiteralPath $path -PathType Leaf) -and -not $Force) {
    throw "Credential for profile '$($Profile.ToLowerInvariant())' already exists; it was kept. Use -Force to replace only this profile."
  }

  $directory = Split-Path -Parent $path
  $null = New-Item -ItemType Directory -Path $directory -Force
  $temporaryPath = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.credential.tmp.xml')
  try {
    Export-Clixml -InputObject $Credential -LiteralPath $temporaryPath -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
      throw 'Credential export did not produce a file.'
    }
    Move-Item -LiteralPath $temporaryPath -Destination $path -Force:$Force -ErrorAction Stop
  } catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw 'Could not save the Windows-protected credential. No credential contents were displayed.'
  }
  return $path
}

function New-YukiProfileEnvironment {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Profile,
    [Parameter(Mandatory)][string] $ApiKey,
    [Parameter(Mandatory)][System.Collections.IDictionary] $BaseEnvironment
  )

  if ([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey -match '[\r\n\x00]') {
    throw 'The selected provider credential is missing or invalid.'
  }
  $profileInfo = Get-YukiProviderProfile -Profile $Profile
  $result = @{}
  foreach ($key in $BaseEnvironment.Keys) { $result[[string]$key] = [string]$BaseEnvironment[$key] }
  foreach ($key in $script:CredentialEnvironmentNames) { $null = $result.Remove($key) }
  $result['AI_PROVIDER_PROFILE'] = $profileInfo.Id
  $result[$profileInfo.CredentialEnvName] = $ApiKey
  return $result
}

function Invoke-YukiProviderProfile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Profile,
    [string] $RootPath,
    [Parameter(Mandatory)][scriptblock] $Starter,
    [scriptblock] $Importer
  )

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The provider credential launcher is supported only on Windows.'
  }
  if (-not $Importer) { $Importer = { param($Path) Import-Clixml -LiteralPath $Path -ErrorAction Stop } }
  $profileInfo = Get-YukiProviderProfile -Profile $Profile
  $model = [Environment]::GetEnvironmentVariable($profileInfo.ModelEnvName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($model)) { throw "$($profileInfo.ModelEnvName) is not configured." }

  $path = Get-YukiCredentialPath -Profile $profileInfo.Id -RootPath $RootPath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Credential for profile '$($profileInfo.Id)' is not configured. Run scripts/setup-provider-credentials.ps1 -Profile $($profileInfo.Id)."
  }

  try { $credential = & $Importer $path } catch {
    throw "Credential for profile '$($profileInfo.Id)' is unreadable or corrupt. Run the setup script with -Force to replace it."
  }
  if ($credential -isnot [PSCredential] -or $credential.Password.Length -eq 0) {
    throw "Credential for profile '$($profileInfo.Id)' is unreadable or corrupt. Run the setup script with -Force to replace it."
  }

  $bstr = [IntPtr]::Zero
  $apiKey = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $baseEnvironment = @{}
    foreach ($entry in Get-ChildItem Env:) { $baseEnvironment[$entry.Name] = $entry.Value }
    $launchEnvironment = New-YukiProfileEnvironment -Profile $profileInfo.Id -ApiKey $apiKey -BaseEnvironment $baseEnvironment
    return (& $Starter $launchEnvironment $profileInfo.Id)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $apiKey = $null
  }
}

function New-YukiProcessStartInfo {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment,
    [string] $RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
  )

  $root = [IO.Path]::GetFullPath($RepositoryRoot)
  $main = Join-Path $root 'dist/main.js'
  if (-not (Test-Path -LiteralPath $main -PathType Leaf)) { throw 'dist/main.js is missing. Run npm run build before launching Yuki.' }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js was not found. Install Node.js 22 or later and retry.' }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node.Source
  $startInfo.Arguments = '"' + $main.Replace('"', '\"') + '" --interactive'
  $startInfo.WorkingDirectory = $root
  $startInfo.UseShellExecute = $false
  foreach ($name in $script:CredentialEnvironmentNames) { $null = $startInfo.EnvironmentVariables.Remove($name) }
  foreach ($entry in $Environment.GetEnumerator()) {
    $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
  }
  return $startInfo
}

function Start-YukiInteractiveProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment,
    [string] $RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
  )

  $startInfo = New-YukiProcessStartInfo -Environment $Environment -RepositoryRoot $RepositoryRoot
  $process = New-Object System.Diagnostics.Process
  try {
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Could not start the Yuki process.' }
    $process.WaitForExit()
    return [int]$process.ExitCode
  } catch {
    throw 'Could not start Yuki. Check Node.js and the built CLI; credential contents were not displayed.'
  } finally {
    $process.Dispose()
  }
}

Export-ModuleMember -Function Get-YukiProviderProfile, Get-YukiCredentialRoot, Get-YukiCredentialPath, Save-YukiProviderCredential, New-YukiProfileEnvironment, Invoke-YukiProviderProfile, New-YukiProcessStartInfo, Start-YukiInteractiveProcess
