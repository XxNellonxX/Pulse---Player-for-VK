param([Parameter(Mandatory=$true)][string]$QaBinary)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$QaVersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($QaBinary)
@{productName=$QaVersionInfo.ProductName} | ConvertTo-Json -Compress
