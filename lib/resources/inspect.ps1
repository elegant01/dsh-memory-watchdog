param(
  [Parameter(Mandatory = $true)][int]$HostPid,
  [int]$MainPid = 0,
  [switch]$ProbeAccess,
  [int[]]$ExcludePid = @()
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardInspect {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

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

  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool ReadProcessMemory(IntPtr processHandle, IntPtr baseAddress, byte[] buffer, int size, out IntPtr bytesRead);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr processHandle, int flags, StringBuilder exeName, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr processHandle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
"@

function Read-UInt64([IntPtr]$handle, [long]$address) {
  $buffer = New-Object byte[] 8
  $read = [IntPtr]::Zero
  if (-not [MemGuardInspect]::ReadProcessMemory($handle, [IntPtr]$address, $buffer, 8, [ref]$read)) {
    throw ("ReadProcessMemory failed at 0x{0:X}" -f $address)
  }
  return [BitConverter]::ToInt64($buffer, 0)
}

function Read-UInt16([IntPtr]$handle, [long]$address) {
  $buffer = New-Object byte[] 2
  $read = [IntPtr]::Zero
  if (-not [MemGuardInspect]::ReadProcessMemory($handle, [IntPtr]$address, $buffer, 2, [ref]$read)) {
    throw ("ReadProcessMemory failed at 0x{0:X}" -f $address)
  }
  return [BitConverter]::ToUInt16($buffer, 0)
}

function ConvertTo-UnixMs($fileTime) {
  $value = ([uint64]$fileTime.dwHighDateTime -shl 32) -bor [uint64]$fileTime.dwLowDateTime
  if ($value -eq 0) { return 0 }
  return [int64](($value - 116444736000000000) / 10000)
}

function Get-ProcessSnapshot {
  $snapshot = [MemGuardInspect]::CreateToolhelp32Snapshot(0x00000002, 0)
  if ($snapshot -eq [IntPtr](-1)) { throw "CreateToolhelp32Snapshot failed" }
  $entry = New-Object MemGuardInspect+PROCESSENTRY32W
  $entry.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardInspect+PROCESSENTRY32W])
  $result = @{}
  try {
    if ([MemGuardInspect]::Process32FirstW($snapshot, [ref]$entry)) {
      do {
        $result[[int]$entry.th32ProcessID] = [ordered]@{
          pid = [int]$entry.th32ProcessID
          parentPid = [int]$entry.th32ParentProcessID
          name = $entry.szExeFile
        }
      } while ([MemGuardInspect]::Process32NextW($snapshot, [ref]$entry))
    }
  } finally {
    [void][MemGuardInspect]::CloseHandle($snapshot)
  }
  return $result
}

function Get-ProcessInfo([int]$targetPid, $snapshot) {
  $entry = $snapshot[$targetPid]
  if ($null -eq $entry) { throw "process $targetPid is not running" }
  $handle = [MemGuardInspect]::OpenProcess(0x1010, $false, $targetPid)
  if ($handle -eq [IntPtr]::Zero) { throw "OpenProcess failed for $targetPid" }
  try {
    $size = 32768
    $builder = New-Object System.Text.StringBuilder $size
    $exe = $null
    if ([MemGuardInspect]::QueryFullProcessImageNameW($handle, 0, $builder, [ref]$size)) {
      $exe = $builder.ToString()
    }
    $inJob = $false
    [void][MemGuardInspect]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)

    $creation = New-Object MemGuardInspect+FILETIME
    $exitTime = New-Object MemGuardInspect+FILETIME
    $kernel = New-Object MemGuardInspect+FILETIME
    $user = New-Object MemGuardInspect+FILETIME
    $creationMs = 0
    if ([MemGuardInspect]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$user)) {
      $creationMs = ConvertTo-UnixMs $creation
    }

    $commandLine = $null
    $cwd = $null
    $argv = @()
    $pbi = New-Object MemGuardInspect+PROCESS_BASIC_INFORMATION
    $returnLength = 0
    $status = [MemGuardInspect]::NtQueryInformationProcess($handle, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf([type][MemGuardInspect+PROCESS_BASIC_INFORMATION]), [ref]$returnLength)
    if ($status -eq 0) {
      $peb = $pbi.PebBaseAddress.ToInt64()
      $parameters = Read-UInt64 $handle ($peb + 0x20)
      $length = Read-UInt16 $handle ($parameters + 0x70)
      $bufferAddress = Read-UInt64 $handle ($parameters + 0x78)
      if ($length -gt 0 -and $length -le 65536) {
        $buffer = New-Object byte[] $length
        $read = [IntPtr]::Zero
        if ([MemGuardInspect]::ReadProcessMemory($handle, [IntPtr]$bufferAddress, $buffer, $length, [ref]$read)) {
          $commandLine = [Text.Encoding]::Unicode.GetString($buffer)
        }
      }
      $cwdLength = Read-UInt16 $handle ($parameters + 0x38)
      $cwdAddress = Read-UInt64 $handle ($parameters + 0x40)
      if ($cwdLength -gt 0 -and $cwdLength -le 32768) {
        $cwdBuffer = New-Object byte[] $cwdLength
        $read = [IntPtr]::Zero
        if ([MemGuardInspect]::ReadProcessMemory($handle, [IntPtr]$cwdAddress, $cwdBuffer, $cwdLength, [ref]$read)) {
          $cwd = [Text.Encoding]::Unicode.GetString($cwdBuffer)
        }
      }
    }
    if (-not [string]::IsNullOrEmpty($commandLine)) {
      $argc = 0
      $argumentPointer = [MemGuardInspect]::CommandLineToArgvW($commandLine, [ref]$argc)
      if ($argumentPointer -ne [IntPtr]::Zero) {
        try {
          $list = @()
          for ($index = 0; $index -lt $argc; $index++) {
            $item = [Runtime.InteropServices.Marshal]::ReadIntPtr($argumentPointer, $index * [IntPtr]::Size)
            $list += [Runtime.InteropServices.Marshal]::PtrToStringUni($item)
          }
          $argv = $list
        } finally {
          [void][MemGuardInspect]::LocalFree($argumentPointer)
        }
      }
    }
    return [ordered]@{
      pid = $targetPid
      parentPid = [int]$entry.parentPid
      exe = $exe
      creationTime = $creationMs
      commandLine = $commandLine
      argv = $argv
      cwd = $cwd
      inJob = $inJob
    }
  } finally {
    [void][MemGuardInspect]::CloseHandle($handle)
  }
}

