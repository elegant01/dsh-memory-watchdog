param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MemGuardEscape {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string applicationName, string commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDir,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  public static bool SelfInJob(out int error) {
    bool result;
    error = 0;
    if (!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out result)) {
      error = Marshal.GetLastWin32Error();
      return false;
    }
    return result;
  }

  public static int SpawnProbe(string commandLine, string workingDir, bool breakaway, out bool inJob, out int error) {
    inJob = false;
    error = 0;
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    uint flags = CREATE_NO_WINDOW | (breakaway ? CREATE_BREAKAWAY_FROM_JOB : 0);
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workingDir, ref si, out pi)) {
      error = Marshal.GetLastWin32Error();
      return 0;
    }
    try {
      bool job;
      if (IsProcessInJob(pi.hProcess, IntPtr.Zero, out job)) {
        inJob = job;
      } else {
        error = -Marshal.GetLastWin32Error();
      }
      return pi.dwProcessId;
    } finally {
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
    }
  }
}
"@

try {
  $selfError = 0
  $selfInJob = [MemGuardEscape]::SelfInJob([ref]$selfError)
  if ($selfError -ne 0) { throw "IsProcessInJob failed with error $selfError" }

  $comSpec = $env:ComSpec
  if ([string]::IsNullOrWhiteSpace($comSpec)) { $comSpec = "C:\Windows\System32\cmd.exe" }
  $commandLine = '"' + $comSpec + '" /c exit 0'
  # CreateProcessW fails with ERROR_INVALID_NAME (123) when it inherits the current
  # directory, so the no-op child gets an explicit one.
  $workingDir = Split-Path -Parent $comSpec

  $plainError = 0
  $plainInJob = $true
  $plainPid = 0
  try {
    $plainPid = [MemGuardEscape]::SpawnProbe($commandLine, $workingDir, $false, [ref]$plainInJob, [ref]$plainError)
  } catch {
    $plainError = -1
  }
  if ($plainError -lt 0) { $plainInJob = $null }

  $breakawayError = 0
  $breakawayInJob = $true
  $breakawayPid = 0
  try {
    $breakawayPid = [MemGuardEscape]::SpawnProbe($commandLine, $workingDir, $true, [ref]$breakawayInJob, [ref]$breakawayError)
  } catch {
    $breakawayError = -1
  }
  if ($breakawayError -lt 0) { $breakawayInJob = $null }

  [ordered]@{
    ok = $true
    selfInJob = $selfInJob
    plainInJob = $(if ($plainPid -gt 0) { $plainInJob } else { $null })
    plainError = $(if ($plainPid -gt 0) { $null } else { [Math]::Abs($plainError) })
    breakawayOk = ($breakawayPid -gt 0)
    breakawayInJob = $(if ($breakawayPid -gt 0) { $breakawayInJob } else { $null })
    breakawayError = $(if ($breakawayPid -gt 0) { $null } else { [Math]::Abs($breakawayError) })
  } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
exit 0
