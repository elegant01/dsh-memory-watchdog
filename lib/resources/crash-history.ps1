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

[pscustomobject]@{
  ok = $true
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  logDir = [string]$LogDir
  days = $daysValue
  logs = @($logs)
  events = @($events)
} | ConvertTo-Json -Depth 5 -Compress