function Test-TargetAccess([int]$targetPid) {
  if ($targetPid -le 0) { return $false }
  $handle = [MemGuardInspect]::OpenProcess(0x1811, $false, $targetPid)
  if ($handle -eq [IntPtr]::Zero) { return $false }
  [void][MemGuardInspect]::CloseHandle($handle)
  return $true
}

try {
  if ([IntPtr]::Size -ne 8) { throw "memory guard requires 64-bit PowerShell" }
  $snapshot = Get-ProcessSnapshot
  $hostInfo = Get-ProcessInfo $HostPid $snapshot
  $mainValue = $MainPid
  if ($mainValue -le 0) { $mainValue = $hostInfo.parentPid }
  if ($mainValue -le 0) { throw "unable to resolve the DSH main process" }
  $mainInfo = Get-ProcessInfo $mainValue $snapshot

  $childrenByParent = @{}
  foreach ($entry in $snapshot.Values) {
    $parent = [int]$entry.parentPid
    if (-not $childrenByParent.ContainsKey($parent)) { $childrenByParent[$parent] = @() }
    $childrenByParent[$parent] += [int]$entry.pid
  }
  $descendantIds = New-Object System.Collections.Generic.List[int]
  $stack = New-Object System.Collections.Generic.Stack[int]
  $stack.Push($mainValue)
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    if ($childrenByParent.ContainsKey($current)) {
      foreach ($child in $childrenByParent[$current]) {
        if (-not $descendantIds.Contains($child)) {
          $descendantIds.Add($child)
          $stack.Push($child)
        }
      }
    }
  }

  $allDescendants = @()
  $sameExe = @()
  $mainExe = [string]$mainInfo.exe
  foreach ($descendant in $descendantIds) {
    if ($ExcludePid -contains $descendant) { continue }
    try {
      $info = Get-ProcessInfo $descendant $snapshot
      $record = [ordered]@{
        pid = $info.pid
        creationTime = $info.creationTime
        exe = $info.exe
        isHost = ($info.pid -eq $HostPid)
      }
      $allDescendants += $record
      if (-not [string]::IsNullOrEmpty($info.exe) -and [string]::Equals($info.exe, $mainExe, [System.StringComparison]::OrdinalIgnoreCase)) {
        $sameExe += $record
      }
    } catch {
      $allDescendants += [ordered]@{ pid = $descendant; creationTime = 0; exe = $null; isHost = ($descendant -eq $HostPid) }
    }
  }

  $hostLooksDesktop = $false
  if (-not [string]::IsNullOrEmpty($hostInfo.commandLine)) {
    $hostLooksDesktop = $hostInfo.commandLine.Contains("dsh-desktop-host") -and $hostInfo.commandLine.Contains("--expose-internals")
  }
  $mainLooksDesktop = $false
  if ($mainInfo.argv.Count -gt 0) {
    $mainLooksDesktop = $true
    for ($index = 1; $index -lt $mainInfo.argv.Count; $index++) {
      if ([string]$mainInfo.argv[$index] -like "--type=*") {
        $mainLooksDesktop = $false
        break
      }
    }
  }

  $payload = [ordered]@{
    ok = $true
    host = $hostInfo
    main = $mainInfo
    mainIsParent = ($hostInfo.parentPid -eq $mainInfo.pid)
    sameExe = (-not [string]::IsNullOrEmpty($hostInfo.exe)) -and [string]::Equals($hostInfo.exe, $mainInfo.exe, [System.StringComparison]::OrdinalIgnoreCase)
    hostLooksDesktop = $hostLooksDesktop
    mainLooksDesktop = $mainLooksDesktop
    sameExeDescendants = $sameExe
    allDescendants = $allDescendants
    probeAccess = $null
  }
  if ($ProbeAccess) {
    $payload.probeAccess = [ordered]@{
      main = (Test-TargetAccess $mainInfo.pid)
      host = (Test-TargetAccess $hostInfo.pid)
    }
  }
  $payload | ConvertTo-Json -Depth 6 -Compress
  exit 0
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 0
}
