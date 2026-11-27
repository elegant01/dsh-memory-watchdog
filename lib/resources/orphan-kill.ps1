param(
  [Parameter(Mandatory = $true)][string]$PlanJson,
  [Parameter(Mandatory = $true)][int]$HostPid,
  [int]$MainPid = 0,
  [string]$RootPath = ""
)

$ErrorActionPreference = "Stop"

# A leftover DSH process is killed only after this helper re-derives the whole
# picture: the pid must still exist, carry the same image name, have the exact
# creation time the scan recorded, sit under the install root, stay outside the
# current process tree, and still have a parent chain that ends at a dead pid.
# Anything else is skipped, never guessed at. Output stays ASCII.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardOrphanKill {
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
}
"@

$plan = @(ConvertFrom-Json $PlanJson)
if ($plan.Count -eq 1 -and $plan[0] -is [System.Array]) { $plan = @($plan[0]) }
$entries = @{}
$snapshot = [MemGuardOrphanKill]::CreateToolhelp32Snapshot(0x00000002, 0)
if ($snapshot -ne [IntPtr](-1)) {
  $entry = New-Object MemGuardOrphanKill+PROCESSENTRY32W
  $entry.dwSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardOrphanKill+PROCESSENTRY32W])
  try {
    if ([MemGuardOrphanKill]::Process32FirstW($snapshot, [ref]$entry)) {
      do {
        $entries[[int]$entry.th32ProcessID] = [ordered]@{
          parentPid = [int]$entry.th32ParentProcessID
          name = [string]$entry.szExeFile
        }
      } while ([MemGuardOrphanKill]::Process32NextW($snapshot, [ref]$entry))
    }
  } finally {
    [void][MemGuardOrphanKill]::CloseHandle($snapshot)
  }
}

function Get-Identity([int]$processId) {
  $identity = [ordered]@{ exePath = $null; createdTicks = [int64]0 }
  $handle = [MemGuardOrphanKill]::OpenProcess(0x1000, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) { return $identity }
  try {
    $builder = New-Object System.Text.StringBuilder 1024
    $size = [int]$builder.Capacity
    if ([MemGuardOrphanKill]::QueryFullProcessImageNameW($handle, 0, $builder, [ref]$size)) {
      $identity.exePath = [string]$builder.ToString()
    }
    $creation = New-Object MemGuardOrphanKill+FILETIME
    $exitTime = New-Object MemGuardOrphanKill+FILETIME
    $kernel = New-Object MemGuardOrphanKill+FILETIME
    $user = New-Object MemGuardOrphanKill+FILETIME
    if ([MemGuardOrphanKill]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
      $identity.createdTicks = ([int64]$creation.dwHighDateTime -shl 32) -bor [int64]$creation.dwLowDateTime
    }
  } finally {
    [void][MemGuardOrphanKill]::CloseHandle($handle)
  }
  return $identity
}

function Normalize-Root([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return $value.Trim().TrimEnd('\', '/')
}

function Test-UnderRoot([string]$path, [string]$root) {
  if ([string]::IsNullOrEmpty($path) -or [string]::IsNullOrEmpty($root)) { return $false }
  return $path.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

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
    if ($tree.Contains([int]$entries[$key].parentPid)) {
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

# Same rule as the scan: real image directories of the Host / main process win;
# the caller's RootPath is only a fallback because Node's execPath may be a
# symlink and the enumerated path is the final target.
$rootCandidates = New-Object System.Collections.ArrayList
foreach ($rootPid in $roots) {
  if (-not $entries.ContainsKey($rootPid)) { continue }
  $identity = Get-Identity($rootPid)
  if (-not [string]::IsNullOrEmpty($identity.exePath)) {
    [void]$rootCandidates.Add((Normalize-Root ([System.IO.Path]::GetDirectoryName($identity.exePath))))
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

$cache = @{}
function Get-CachedIdentity([int]$processId) {
  if (-not $cache.ContainsKey($processId)) { $cache[$processId] = Get-Identity($processId) }
  return $cache[$processId]
}

function Test-OrphanChain([int]$processId, [int]$depth) {
  if ($depth -gt 64) { return $false }
  if ($tree.Contains($processId) -or $ancestors.Contains($processId)) { return $false }
  if (-not $entries.ContainsKey($processId)) { return $false }
  $identity = Get-CachedIdentity($processId)
  if (-not (Test-UnderRoot $identity.exePath $installRoot)) { return $false }
  $parent = [int]$entries[$processId].parentPid
  if (-not $entries.ContainsKey($parent)) { return $true }
  $parentIdentity = Get-CachedIdentity($parent)
  if (-not (Test-UnderRoot $parentIdentity.exePath $installRoot)) { return $false }
  return (Test-OrphanChain $parent ($depth + 1))
}

$killed = 0
$skipped = 0
$failed = 0
$lastCode = 'nothing-killed'

foreach ($item in @($plan)) {
  if ($null -eq $item) { continue }
  $target = [int]$item.pid
  $expectedName = [string]$item.name
  if ($expectedName.ToLowerInvariant().EndsWith('.exe')) {
    $expectedName = $expectedName.Substring(0, $expectedName.Length - 4)
  }
  if ($target -le 4 -or $target -eq $HostPid -or $target -eq $MainPid -or $target -eq $PID) {
    $skipped += 1
    $lastCode = 'protected-process'
    continue
  }
  if (-not $entries.ContainsKey($target)) {
    $skipped += 1
    $lastCode = 'not-found'
    continue
  }
  $entry = $entries[$target]
  if (([string]$entry.name).ToLowerInvariant().Replace('.exe', '') -ne $expectedName.ToLowerInvariant()) {
    $skipped += 1
    $lastCode = 'name-mismatch'
    continue
  }
  $identity = Get-CachedIdentity($target)
  if ([string]$identity.createdTicks -ne [string]$item.createdAt) {
    $skipped += 1
    $lastCode = 'creation-mismatch'
    continue
  }
  if (-not (Test-UnderRoot $identity.exePath $installRoot)) {
    $skipped += 1
    $lastCode = 'outside-root'
    continue
  }
  if ($tree.Contains($target) -or $ancestors.Contains($target)) {
    $skipped += 1
    $lastCode = 'in-current-tree'
    continue
  }
  if (-not (Test-OrphanChain $target 0)) {
    $skipped += 1
    $lastCode = 'in-current-tree'
    continue
  }
  try {
    Stop-Process -Id $target -Force -ErrorAction Stop
    $killed += 1
    $lastCode = 'killed'
  } catch {
    $failed += 1
    $lastCode = 'kill-failed'
  }
}

$ok = $killed -gt 0
[pscustomobject]@{
  ok = $ok
  code = $lastCode
  killed = $killed
  skipped = $skipped
  failed = $failed
} | ConvertTo-Json -Compress
