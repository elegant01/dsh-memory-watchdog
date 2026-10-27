param(
  [Parameter(Mandatory = $true)][string]$RequestFile
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MemGuardRelaunch {
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

  static string QuoteArg(string arg) {
    if (arg == null) return "\"\"";
    if (arg.Length == 0) return "\"\"";
    if (arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
    StringBuilder sb = new StringBuilder();
    sb.Append('"');
    int backslashes = 0;
    for (int i = 0; i < arg.Length; i++) {
      char c = arg[i];
      if (c == '\\') {
        backslashes++;
        sb.Append(c);
        continue;
      }
      if (c == '"') {
        sb.Append('\\', backslashes);
        sb.Append("\\\"");
        backslashes = 0;
        continue;
      }
      backslashes = 0;
      sb.Append(c);
    }
    sb.Append('\\', backslashes);
    sb.Append('"');
    return sb.ToString();
  }

  public static string BuildCommandLine(string exe, string[] args) {
    StringBuilder sb = new StringBuilder();
    sb.Append(QuoteArg(exe));
    if (args != null) {
      for (int i = 0; i < args.Length; i++) {
        sb.Append(' ');
        sb.Append(QuoteArg(args[i]));
      }
    }
    return sb.ToString();
  }

  public static int Start(string exe, string[] args, string workingDir, string[] env, out bool inJob, out string error) {
    inJob = false;
    error = null;
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    uint flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_UNICODE_ENVIRONMENT;

    IntPtr envBlock = IntPtr.Zero;
    int envCount = 0;
    if (env != null && env.Length > 0) {
      List<string> entries = new List<string>();
      for (int i = 0; i < env.Length; i++) {
        if (!string.IsNullOrEmpty(env[i]) && env[i].IndexOf('=') > 0) entries.Add(env[i]);
      }
      entries.Sort(StringComparer.OrdinalIgnoreCase);
      StringBuilder block = new StringBuilder();
      foreach (string entry in entries) block.Append(entry).Append('\0');
      block.Append('\0');
      envBlock = Marshal.StringToHGlobalUni(block.ToString());
      envCount = entries.Count;
    }

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    string commandLine = BuildCommandLine(exe, args);
    bool ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, envBlock,
      string.IsNullOrEmpty(workingDir) ? null : workingDir, ref si, out pi);
    if (envBlock != IntPtr.Zero) Marshal.FreeHGlobal(envBlock);
    if (!ok) {
      error = "CreateProcessW failed with error " + Marshal.GetLastWin32Error();
      return 0;
    }
    try {
      bool job;
      if (IsProcessInJob(pi.hProcess, IntPtr.Zero, out job)) inJob = job;
      else error = "IsProcessInJob failed with error " + Marshal.GetLastWin32Error();
      return pi.dwProcessId;
    } finally {
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
    }
  }
}
"@

try {
  if (-not (Test-Path -LiteralPath $RequestFile)) { throw "request file not found" }
  $request = [System.IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json
  $exe = [string]$request.exe
  if ([string]::IsNullOrWhiteSpace($exe)) { throw "request exe is empty" }
  $argsOut = @()
  if ($request.args -ne $null) { $argsOut = @($request.args | ForEach-Object { [string]$_ }) }
  $cwdOut = [string]$request.cwd
  $envOut = @()
  if ($request.env -ne $null) { $envOut = @($request.env | ForEach-Object { [string]$_ }) }

  $inJob = $true
  $spawnError = $null
  $newPid = [MemGuardRelaunch]::Start($exe, [string[]]$argsOut, $cwdOut, [string[]]$envOut, [ref]$inJob, [ref]$spawnError)
  if ($newPid -le 0) {
    [ordered]@{ ok = $false; pid = $null; inJob = $null; error = $spawnError } | ConvertTo-Json -Compress
  } else {
    [ordered]@{ ok = $true; pid = $newPid; inJob = $inJob; error = $null } | ConvertTo-Json -Compress
  }
} catch {
  [ordered]@{ ok = $false; pid = $null; inJob = $null; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
exit 0
