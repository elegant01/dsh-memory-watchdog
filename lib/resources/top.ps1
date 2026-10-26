param(
  [Parameter(Mandatory = $true)][int]$HostPid,
  [int]$MainPid = 0,
  [int]$TopN = 5
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardTop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_MEMORY_COUNTERS_EX {
    public uint cb;
    public uint PageFaultCount;
    public IntPtr PeakWorkingSetSize;
    public IntPtr WorkingSetSize;
    public IntPtr QuotaPeakPagedPoolUsage;
    public IntPtr QuotaPagedPoolUsage;
    public IntPtr QuotaPeakNonPagedPoolUsage;
    public IntPtr QuotaNonPagedPoolUsage;
    public IntPtr PagefileUsage;
    public IntPtr PeakPagefileUsage;
    public IntPtr PrivateUsage;
  }

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

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr processHandle, int flags, StringBuilder exeName, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr processHandle, out FILETIME creation, out FILETIME exitTime, out FILETIME kernel, out FILETIME user);

  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public uint dwLowDateTime;
    public uint dwHighDateTime;
  }

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetProcessMemoryInfo(IntPtr processHandle, ref PROCESS_MEMORY_COUNTERS_EX counters, uint size);

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetPerformanceInfo(ref PERFORMANCE_INFORMATION info, uint size);
}
"@

function Get-PerformanceInfo {
  $info = New-Object MemGuardTop+PERFORMANCE_INFORMATION
  $info.cb = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardTop+PERFORMANCE_INFORMATION])
  if (-not [MemGuardTop]::GetPerformanceInfo([ref]$info, $info.cb)) {
    throw "GetPerformanceInfo failed"
  }
  $pageSize = [int64]$info.PageSize.ToInt64()
  return [ordered]@{
    commitUsed = [int64]$info.CommitTotal.ToInt64() * $pageSize
    commitLimit = [int64]$info.CommitLimit.ToInt64() * $pageSize
    physicalTotal = [int64]$info.PhysicalTotal.ToInt64() * $pageSize
    physicalAvailable = [int64]$info.PhysicalAvailable.ToInt64() * $pageSize
    processCount = [int]$info.ProcessCount
  }
}

function Get-ProcessEntries {
  $snapshot = [MemGuardTop]::CreateToolhelp32Snapshot(0x00000002, 0)
  if ($snapshot -eq [IntPtr](-1)) { throw "CreateToolhelp32Snapshot failed" }
  $entry = New-Object MemGuardTop+PROCESSENTRY32W
  $entry.dwSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardTop+PROCESSENTRY32W])
  $map = @{}
  try {
    if ([MemGuardTop]::Process32FirstW($snapshot, [ref]$entry)) {
      do {
        $map[[int]$entry.th32ProcessID] = [ordered]@{
          pid = [int]$entry.th32ProcessID
          parentPid = [int]$entry.th32ParentProcessID
          name = [string]$entry.szExeFile
        }
      } while ([MemGuardTop]::Process32NextW($snapshot, [ref]$entry))
    }
  } finally {
    [void][MemGuardTop]::CloseHandle($snapshot)
  }
  return $map
}

function Get-CommitBytes([int]$processId) {
  $handle = [MemGuardTop]::OpenProcess(0x0410, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) {
    $handle = [MemGuardTop]::OpenProcess(0x1010, $false, $processId)
  }
  if ($handle -eq [IntPtr]::Zero) { return -1 }
  $counters = New-Object MemGuardTop+PROCESS_MEMORY_COUNTERS_EX
  $counters.cb = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardTop+PROCESS_MEMORY_COUNTERS_EX])
  try {
    if (-not [MemGuardTop]::GetProcessMemoryInfo($handle, [ref]$counters, $counters.cb)) {
      return -1
    }
    return [int64]$counters.PrivateUsage.ToInt64()
  } finally {
    [void][MemGuardTop]::CloseHandle($handle)
  }
}

$nowTicks = [int64][DateTime]::UtcNow.ToFileTimeUtc()

