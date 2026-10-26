param(
  [int]$IntervalMs = 5000,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MemGuardPerf {
  [StructLayout(LayoutKind.Sequential)]
  public struct PERFORMANCE_INFORMATION {
    public uint cb;
    public UIntPtr CommitTotal;
    public UIntPtr CommitLimit;
    public UIntPtr CommitPeak;
    public UIntPtr PhysicalTotal;
    public UIntPtr PhysicalAvailable;
    public UIntPtr SystemCache;
    public UIntPtr KernelTotal;
    public UIntPtr KernelPaged;
    public UIntPtr KernelNonpaged;
    public UIntPtr PageSize;
    public uint HandleCount;
    public uint ProcessCount;
    public uint ThreadCount;
  }

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION information, uint size);
}
"@

$infoSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardPerf+PERFORMANCE_INFORMATION])

function Write-Sample {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try {
    $info = New-Object MemGuardPerf+PERFORMANCE_INFORMATION
    if (-not [MemGuardPerf]::GetPerformanceInfo([ref]$info, $infoSize)) {
      throw "GetPerformanceInfo failed with error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $page = $info.PageSize.ToUInt64()
    if ($page -eq 0) { throw "GetPerformanceInfo returned a zero page size" }
    $payload = [ordered]@{
      ok = $true
      ts = $now
      commitUsed = $info.CommitTotal.ToUInt64() * $page
      commitLimit = $info.CommitLimit.ToUInt64() * $page
      physicalTotal = $info.PhysicalTotal.ToUInt64() * $page
      physicalAvailable = $info.PhysicalAvailable.ToUInt64() * $page
    }
  } catch {
    $payload = [ordered]@{
      ok = $false
      ts = $now
      error = $_.Exception.Message
    }
  }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

if ($Once) {
  Write-Sample
  exit 0
}

if ($IntervalMs -lt 1000) { $IntervalMs = 1000 }
while ($true) {
  Write-Sample
  Start-Sleep -Milliseconds $IntervalMs
}
