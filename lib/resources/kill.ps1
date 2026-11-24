param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$ExpectedName
)

$ErrorActionPreference = 'Stop'

# Compare inside PowerShell so a pid that got recycled by another program is
# refused instead of silently killing the wrong process. Output stays ASCII:
# the panel only needs the code, never the (possibly non-ASCII) name.
$expected = $ExpectedName
if ($expected.ToLowerInvariant().EndsWith('.exe')) {
  $expected = $expected.Substring(0, $expected.Length - 4)
}

function Emit([bool]$Ok, [string]$Code) {
  [pscustomobject]@{ ok = $Ok; code = $Code; pid = $TargetPid } | ConvertTo-Json -Compress
}

try {
  $process = Get-Process -Id $TargetPid -ErrorAction Stop
} catch {
  Emit $false 'not-found'
  exit 0
}

if ($process.ProcessName -ne $expected) {
  Emit $false 'name-mismatch'
  exit 0
}

try {
  Stop-Process -Id $TargetPid -Force -ErrorAction Stop
} catch {
  Emit $false 'kill-failed'
  exit 0
}

Emit $true 'killed'
