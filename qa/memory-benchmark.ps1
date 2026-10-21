param(
    [string]$TauriExe = "$env:LOCALAPPDATA\vk-player-build\target\release\vk-player.exe",
    [string]$ElectronExe = "$PSScriptRoot\..\release-clean-installer\win-unpacked\VK Player.exe",
    [int]$WarmupSeconds = 20
)
$ErrorActionPreference = 'Stop'
function Get-AppProcessTree([int]$rootId) {
    $allProcesses = @(Get-CimInstance Win32_Process)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($rootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $allProcesses) {
            if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true }
        }
    }
    @($allProcesses | Where-Object { $ids.Contains([int]$_.ProcessId) })
}
function Measure-Player([string]$label, [string]$exe, [string[]]$appArguments) {
    $launch = @{ FilePath = $exe; PassThru = $true; WindowStyle = 'Hidden' }
    if ($appArguments.Length) { $launch.ArgumentList = $appArguments }
    $process = Start-Process @launch
    $tree = @()
    try {
        Start-Sleep -Seconds $WarmupSeconds
        if ($process.HasExited) { throw "$label exited before measurement; close other instances first." }
        $tree = @(Get-AppProcessTree $process.Id)
        $details = @($tree | ForEach-Object {
            $item = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($item) {
                [pscustomobject]@{ name = $item.ProcessName; pid = $item.Id; workingSetBytes = $item.WorkingSet64; privateBytes = $item.PrivateMemorySize64 }
            }
        })
        [pscustomobject]@{
            label = $label
            warmupSeconds = $WarmupSeconds
            workingSetMiB = [math]::Round(($details | Measure-Object workingSetBytes -Sum).Sum / 1MB, 1)
            privateMiB = [math]::Round(($details | Measure-Object privateBytes -Sum).Sum / 1MB, 1)
            processCount = $details.Length
            processes = $details
        }
    } finally {
        if (-not $tree.Length) { $tree = @(Get-AppProcessTree $process.Id) }
        foreach ($item in $tree) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}
$result = [pscustomobject]@{
    measuredAt = (Get-Date).ToString('o')
    scenario = 'Empty library, no VK window, release binaries, complete child process trees; working set includes shared pages.'
    results = @(
        Measure-Player 'Tauri 2 / WebView2' $TauriExe @()
        Measure-Player 'Electron fallback' $ElectronExe @("--user-data-dir=$env:TEMP\vk-player-memory-electron")
    )
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$PSScriptRoot\memory-baseline.json" -Encoding utf8
$result | ConvertTo-Json -Depth 8
