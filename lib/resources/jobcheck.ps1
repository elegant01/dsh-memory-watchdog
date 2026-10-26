param(
  [Parameter(Mandatory = $true)][int]$ProcessId
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MemGuardJob {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);
}
"@

try {
  if ($ProcessId -le 0) { throw "invalid process id" }
  $handle = [MemGuardJob]::OpenProcess(0x1000, $false, $ProcessId)
  if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    $inJob = $false
    if (-not [MemGuardJob]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)) {
      throw "IsProcessInJob failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    [ordered]@{ ok = $true; pid = $ProcessId; inJob = $inJob } | ConvertTo-Json -Compress
  } finally {
    [void][MemGuardJob]::CloseHandle($handle)
  }
} catch {
  [ordered]@{ ok = $false; pid = $ProcessId; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
exit 0
