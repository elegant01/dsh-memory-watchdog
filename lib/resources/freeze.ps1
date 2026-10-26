param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][long]$CreationTime,
  [Parameter(Mandatory = $true)][string]$Exe
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardFreeze {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public uint dwLowDateTime;
    public uint dwHighDateTime;
  }

  [DllImport("ntdll.dll")]
  public static extern int NtSuspendProcess(IntPtr processHandle);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr processHandle, int flags, StringBuilder exeName, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr processHandle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
}
"@

function ConvertTo-UnixMs($fileTime) {
  $value = ([uint64]$fileTime.dwHighDateTime -shl 32) -bor [uint64]$fileTime.dwLowDateTime
  if ($value -eq 0) { return 0 }
  return [int64](($value - 116444736000000000) / 10000)
}

try {
  if ($ProcessId -le 4) { throw "invalid target process id" }
  $handle = [MemGuardFreeze]::OpenProcess(0x1800, $false, $ProcessId)
  if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    $size = 32768
    $builder = New-Object System.Text.StringBuilder $size
    if (-not [MemGuardFreeze]::QueryFullProcessImageNameW($handle, 0, $builder, [ref]$size)) {
      throw "QueryFullProcessImageNameW failed"
    }
    $actualExe = $builder.ToString()
    if (-not [string]::Equals($actualExe, $Exe, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "executable mismatch for process $ProcessId"
    }
    $creation = New-Object MemGuardFreeze+FILETIME
    $exitTime = New-Object MemGuardFreeze+FILETIME
    $kernel = New-Object MemGuardFreeze+FILETIME
    $user = New-Object MemGuardFreeze+FILETIME
    if (-not [MemGuardFreeze]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
      throw "GetProcessTimes failed"
    }
    if ((ConvertTo-UnixMs $creation) -ne $CreationTime) {
      throw "creation time mismatch for process $ProcessId"
    }
    $status = [MemGuardFreeze]::NtSuspendProcess($handle)
    if ($status -ne 0) {
      throw "NtSuspendProcess failed with status $status"
    }
    [ordered]@{ ok = $true; pid = $ProcessId; frozen = $true } | ConvertTo-Json -Compress
  } finally {
    [void][MemGuardFreeze]::CloseHandle($handle)
  }
} catch {
  [ordered]@{ ok = $false; pid = $ProcessId; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
exit 0
