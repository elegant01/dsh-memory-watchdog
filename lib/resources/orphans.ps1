param(
  [Parameter(Mandatory = $true)][int]$HostPid,
  [int]$MainPid = 0,
  [string]$RootPath = "",
  [long]$HostStartedAtMs = 0,
  [int]$MaxItems = 50
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardOrphans {
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
  public struct FILETIME {
    public uint dwLowDateTime;
    public uint dwHighDateTime;
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

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetProcessMemoryInfo(IntPtr processHandle, ref PROCESS_MEMORY_COUNTERS_EX counters, uint size);
}
"@

$protected = @(
  'system', 'registry', 'idle', 'memory compression', 'secure system', 'smss', 'csrss',
  'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'explorer', 'dwm', 'fontdrvhost',
  'sihost', 'taskhostw', 'ctfmon', 'spoolsv', 'audiodg', 'conhost', 'dllhost', 'runtimebroker',
  'applicationframehost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost',
  'searchapp', 'textinputhost', 'wudfhost', 'wmiprvse', 'lockapp', 'logonui', 'userinit',
  'msmpeng', 'nissrv', 'securityhealthservice', 'securityhealthsystray', 'mpdefendercoreservice',
  'smartscreen', 'wuauclt', 'musnotification'
)

function Get-ProcessEntries {
  $snapshot = [MemGuardOrphans]::CreateToolhelp32Snapshot(0x00000002, 0)
  if ($snapshot -eq [IntPtr](-1)) { throw "CreateToolhelp32Snapshot failed" }
  $entry = New-Object MemGuardOrphans+PROCESSENTRY32W
  $entry.dwSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardOrphans+PROCESSENTRY32W])
  $map = @{}
  try {
    if ([MemGuardOrphans]::Process32FirstW($snapshot, [ref]$entry)) {
      do {
        $map[[int]$entry.th32ProcessID] = [ordered]@{
          pid = [int]$entry.th32ProcessID
          parentPid = [int]$entry.th32ParentProcessID
          name = [string]$entry.szExeFile
        }
      } while ([MemGuardOrphans]::Process32NextW($snapshot, [ref]$entry))
    }
  } finally {
    [void][MemGuardOrphans]::CloseHandle($snapshot)
  }
  return $map
}

$detailCache = @{}

function Get-Detail([int]$processId) {
  if ($detailCache.ContainsKey($processId)) { return $detailCache[$processId] }
  $detail = [ordered]@{ exePath = $null; createdTicks = [int64]0; bytes = [int64](-1) }
  $query = [MemGuardOrphans]::OpenProcess(0x1000, $false, $processId)
  if ($query -ne [IntPtr]::Zero) {
    try {
      $builder = New-Object System.Text.StringBuilder 1024
      $size = [int]$builder.Capacity
      if ([MemGuardOrphans]::QueryFullProcessImageNameW($query, 0, $builder, [ref]$size)) {
        $detail.exePath = [string]$builder.ToString()
      }
      $creation = New-Object MemGuardOrphans+FILETIME
      $exitTime = New-Object MemGuardOrphans+FILETIME
      $kernel = New-Object MemGuardOrphans+FILETIME
      $user = New-Object MemGuardOrphans+FILETIME
      if ([MemGuardOrphans]::GetProcessTimes($query, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
        $detail.createdTicks = ([int64]$creation.dwHighDateTime -shl 32) -bor [int64]$creation.dwLowDateTime
      }
    } finally {
      [void][MemGuardOrphans]::CloseHandle($query)
    }
  }
  $memory = [MemGuardOrphans]::OpenProcess(0x0410, $false, $processId)
  if ($memory -eq [IntPtr]::Zero) {
    $memory = [MemGuardOrphans]::OpenProcess(0x1010, $false, $processId)
  }
  if ($memory -ne [IntPtr]::Zero) {
    try {
      $counters = New-Object MemGuardOrphans+PROCESS_MEMORY_COUNTERS_EX
      $counters.cb = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardOrphans+PROCESS_MEMORY_COUNTERS_EX])
      if ([MemGuardOrphans]::GetProcessMemoryInfo($memory, [ref]$counters, $counters.cb)) {
        $detail.bytes = [int64]$counters.PrivateUsage.ToInt64()
      }
    } finally {
      [void][MemGuardOrphans]::CloseHandle($memory)
    }
  }
  $detailCache[$processId] = $detail
  return $detail
}

