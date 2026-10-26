param(
  [int]$MaxPagefiles = 16
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MemGuardSystem {
  [StructLayout(LayoutKind.Sequential)]
  public struct PERFORMANCE_INFORMATION {
    public uint cb;
    public IntPtr CommitTotal;
    public IntPtr CommitLimit;
    public IntPtr CommitPeak;
    public IntPtr PhysicalTotal;
    public IntPtr PhysicalAvailable;
    public IntPtr SystemCache;
    public IntPtr KernelTotal;
    public IntPtr KernelPaged;
    public IntPtr KernelNonpaged;
    public IntPtr PageSize;
    public uint HandleCount;
    public uint ProcessCount;
    public uint ThreadCount;
  }

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetPerformanceInfo(ref PERFORMANCE_INFORMATION info, uint size);
}
"@

function Get-MemoryInfo {
  $info = New-Object MemGuardSystem+PERFORMANCE_INFORMATION
  $info.cb = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardSystem+PERFORMANCE_INFORMATION])
  if (-not [MemGuardSystem]::GetPerformanceInfo([ref]$info, $info.cb)) {
    throw "GetPerformanceInfo failed"
  }
  $pageSize = [int64]$info.PageSize.ToInt64()
  return [ordered]@{
    commitUsed = [int64]$info.CommitTotal.ToInt64() * $pageSize
    commitLimit = [int64]$info.CommitLimit.ToInt64() * $pageSize
    physicalTotal = [int64]$info.PhysicalTotal.ToInt64() * $pageSize
    physicalAvailable = [int64]$info.PhysicalAvailable.ToInt64() * $pageSize
  }
}

function ConvertTo-PageSpec([string]$spec) {
  $match = [regex]::Match($spec.Trim(), '^(.*?)\s+(\d+)\s+(\d+)$')
  if (-not $match.Success) {
    return [ordered]@{ path = $spec.Trim(); initialMb = $null; maximumMb = $null }
  }
  return [ordered]@{
    path = $match.Groups[1].Value
    initialMb = [int]$match.Groups[2].Value
    maximumMb = [int]$match.Groups[3].Value
  }
}

function ConvertTo-NormalPath([string]$path) {
  if ($path -eq $null) { return '' }
  $value = $path.Trim()
  if ($value.StartsWith('\??\')) { $value = $value.Substring(4) }
  return $value
}

$mm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
$automaticManaged = $false
$specs = @()
$existing = @()
try {
  $props = Get-ItemProperty -Path $mm -ErrorAction Stop
  if ($props.PSObject.Properties.Name -contains 'AutomaticManagedPagefile') {
    $automaticManaged = [bool]$props.AutomaticManagedPagefile
  }
  $specs = @($props.PagingFiles)
  $existing = @($props.ExistingPageFiles)
} catch {
}

$entries = New-Object System.Collections.ArrayList
$seen = @{}
foreach ($raw in $specs) {
  if ($raw -eq $null) { continue }
  $spec = ConvertTo-PageSpec ([string]$raw)
  $spec.path = ConvertTo-NormalPath $spec.path
  if ($spec.path.Length -eq 0) { continue }
  $key = $spec.path.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  [void]$entries.Add($spec)
}
foreach ($raw in $existing) {
  if ($raw -eq $null) { continue }
  $path = ConvertTo-NormalPath ([string]$raw)
  if ($path.Length -eq 0) { continue }
  $key = $path.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  [void]$entries.Add([ordered]@{ path = $path; initialMb = $null; maximumMb = $null })
}

$systemDrive = $env:SystemDrive
$pagefiles = New-Object System.Collections.ArrayList
$totalBytes = [int64]0
foreach ($entry in @($entries | Select-Object -First $MaxPagefiles)) {
  $exists = $false
  $currentBytes = [int64]0
  try {
    $file = New-Object System.IO.FileInfo($entry.path)
    if ($file.Exists) {
      $exists = $true
      $currentBytes = [int64]$file.Length
    }
  } catch {
  }
  if (-not $exists -and $entry.maximumMb -ne $null -and [int]$entry.maximumMb -gt 0) {
    $currentBytes = [int64][int]$entry.maximumMb * 1MB
  }
  $totalBytes = $totalBytes + $currentBytes
  $systemVolume = $false
  if ($systemDrive -ne $null -and $systemDrive.Length -gt 0) {
    $systemVolume = $entry.path.ToLowerInvariant().StartsWith($systemDrive.ToLowerInvariant())
  }
  [void]$pagefiles.Add([pscustomobject]@{
    path = [string]$entry.path
    initialMb = $entry.initialMb
    maximumMb = $entry.maximumMb
    currentMb = [int][Math]::Round($currentBytes / 1MB)
    exists = $exists
    systemVolume = $systemVolume
  })
}

$memory = Get-MemoryInfo

[pscustomobject]@{
  ok = $true
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  systemDrive = $systemDrive
  automaticManaged = $automaticManaged
  commitUsed = $memory.commitUsed
  commitLimit = $memory.commitLimit
  physicalTotal = $memory.physicalTotal
  physicalAvailable = $memory.physicalAvailable
  pagefileTotalBytes = $totalBytes
  pagefiles = @($pagefiles)
} | ConvertTo-Json -Depth 5 -Compress
