param(
  [int]$Days = 7,
  [int]$Limit = 40,
  [string]$LogDir = ''
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($LogDir -eq '') {
  $LogDir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'
}
$daysValue = [Math]::Max(1, [Math]::Min(30, $Days))
$limitValue = [Math]::Max(1, [Math]::Min(100, $Limit))
$since = (Get-Date).AddDays(-1 * $daysValue)

$logs = New-Object System.Collections.ArrayList
if (Test-Path -LiteralPath $LogDir) {
  $files = @(Get-ChildItem -LiteralPath $LogDir -Force -Filter 'crash-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $since } |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First $limitValue)
  foreach ($file in $files) {
    $head = ''
    try {
      $lines = @(Get-Content -LiteralPath $file.FullName -TotalCount 80 -Encoding UTF8 -ErrorAction Stop)
      $head = ($lines -join "`n")
      if ($head.Length -gt 2000) { $head = $head.Substring(0, 2000) }
    } catch {
    }
    [void]$logs.Add([pscustomobject]@{
      name = [string]$file.Name
      at = ([DateTimeOffset]$file.LastWriteTimeUtc).ToUnixTimeMilliseconds()
      size = [int64]$file.Length
      head = $head
    })
  }
}

$events = New-Object System.Collections.ArrayList
try {
  $records = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since; Id = 41, 2004, 26 } -MaxEvents 60 -ErrorAction Stop)
  foreach ($record in $records) {
    $message = [string]$record.Message
    if ($message.Length -gt 400) { $message = $message.Substring(0, 400) }
    $level = 0
    if ($record.Level -ne $null) { $level = [int]$record.Level }
    [void]$events.Add([pscustomobject]@{
      at = ([DateTimeOffset]$record.TimeCreated.ToUniversalTime()).ToUnixTimeMilliseconds()
      id = [int]$record.Id
      level = $level
      provider = [string]$record.ProviderName
      message = $message
    })
  }
} catch {
}

# Application log: 1000 (Application Error) and 1001 (WER report) name the
# faulting module, which is the only cheap way to learn *where* a crash happened.
$faults = New-Object System.Collections.ArrayList
try {
  $records = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Id = 1000, 1001, 1002 } -MaxEvents 80 -ErrorAction Stop)
  foreach ($record in $records) {
    $message = [string]$record.Message
    $app = $null
    $appMatch = [regex]::Match($message, 'Faulting application name:\s*([^,\r\n]+)')
    if ($appMatch.Success) { $app = $appMatch.Groups[1].Value.Trim() }
    $module = $null
    $moduleMatch = [regex]::Match($message, 'Faulting module name:\s*([^,\r\n]+)')
    if ($moduleMatch.Success) { $module = $moduleMatch.Groups[1].Value.Trim() }
    $exception = $null
    $exceptionMatch = [regex]::Match($message, 'Exception code:\s*(0x[0-9a-fA-F]+)')
    if ($exceptionMatch.Success) { $exception = $exceptionMatch.Groups[1].Value.ToLowerInvariant() }
    $bucket = $null
    $bucketMatch = [regex]::Match($message, 'Fault bucket ([0-9]+)')
    if ($bucketMatch.Success) { $bucket = 'bucket-' + $bucketMatch.Groups[1].Value }
    if ($module -eq $null) {
      $moduleMatch = [regex]::Match($message, 'Sig\[3\]\.Value=([^,\r\n]+)')
      if ($moduleMatch.Success) {
        $value = $moduleMatch.Groups[1].Value.Trim()
        if ($value.Length -gt 0 -and $value -ne 'Unknown') { $module = $value }
      }
    }
    $level = 0
    if ($record.Level -ne $null) { $level = [int]$record.Level }
    $head = $message
    if ($head.Length -gt 400) { $head = $head.Substring(0, 400) }
    [void]$faults.Add([pscustomobject]@{
      at = ([DateTimeOffset]$record.TimeCreated.ToUniversalTime()).ToUnixTimeMilliseconds()
      id = [int]$record.Id
      level = $level
      provider = [string]$record.ProviderName
      app = $app
      module = $module
      exception = $exception
      bucket = $bucket
      message = $head
    })
  }
} catch {
}

[pscustomobject]@{
  ok = $true
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  logDir = [string]$LogDir
  days = $daysValue
  logs = @($logs)
  events = @($events)
  faults = @($faults)
} | ConvertTo-Json -Depth 5 -Compress
