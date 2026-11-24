param(
  [Parameter(Mandatory = $true)][string]$PlanJson
)

$ErrorActionPreference = 'Stop'

# Each item is verified against its own pid before Stop-Process runs, so a
# recycled pid is skipped rather than killed. Output stays ASCII: the caller
# only needs the counters.
$plan = ConvertFrom-Json $PlanJson
$killed = 0
$skipped = 0
$failed = 0

foreach ($item in @($plan)) {
  $target = [int]$item.pid
  $expected = [string]$item.name
  if ($expected.ToLowerInvariant().EndsWith('.exe')) {
    $expected = $expected.Substring(0, $expected.Length - 4)
  }
  try {
    $process = Get-Process -Id $target -ErrorAction Stop
  } catch {
    $skipped += 1
    continue
  }
  if ($process.ProcessName -ne $expected) {
    $skipped += 1
    continue
  }
  try {
    Stop-Process -Id $target -Force -ErrorAction Stop
    $killed += 1
  } catch {
    $failed += 1
  }
}

[pscustomobject]@{ ok = ($killed -gt 0); killed = $killed; skipped = $skipped; failed = $failed } | ConvertTo-Json -Compress