function Get-ProcessDetail([int]$processId) {
  $handle = [MemGuardTop]::OpenProcess(0x1000, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) {
    return [pscustomobject]@{ exePath = $null; ageMin = $null }
  }
  try {
    $exePath = $null
    $builder = New-Object System.Text.StringBuilder 1024
    $size = [int]$builder.Capacity
    if ([MemGuardTop]::QueryFullProcessImageNameW($handle, 0, $builder, [ref]$size)) {
      $exePath = [string]$builder.ToString()
    }
    $ageMin = $null
    $creation = New-Object MemGuardTop+FILETIME
    $exitTime = New-Object MemGuardTop+FILETIME
    $kernel = New-Object MemGuardTop+FILETIME
    $user = New-Object MemGuardTop+FILETIME
    if ([MemGuardTop]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
      $created = ([int64]$creation.dwHighDateTime -shl 32) -bor [int64]$creation.dwLowDateTime
      $ageMin = [int][Math]::Round(($nowTicks - $created) / 60000000.0)
    }
    return [pscustomobject]@{ exePath = $exePath; ageMin = $ageMin }
  } finally {
    [void][MemGuardTop]::CloseHandle($handle)
  }
}

$info = Get-PerformanceInfo
$entries = Get-ProcessEntries

$roots = New-Object 'System.Collections.Generic.HashSet[int]'
if ($HostPid -gt 0 -and $entries.ContainsKey($HostPid)) { [void]$roots.Add($HostPid) }
if ($MainPid -gt 0 -and $entries.ContainsKey($MainPid)) { [void]$roots.Add($MainPid) }

$tree = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($root in $roots) { [void]$tree.Add($root) }
$changed = $true
$guard = 0
while ($changed -and $guard -lt 64) {
  $changed = $false
  $guard = $guard + 1
  foreach ($key in @($entries.Keys)) {
    if ($tree.Contains([int]$key)) { continue }
    $parent = [int]$entries[$key].parentPid
    if ($tree.Contains($parent)) {
      [void]$tree.Add([int]$key)
      $changed = $true
    }
  }
}

$topLimit = [Math]::Max(1, [Math]::Min(20, $TopN))
$scanned = 0
$accessible = 0
$dshBytes = [int64]0
$rows = New-Object System.Collections.ArrayList
foreach ($key in @($entries.Keys)) {
  $processId = [int]$key
  if ($processId -eq $PID) { continue }
  $bytes = Get-CommitBytes($processId)
  $scanned = $scanned + 1
  if ($bytes -lt 0) { continue }
  $accessible = $accessible + 1
  $inTree = $tree.Contains($processId)
  if ($inTree) { $dshBytes = $dshBytes + $bytes }
  [void]$rows.Add([pscustomobject]@{
    pid = $processId
    parentPid = [int]$entries[$key].parentPid
    name = [string]$entries[$key].name
    bytes = $bytes
    dsh = $inTree
  })
}

$top = @($rows | Sort-Object -Property bytes -Descending | Select-Object -First $topLimit)
$detailed = New-Object System.Collections.ArrayList
foreach ($row in $top) {
  $detail = Get-ProcessDetail([int]$row.pid)
  [void]$detailed.Add([pscustomobject]@{
    pid = $row.pid
    parentPid = $row.parentPid
    name = $row.name
    bytes = $row.bytes
    dsh = $row.dsh
    exePath = $detail.exePath
    ageMin = $detail.ageMin
  })
}
$top = @($detailed)
$dshPids = @($tree | Sort-Object)
$sharePct = 0
if ($info.commitUsed -gt 0) {
  $sharePct = [Math]::Round(($dshBytes * 100.0) / $info.commitUsed, 1)
}

[pscustomobject]@{
  ok = $true
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  systemCommitUsed = $info.commitUsed
  systemCommitLimit = $info.commitLimit
  physicalTotal = $info.physicalTotal
  physicalAvailable = $info.physicalAvailable
  processCount = $info.processCount
  scanned = $scanned
  accessible = $accessible
  dsh = [pscustomobject]@{
    pids = $dshPids
    count = $dshPids.Count
    bytes = $dshBytes
    sharePct = $sharePct
  }
  top = $top
} | ConvertTo-Json -Depth 6 -Compress
