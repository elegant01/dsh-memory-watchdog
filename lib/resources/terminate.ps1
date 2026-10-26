param(
  [Parameter(Mandatory = $true)][string]$TargetsFile
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardTerminate {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public uint dwLowDateTime;
    public uint dwHighDateTime;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr processHandle, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

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

function Stop-ValidatedProcess([int]$TargetPid, [long]$CreationTime, [string]$Exe) {
  $result = [ordered]@{ pid = $TargetPid; ok = $false; terminated = $false; error = $null }
  if ($TargetPid -le 4) {
    $result.error = "invalid target process id"
    return $result
  }
  if ($TargetPid -eq $PID) {
    $result.error = "refusing to terminate the PowerShell worker"
    return $result
  }
  $handle = [MemGuardTerminate]::OpenProcess(0x00101001, $false, $TargetPid)
  if ($handle -eq [IntPtr]::Zero) {
    $result.error = "OpenProcess failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    return $result
  }
  try {
    $size = 32768
    $builder = New-Object System.Text.StringBuilder $size
    if (-not [MemGuardTerminate]::QueryFullProcessImageNameW($handle, 0, $builder, [ref]$size)) {
      $result.error = "QueryFullProcessImageNameW failed"
      return $result
    }
    if (-not [string]::Equals($builder.ToString(), $Exe, [System.StringComparison]::OrdinalIgnoreCase)) {
      $result.error = "executable mismatch"
      return $result
    }
    $creation = New-Object MemGuardTerminate+FILETIME
    $exitTime = New-Object MemGuardTerminate+FILETIME
    $kernel = New-Object MemGuardTerminate+FILETIME
    $user = New-Object MemGuardTerminate+FILETIME
    if (-not [MemGuardTerminate]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
      $result.error = "GetProcessTimes failed"
      return $result
    }
    if ((ConvertTo-UnixMs $creation) -ne $CreationTime) {
      $result.error = "creation time mismatch"
      return $result
    }
    if (-not [MemGuardTerminate]::TerminateProcess($handle, 1)) {
      $result.error = "TerminateProcess failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
      return $result
    }
    [void][MemGuardTerminate]::WaitForSingleObject($handle, 3000)
    $result.ok = $true
    $result.terminated = $true
    return $result
  } finally {
    [void][MemGuardTerminate]::CloseHandle($handle)
  }
}

try {
  $raw = Get-Content -LiteralPath $TargetsFile -Raw -Encoding UTF8
  $parsed = $raw | ConvertFrom-Json
  $targets = @($parsed)
  $results = @()
  foreach ($target in $targets) {
    $targetPid = 0
    $creationTime = 0
    $exe = ""
    try {
      $targetPid = [int]$target.pid
      $creationTime = [long]$target.creationTime
      $exe = [string]$target.exe
    } catch {
      $results += [ordered]@{ pid = 0; ok = $false; terminated = $false; error = "malformed target record" }
      continue
    }
    if ($targetPid -le 0 -or $creationTime -le 0 -or [string]::IsNullOrEmpty($exe)) {
      $results += [ordered]@{ pid = $targetPid; ok = $false; terminated = $false; error = "incomplete target record" }
      continue
    }
    $results += Stop-ValidatedProcess $targetPid $creationTime $exe
  }
  $allOk = -not ($results | Where-Object { -not $_.ok })
  [ordered]@{ ok = $allOk; results = $results } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message; results = @() } | ConvertTo-Json -Depth 5 -Compress
}
exit 0
