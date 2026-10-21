param([Parameter(Mandatory=$true)][int]$ProductProcessId)
$ErrorActionPreference = 'Stop'
$ProductInstance = Get-Process -Id $ProductProcessId
$ProductExpectedPath = Join-Path $env:LOCALAPPDATA 'VK Player/vk-player.exe'
if ($ProductInstance.Path -ne $ProductExpectedPath) { throw 'Only the installed player may be measured' }
$ProductProcesses = @(Get-CimInstance Win32_Process)
$ProductTreeIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$ProductTreeIds.Add($ProductProcessId)
do {
    $ProductTreeChanged = $false
    foreach ($ProductChild in $ProductProcesses) {
        if ($ProductTreeIds.Contains([int]$ProductChild.ParentProcessId) -and $ProductTreeIds.Add([int]$ProductChild.ProcessId)) {
            $ProductTreeChanged = $true
        }
    }
} while ($ProductTreeChanged)
$ProductTree = @($ProductProcesses | Where-Object { $ProductTreeIds.Contains([int]$_.ProcessId) })
$ProductMemory = @($ProductTree | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
$ProductInstances = @(Get-Process -Name 'vk-player' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ProductExpectedPath })
$ProductTools = @($ProductTree | Where-Object { $_.Name -in @('yt-dlp.exe','ffmpeg.exe','ffprobe.exe','deno.exe') })
$ProductDiagnosticListeners = @(Get-NetTCPConnection -LocalPort 9226 -State Listen -ErrorAction SilentlyContinue)
$ProductMeasurement = [pscustomobject]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    scenario = 'Installed release after a normal restart, restored VK session, main window visible and paused, VK window hidden; complete child process tree. Working set includes shared pages.'
    installedInstances = $ProductInstances.Count
    processCount = $ProductMemory.Count
    idleImportToolProcesses = $ProductTools.Count
    temporaryDebugPortClosed = $ProductDiagnosticListeners.Count -eq 0
    workingSetMiB = [math]::Round(($ProductMemory | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1)
    privateMiB = [math]::Round(($ProductMemory | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
}
$ProductMeasurement | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-process-state-result.json') -Encoding utf8
$ProductMeasurement | ConvertTo-Json -Compress
