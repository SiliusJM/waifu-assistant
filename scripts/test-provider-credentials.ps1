[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'provider-credentials.psm1') -Force

$script:passed = 0
function Assert-True([bool]$Condition, [string]$Name) {
  if (-not $Condition) { throw "FAIL: $Name" }
  $script:passed++
}
function Assert-Throws([scriptblock]$Action, [string]$ExpectedText, [string]$Name) {
  try { & $Action } catch {
    Assert-True ($_.Exception.Message -like "*$ExpectedText*") $Name
    return
  }
  throw "FAIL: $Name (did not throw)"
}
function Get-TestCredential([string]$Value) {
  $secure = ConvertTo-SecureString $Value -AsPlainText -Force
  return New-Object System.Management.Automation.PSCredential('fixture-label', $secure)
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('yuki-credential-tests-' + [Guid]::NewGuid().ToString('N'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousAppData = $env:APPDATA
$previousModels = @{}
$modelNames = @('OMNIROUTE_MODEL', 'GROQ_MODEL', 'GEMINI_MODEL', 'OPENROUTER_MODEL')
foreach ($name in $modelNames) { $previousModels[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

try {
  $null = New-Item -ItemType Directory -Path $tempRoot

  Assert-Throws { Get-YukiProviderProfile -Profile 'unknown' } 'Unknown provider profile' 'unknown profile rejected'
  $expected = @{
    omniroute = 'omniroute-credential.xml'; groq = 'providers/groq-credential.xml';
    gemini = 'providers/gemini-credential.xml'; openrouter = 'providers/openrouter-credential.xml'
  }
  foreach ($profile in $expected.Keys) {
    $path = Get-YukiCredentialPath -Profile $profile -RootPath $tempRoot
    Assert-True ($path.EndsWith(($expected[$profile] -replace '/', [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) "$profile path mapping"
    Assert-True (-not $path.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) "$profile credential outside repo"
  }
  $env:APPDATA = $tempRoot
  Assert-True ((Get-YukiCredentialRoot) -eq (Join-Path $tempRoot 'WaifuAssistant')) 'default root follows APPDATA without touching real AppData'
  $env:APPDATA = $previousAppData

  $fakeOne = 'sk-super-secret-123'
  $fakeTwo = 'AIza-super-secret-456'
  $firstPath = Save-YukiProviderCredential -Profile groq -RootPath $tempRoot -Credential (Get-TestCredential $fakeOne)
  $firstHash = (Get-FileHash -LiteralPath $firstPath -Algorithm SHA256).Hash
  Assert-True (Test-Path -LiteralPath $firstPath -PathType Leaf) 'credential created'
  $serializedCredential = [IO.File]::ReadAllText($firstPath)
  Assert-True (-not $serializedCredential.Contains($fakeOne)) 'Export-Clixml output does not contain the fake key as plaintext'
  Assert-Throws { Save-YukiProviderCredential -Profile groq -RootPath $tempRoot -Credential (Get-TestCredential $fakeTwo) } 'already exists' 'existing credential preserved without force'
  Assert-True ((Get-FileHash -LiteralPath $firstPath -Algorithm SHA256).Hash -eq $firstHash) 'existing file unchanged without force'

  $replacePath = Save-YukiProviderCredential -Profile groq -RootPath $tempRoot -Credential (Get-TestCredential $fakeTwo) -Force
  $loaded = Import-Clixml -LiteralPath $replacePath
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loaded.Password)
  try { $loadedSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Assert-True ($loadedSecret -ceq $fakeTwo) 'explicit force replaces selected credential'
  $loadedSecret = $null

  $otherPath = Save-YukiProviderCredential -Profile gemini -RootPath $tempRoot -Credential (Get-TestCredential 'fixture-gemini-not-real')
  $env:GROQ_MODEL = 'public-groq-model'
  $captured = $null
  $starter = { param($environment, $selectedProfile) $script:captured = @{ Environment = $environment; Profile = $selectedProfile }; return 0 }
  $launchCode = Invoke-YukiProviderProfile -Profile groq -RootPath $tempRoot -Starter $starter
  Assert-True ($launchCode -eq 0) 'launcher propagates start result'
  Assert-True ($script:captured.Profile -eq 'groq') 'launcher selects requested profile'
  Assert-True ($script:captured.Environment.AI_PROVIDER_PROFILE -eq 'groq') 'launcher maps profile selector'
  Assert-True ($script:captured.Environment.GROQ_API_KEY -ceq $fakeTwo) 'launcher maps selected credential'
  Assert-True (-not $script:captured.Environment.ContainsKey('GEMINI_API_KEY') -and -not $script:captured.Environment.ContainsKey('OPENROUTER_API_KEY') -and -not $script:captured.Environment.ContainsKey('OMNIROUTE_API_KEY')) 'launcher isolates other provider credentials'
  Assert-True (-not $script:captured.Environment.ContainsKey('AI_API_KEY')) 'launcher clears legacy credential from child environment'
  Assert-True ($script:captured.Environment.GROQ_MODEL -eq 'public-groq-model') 'model remains separate public configuration'
  Assert-True ((Test-Path -LiteralPath $otherPath) -and (Test-Path -LiteralPath $firstPath)) 'selected replacement leaves other provider files intact'

  $allProfiles = @{
    omniroute = @{ Model = 'OMNIROUTE_MODEL'; Key = 'OMNIROUTE_API_KEY'; Secret = 'or-super-secret-789' }
    groq = @{ Model = 'GROQ_MODEL'; Key = 'GROQ_API_KEY'; Secret = $fakeTwo }
    gemini = @{ Model = 'GEMINI_MODEL'; Key = 'GEMINI_API_KEY'; Secret = 'fixture-gemini-not-real' }
    openrouter = @{ Model = 'OPENROUTER_MODEL'; Key = 'OPENROUTER_API_KEY'; Secret = 'fixture-openrouter-not-real' }
  }
  foreach ($profile in $allProfiles.Keys) {
    $entry = $allProfiles[$profile]
    if (-not (Test-Path -LiteralPath (Get-YukiCredentialPath -Profile $profile -RootPath $tempRoot))) {
      Save-YukiProviderCredential -Profile $profile -RootPath $tempRoot -Credential (Get-TestCredential $entry.Secret) | Out-Null
    }
    [Environment]::SetEnvironmentVariable($entry.Model, "public-$profile-model", 'Process')
    $profileEnvironment = $null
    Invoke-YukiProviderProfile -Profile $profile -RootPath $tempRoot -Starter {
      param($environment, $selectedProfile) $script:profileEnvironment = $environment; return 0
    } | Out-Null
    Assert-True ($profileEnvironment.AI_PROVIDER_PROFILE -eq $profile) "$profile launcher profile mapping"
    Assert-True ($profileEnvironment[$entry.Key] -ceq $entry.Secret) "$profile launcher credential mapping"
    $serialized = [IO.File]::ReadAllText((Get-YukiCredentialPath -Profile $profile -RootPath $tempRoot))
    Assert-True (-not $serialized.Contains($entry.Secret)) "$profile credential is not stored as plaintext"
    $otherKeys = @('OMNIROUTE_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY') | Where-Object { $_ -ne $entry.Key }
    Assert-True (@($otherKeys | Where-Object { $profileEnvironment.ContainsKey($_) }).Count -eq 0) "$profile launcher isolation"
    Assert-True ($profileEnvironment[$entry.Model] -eq "public-$profile-model") "$profile model stays separate"
  }

  $fakeRoot = Join-Path $tempRoot 'fake-repository'
  $fakeDist = Join-Path $fakeRoot 'dist'
  $null = New-Item -ItemType Directory -Path $fakeDist -Force
  Set-Content -LiteralPath (Join-Path $fakeDist 'main.js') -Value '// non-executable test placeholder'
  $startInfo = New-YukiProcessStartInfo -Environment $script:captured.Environment -RepositoryRoot $fakeRoot
  Assert-True ($startInfo.Arguments.Contains('--interactive')) 'launcher uses interactive CLI'
  Assert-True (-not $startInfo.Arguments.Contains($fakeTwo)) 'credential is never placed in process arguments'
  Assert-True ($startInfo.EnvironmentVariables['GROQ_API_KEY'] -ceq $fakeTwo -and $startInfo.EnvironmentVariables['AI_API_KEY'] -eq $null) 'launcher child environment carries selected key, not legacy key'
  Assert-True ($startInfo.EnvironmentVariables['GEMINI_API_KEY'] -eq $null -and $startInfo.EnvironmentVariables['OPENROUTER_API_KEY'] -eq $null -and $startInfo.EnvironmentVariables['OMNIROUTE_API_KEY'] -eq $null) 'launcher process spec excludes other profile keys'

  $starterCalls = 0
  $neverStart = { param($environment, $selectedProfile) $script:starterCalls++; return 0 }
  [Environment]::SetEnvironmentVariable('OPENROUTER_MODEL', $null, 'Process')
  Assert-Throws { Invoke-YukiProviderProfile -Profile openrouter -RootPath $tempRoot -Starter $neverStart } 'OPENROUTER_MODEL is not configured' 'missing model fails before credential import/start'
  Assert-True ($script:starterCalls -eq 0) 'missing model does not start process'
  $env:OPENROUTER_MODEL = 'public-openrouter-model'
  $openrouterPath = Get-YukiCredentialPath -Profile openrouter -RootPath $tempRoot
  Remove-Item -LiteralPath $openrouterPath -Force
  Assert-Throws { Invoke-YukiProviderProfile -Profile openrouter -RootPath $tempRoot -Starter $neverStart } "Credential for profile 'openrouter' is not configured" 'missing credential is controlled'

  $corruptPath = $openrouterPath
  $null = New-Item -ItemType Directory -Path (Split-Path -Parent $corruptPath) -Force
  Set-Content -LiteralPath $corruptPath -Value 'fixture-corrupt-not-secret' -NoNewline
  $corruptOutput = $null
  try { Invoke-YukiProviderProfile -Profile openrouter -RootPath $tempRoot -Starter $neverStart } catch { $corruptOutput = $_.Exception.Message }
  Assert-True ($corruptOutput -like "*unreadable or corrupt*" -and $corruptOutput -notlike '*fixture-corrupt-not-secret*') 'corrupt credential error is redacted'

  Write-Output "Windows credential bootstrap tests: $script:passed PASS"
} finally {
  [Environment]::SetEnvironmentVariable('APPDATA', $previousAppData, 'Process')
  foreach ($name in $modelNames) {
    [Environment]::SetEnvironmentVariable($name, $previousModels[$name], 'Process')
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
