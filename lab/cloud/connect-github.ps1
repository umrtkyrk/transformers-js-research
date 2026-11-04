$ErrorActionPreference = 'Stop'
$labRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $labRoot -Parent
$localSettings = Get-Content -LiteralPath (Join-Path $labRoot 'local.json') -Raw | ConvertFrom-Json
$nodeExecutable = $localSettings.nodeExecutable
$vercelCli = $localSettings.vercelCli
if (-not (Test-Path -LiteralPath $nodeExecutable) -or -not (Test-Path -LiteralPath $vercelCli)) { throw 'Local Node or official Vercel CLI path is missing.' }
Write-Host 'Only the transformers-js-research repository needs Actions: Read and write permission.'
Write-Host 'The credential is sent to Vercel as a sensitive production environment value; it is not saved in this workspace.'
$credentialValue = Read-Host -Prompt 'Paste the repository-scoped GitHub token' -AsSecureString
$credentialPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credentialValue)
try {
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $nodeExecutable
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardInput = $true
    # Fixed, locally configured paths; the credential is never placed in command arguments.
    $deploymentDirectory = Join-Path $workspaceRoot 'vercel-deploy'
    $processInfo.Arguments = '"{0}" env add LAB_GITHUB_TOKEN production --sensitive --cwd "{1}" --global-config "{2}"' -f $vercelCli, $deploymentDirectory, $localSettings.vercelGlobalConfig
    $processHandle = [System.Diagnostics.Process]::Start($processInfo)
    $processHandle.StandardInput.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialPointer))
    $processHandle.StandardInput.Close()
    $processHandle.WaitForExit()
    if ($processHandle.ExitCode -ne 0) { throw 'Vercel did not save the credential. No local credential file was created.' }
    Write-Host 'GitHub connection saved in Vercel. Return to the conversation so the deployment can be verified.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialPointer)
    $credentialValue.Dispose()
}