function Normalize-Root([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return $value.Trim().TrimEnd('\', '/')
}

function Test-UnderRoot([string]$path, [string]$root) {
  if ([string]::IsNullOrEmpty($path) -or [string]::IsNullOrEmpty($root)) { return $false }
  $withSeparator = $root + [System.IO.Path]::DirectorySeparatorChar
  return $path.StartsWith($withSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

$entries = Get-ProcessEntries

$roots = New-Object 'System.Collections.Generic.HashSet[int]'
if ($HostPid -gt 0 -and $entries.ContainsKey($HostPid)) { [void]$roots.Add($HostPid) }
if ($MainPid -gt 0 -and $entries.ContainsKey($MainPid)) { [void]$roots.Add($MainPid) }

$tree = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($rootPid in $roots) { [void]$tree.Add($rootPid) }
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

$ancestors = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($rootPid in $roots) {
  $current = $rootPid
  $hops = 0
  while ($hops -lt 64 -and $entries.ContainsKey($current)) {
    $hops = $hops + 1
    $parent = [int]$entries[$current].parentPid
    if ($parent -le 0 -or $tree.Contains($parent) -or $ancestors.Contains($parent)) { break }
    [void]$ancestors.Add($parent)
    $current = $parent
  }
}

# The install root is the shallowest real image directory of the current Host /
# main process. Node's process.execPath can be a symlink (E:\nodejs -> E:\nvm\...),
# so the caller's RootPath is only a fallback when no image path can be read.
$rootCandidates = New-Object System.Collections.ArrayList
foreach ($rootPid in $roots) {
  $detail = Get-Detail($rootPid)
  if (-not [string]::IsNullOrEmpty($detail.exePath)) {
    [void]$rootCandidates.Add((Normalize-Root ([System.IO.Path]::GetDirectoryName($detail.exePath))))
  }
}
if ($rootCandidates.Count -eq 0) {
  $passedRoot = Normalize-Root $RootPath
  if ($passedRoot.Length -gt 0) { [void]$rootCandidates.Add($passedRoot) }
}
$installRoot = ""
foreach ($candidate in $rootCandidates) {
  if ($installRoot.Length -eq 0 -or $candidate.Length -lt $installRoot.Length) { $installRoot = $candidate }
}

$hostStartTicks = [int64]0
if ($HostStartedAtMs -gt 0) {
  $hostStartTicks = [DateTimeOffset]::FromUnixTimeMilliseconds($HostStartedAtMs).UtcDateTime.ToFileTimeUtc()
}

$orphanMemo = @{}

function Test-OrphanProcess([int]$processId, [int]$depth) {
  if ($orphanMemo.ContainsKey($processId)) { return [bool]$orphanMemo[$processId] }
  if ($depth -gt 64) { $orphanMemo[$processId] = $false; return $false }
  if ($tree.Contains($processId) -or $ancestors.Contains($processId)) { $orphanMemo[$processId] = $false; return $false }
  if (-not $entries.ContainsKey($processId)) { $orphanMemo[$processId] = $false; return $false }
  $entry = $entries[$processId]
  if ($protected -contains ([string]$entry.name).ToLowerInvariant().Replace('.exe', '')) {
    $orphanMemo[$processId] = $false
    return $false
  }
  $detail = Get-Detail($processId)
  if (-not (Test-UnderRoot $detail.exePath $installRoot)) { $orphanMemo[$processId] = $false; return $false }
  if ($detail.createdTicks -le 0) { $orphanMemo[$processId] = $false; return $false }
  if ($hostStartTicks -gt 0 -and $detail.createdTicks -ge $hostStartTicks) {
    $orphanMemo[$processId] = $false
    return $false
  }
  $parent = [int]$entry.parentPid
  if (-not $entries.ContainsKey($parent)) {
    $orphanMemo[$processId] = $true
    return $true
  }
  $parentDetail = Get-Detail($parent)
  if (-not (Test-UnderRoot $parentDetail.exePath $installRoot)) {
    $orphanMemo[$processId] = $false
    return $false
  }
  $result = Test-OrphanProcess $parent ($depth + 1)
  $orphanMemo[$processId] = $result
  return $result
}

$items = New-Object System.Collections.ArrayList
$scanned = 0
$accessible = 0
foreach ($key in @($entries.Keys)) {
  $processId = [int]$key
  if ($processId -eq $PID) { continue }
  $scanned = $scanned + 1
  $detail = Get-Detail($processId)
  if ($detail.bytes -lt 0) { continue }
  $accessible = $accessible + 1
  if (-not (Test-OrphanProcess $processId 0)) { continue }
  $createdTicks = [int64]$detail.createdTicks
  $ageMin = [int][Math]::Round(([DateTime]::UtcNow.ToFileTimeUtc() - $createdTicks) / 60000000.0)
  [void]$items.Add([pscustomobject]@{
    pid = $processId
    parentPid = [int]$entries[$key].parentPid
    name = [string]$entries[$key].name
    bytes = [int64]$detail.bytes
    ageMin = $ageMin
    exePath = [string]$detail.exePath
    createdAt = $createdTicks.ToString()
    startedAt = ([DateTimeOffset]([DateTime]::FromFileTimeUtc($createdTicks))).ToUnixTimeMilliseconds()
  })
}

$limit = [Math]::Max(1, [Math]::Min(200, $MaxItems))
$items = @($items | Sort-Object -Property bytes -Descending | Select-Object -First $limit)

[pscustomobject]@{
  ok = $true
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  rootPath = [string]$installRoot
  hostStartedAt = [int64]$HostStartedAtMs
  scanned = $scanned
  accessible = $accessible
  items = $items
} | ConvertTo-Json -Depth 6 -Compress
