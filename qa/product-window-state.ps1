param([Parameter(Mandatory=$true)][int]$ProductProcessId,[ValidateSet('inspect','close-player','hide-player')][string]$Action='inspect')
$ErrorActionPreference = 'Stop'
$ProductInstance = Get-Process -Id $ProductProcessId
$ProductExpectedPath = Join-Path $env:LOCALAPPDATA 'VK Player/vk-player.exe'
if ($ProductInstance.Path -ne $ProductExpectedPath) { throw 'Only the installed player may be inspected' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ProductWindowInspector {
 public delegate bool Visitor(IntPtr window, IntPtr arg);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visit, IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int owner);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
}
'@
$ProductWindowCounts = @{vkWindowCount=0;visibleVkWindows=0;visiblePlayerWindows=0}
[ProductWindowInspector]::EnumWindows({param($ProductWindow,$ProductArgument)
 $ProductOwner=0
 [void][ProductWindowInspector]::GetWindowThreadProcessId($ProductWindow,[ref]$ProductOwner)
 if($ProductOwner -eq $ProductProcessId){
  $ProductTitle=[System.Text.StringBuilder]::new(1024)
  [void][ProductWindowInspector]::GetWindowText($ProductWindow,$ProductTitle,1024)
  if($ProductTitle.ToString() -match 'подключение к Pulse'){
   $ProductWindowCounts.vkWindowCount++
   if([ProductWindowInspector]::IsWindowVisible($ProductWindow)){$ProductWindowCounts.visibleVkWindows++}
  }
  if($ProductTitle.ToString() -eq 'VK Player'){
   if([ProductWindowInspector]::IsWindowVisible($ProductWindow)){$ProductWindowCounts.visiblePlayerWindows++}
   if($Action -eq 'close-player'){[void][ProductWindowInspector]::PostMessage($ProductWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)}
   if($Action -eq 'hide-player'){[void][ProductWindowInspector]::ShowWindowAsync($ProductWindow,0)}
  }
 }
 return $true
},[IntPtr]::Zero)|Out-Null
$ProductWindowCounts | ConvertTo-Json -Compress
