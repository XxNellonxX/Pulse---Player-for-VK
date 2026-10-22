param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
# Read only: include just the supplied live app process and its descendants.
# Working-set sum includes shared pages; private bytes measure committed memory.
$processList = @(Get-CimInstance Win32_Process)
$root = $processList | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
if (-not $root) { throw 'Requested application process is no longer running.' }
$identities = [System.Collections.Generic.HashSet[int]]::new()
[void]$identities.Add($RootProcessId)
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($item in $processList) {
        if ($identities.Contains([int]$item.ParentProcessId) -and $item.CreationDate -ge $root.CreationDate -and $identities.Add([int]$item.ProcessId)) { $changed = $true }
    }
}
$details = @($processList | Where-Object { $identities.Contains([int]$_.ProcessId) } | ForEach-Object {
    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($process) { [pscustomobject]@{ name = $process.ProcessName; pid = $process.Id; workingSetBytes = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64 } }
})
[pscustomobject]@{
    measuredAt = (Get-Date).ToString('o')
    rootPid = $RootProcessId
    workingSetMiB = [math]::Round(($details | Measure-Object workingSetBytes -Sum).Sum / 1MB, 2)
    privateMiB = [math]::Round(($details | Measure-Object privateBytes -Sum).Sum / 1MB, 2)
    processCount = $details.Length
    processes = $details
} | ConvertTo-Json -Depth 5 -Compress
