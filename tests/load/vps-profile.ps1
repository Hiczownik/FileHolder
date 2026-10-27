<#
.SYNOPSIS
Measures what the production server (2 vCPU, 4 GB) can handle, with the k6 scenarios on this machine.

.DESCRIPTION
Runs the production setup locally (scripts/prod-local.ps1's project, fileholder-prodtest) with
docker-compose.load-vps.yml: every container the server runs is pinned to the same two cores, storage (standing in for
R2) and k6 (the visitors) get cores of their own, and the per-address rate limits are raised, because all k6 traffic
comes from one address. Requests go through Caddy over HTTPS, as visitors' do.

Each run's k6 summary goes to tests/load/results as vps-<run>.json, and the table at the end shows its request rate,
latencies, failures and the server's CPU use (out of 200%: two cores). These are capacity measurements, not
correctness checks: run.ps1 does those.

This machine's cores are faster than the VPS's: compare a single-core benchmark on both (tests/load/README.md,
"On the production server's resources") and scale the request rates by it.

Needs .env.prod-local (made by scripts/prod-local.ps1 up). Its own stack is removed again at the end unless -Keep.

.EXAMPLE
./tests/load/vps-profile.ps1
./tests/load/vps-profile.ps1 -Run 6-300,6-600 -Keep
#>
param(
    # Which runs, by name (see $runs below), or all.
    [string[]] $Run = @('all'),

    # Leave the stack running afterwards (it's removed with its volumes otherwise).
    [switch] $Keep
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$resultDir = Join-Path $PSScriptRoot 'results'
$envFile = Join-Path $root '.env.prod-local'
if (-not (Test-Path $envFile)) { throw 'No .env.prod-local: run scripts/prod-local.ps1 up once first.' }

$compose = @('compose', '--project-name', 'fileholder-prodtest', '--project-directory', $root,
    '--file', (Join-Path $root 'docker-compose.prod.yml'), '--file', (Join-Path $root 'docker-compose.prod-local.yml'),
    '--file', (Join-Path $root 'docker-compose.load-vps.yml'), '--env-file', $envFile)
$serverContainers = @('caddy', 'ui', 'api', 'postgres', 'prometheus', 'tempo', 'sample') |
    ForEach-Object { "fileholder-prodtest-$_-1" }
# The same k6 the load tests pin (docker-compose.yml).
$k6Image = ([regex]::Match((Get-Content (Join-Path $root 'docker-compose.yml') -Raw), 'grafana/k6:[^\s"]+')).Value

# Each run: a scenario with its settings, sized for two cores and for this machine's disk.
$runs = [ordered]@{
    # Bundle pages: known and unknown links at a fixed rate, stepped up until the server can't keep up.
    '6-150'  = @{ Scenario = '06-bundle-info'; Env = @('DURATION=1m', 'KNOWN_RATE=50', 'UNKNOWN_RATE=100', 'KNOWN_P95_MS=1000', 'UNKNOWN_P95_MS=1000') }
    '6-300'  = @{ Scenario = '06-bundle-info'; Env = @('DURATION=1m', 'KNOWN_RATE=100', 'UNKNOWN_RATE=200', 'KNOWN_P95_MS=1000', 'UNKNOWN_P95_MS=1000') }
    '6-600'  = @{ Scenario = '06-bundle-info'; Env = @('DURATION=1m', 'KNOWN_RATE=200', 'UNKNOWN_RATE=400', 'KNOWN_P95_MS=1000', 'UNKNOWN_P95_MS=1000') }
    '6-1200' = @{ Scenario = '06-bundle-info'; Env = @('DURATION=1m', 'KNOWN_RATE=400', 'UNKNOWN_RATE=800', 'KNOWN_P95_MS=1000', 'UNKNOWN_P95_MS=1000') }
    # Realistic traffic: the scenario's default mix of uploads (30% encrypted) and downloads.
    '3-mixed' = @{ Scenario = '03-mixed'; Env = @('DURATION=10m') }
    # Uploads of 50-file bundles, ramping to 10 clients: mostly the cost of confirm.
    '1-uploads' = @{ Scenario = '01-small-files'; Env = @('DURATION=3m', 'CLIENTS=10', 'CONFIRM_P95_MS=60000') }
    # A password-guessing attack: bcrypt is slow on purpose, so the heaviest work per request.
    '5-guessing' = @{ Scenario = '05-password-guessing'; Env = @() }
    # Server-built ZIPs of plain bundles, which stream through the API: 10 at once, 200 MB each.
    '7-zips' = @{ Scenario = '07-zip-streaming'; Env = @('CLIENTS=10', 'FILES=4', 'FILE_SIZE=52428800') }
}
$selected = if ($Run -contains 'all') { @($runs.Keys) } else { @($Run | ForEach-Object { $_ -split ',' }) }

# Samples the server containers' CPU use every few seconds; their sum is out of 200% (two cores).
function Start-CpuSampler {
    Start-Job -ArgumentList (, $serverContainers) -ScriptBlock {
        param($names)
        while ($true) {
            $total = 0.0
            docker stats --no-stream --format '{{.CPUPerc}}' @names 2>$null | ForEach-Object {
                $total += [double]($_.TrimEnd('%'))
            }
            [math]::Round($total)
            Start-Sleep -Seconds 2
        }
    }
}

function Stop-CpuSampler($job) {
    Stop-Job $job
    $samples = @(Receive-Job $job | Where-Object { $_ -is [double] -or $_ -match '^\d+$' } | ForEach-Object { [double]$_ })
    Remove-Job $job
    if ($samples.Count -eq 0) { return @{ Max = $null; Avg = $null } }
    $stats = $samples | Measure-Object -Maximum -Average
    return @{ Max = [math]::Round($stats.Maximum); Avg = [math]::Round($stats.Average) }
}

function Get-P95($metric) {
    if ($null -eq $metric) { return $null }
    return [math]::Round($metric.'p(95)', 1)
}

Set-Location $root
New-Item -ItemType Directory -Force $resultDir | Out-Null

# k6 joins Caddy's network namespace, so https://localhost reaches Caddy under the name its certificate has.
$caddy = 'fileholder-prodtest-caddy-1'

$results = @()
try {
    Write-Host 'Starting the production setup on two cores (this builds the images)...' -ForegroundColor Cyan
    $env:GIT_SHA = (git rev-parse --short HEAD).Trim()
    & docker @compose up --build --detach --wait
    if ($LASTEXITCODE -ne 0) { throw 'The stack did not come up healthy; see docker compose logs.' }

    foreach ($name in $selected) {
        if (-not $runs.Contains($name)) { throw "No run '$name'. Runs: $($runs.Keys -join ', ')" }
        $spec = $runs[$name]
        $runId = '{0}-vps-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $name
        Write-Host ""
        Write-Host "=== $name ($($spec.Scenario) $($spec.Env -join ' '))" -ForegroundColor Cyan

        $envArgs = @('-e', 'FILEHOLDER_URL=https://localhost', '-e', 'K6_INSECURE_SKIP_TLS_VERIFY=true',
            '-e', 'PROMETHEUS_URL=http://prometheus:9090', '-e', "RUN_ID=$runId")
        foreach ($pair in $spec.Env) { $envArgs += @('-e', $pair) }

        $sampler = Start-CpuSampler
        & docker run --rm --name "fileholder-prodtest-k6-$name" --network "container:$caddy" --cpuset-cpus '4-11' `
            -v "$($PSScriptRoot):/scripts:ro" -v "$($resultDir):/results" @envArgs $k6Image `
            run --quiet --summary-export "/results/vps-$name.json" "/scripts/scenarios/$($spec.Scenario).js"
        $k6Exit = $LASTEXITCODE
        $cpu = Stop-CpuSampler $sampler

        $summaryPath = Join-Path $resultDir "vps-$name.json"
        $metrics = if (Test-Path $summaryPath) { (Get-Content $summaryPath -Raw | ConvertFrom-Json).metrics } else { $null }
        $byName = @()
        if ($metrics) {
            $byName = $metrics.PSObject.Properties | Where-Object { $_.Name -like 'http_req_duration{name:*' } |
                ForEach-Object { '{0} {1} ms' -f ($_.Name -replace '^http_req_duration\{name:|\}$', ''), (Get-P95 $_.Value) }
        }
        $results += [pscustomobject]@{
            Run         = $name
            'Req/s'     = if ($metrics) { [math]::Round($metrics.http_reqs.rate, 1) } else { $null }
            'p95 ms'    = if ($metrics) { Get-P95 $metrics.http_req_duration } else { $null }
            Failed      = if ($metrics) { $metrics.http_req_failed.value } else { $null }
            Dropped     = if ($metrics -and $metrics.dropped_iterations) { $metrics.dropped_iterations.count } else { 0 }
            'CPU max %' = $cpu.Max
            'CPU avg %' = $cpu.Avg
            k6          = $k6Exit
            'p95 by request' = ($byName -join '; ')
        }
    }
}
finally {
    if (-not $Keep) {
        Write-Host ""
        Write-Host 'Removing the measurement stack and its volumes (-Keep leaves it running).'
        & docker @compose down --volumes 2>&1 | Out-Null
    }
}

Write-Host ""
$results | Format-List | Out-String | Write-Host
