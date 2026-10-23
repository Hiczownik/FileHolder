<#
.SYNOPSIS
Runs k6 load-test scenarios against the compose stack, then checks what each run left behind.

.DESCRIPTION
For each scenario: starts the stack with docker-compose.load.yml (and docker-compose.load-capacity.yml, unless the
scenario tests the production rate limits), runs it in the k6 container, and then checks:
  - k6's own thresholds and checks (its exit code);
  - Postgres connections, sampled every 2 s during the run, never took every connection Postgres allows;
  - the API logged no errors during the run;
  - checks/<scenario>.sql, if there is one, prints no rows.
k6's summary of each run is saved in tests/load/results. Afterwards the stack is started with its usual
configuration again (docker-compose.yml plus your docker-compose.override.yml), unless -KeepLoadConfig is given.

Works in Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
./tests/load/run.ps1 4
./tests/load/run.ps1 4,5,6,9
./tests/load/run.ps1 all -Build
./tests/load/run.ps1 04-download-race -K6Env BURSTS=2,CLIENTS=20
#>
param(
    # Scenario numbers or names (04-download-race), or "all".
    [Parameter(Position = 0)]
    [string[]] $Scenario = @('all'),

    # Rebuild the API and UI images first.
    [switch] $Build,

    # Leave the stack running with the load-test configuration (presigned URLs for minio:9000, raised limits).
    [switch] $KeepLoadConfig,

    # Extra environment variables for the scenario, as NAME=value.
    [string[]] $K6Env = @()
)

# Native commands report failure through $LASTEXITCODE, which is checked after each; with "Stop", Windows
# PowerShell 5.1 would treat the progress k6 and docker write to stderr as a terminating error.
$ErrorActionPreference = 'Continue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$scenarioDir = Join-Path $PSScriptRoot 'scenarios'
$checkDir = Join-Path $PSScriptRoot 'checks'
$resultDir = Join-Path $PSScriptRoot 'results'

# The compose file pins container names, so every checkout shares one stack: use its usual project name.
$project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'fileholder' }

# Scenarios that test the production rate limits; every other one runs with the raised limits.
$productionLimitScenarios = @('09-rate-limits')

function Resolve-Scenarios([string[]] $names) {
    $all = Get-ChildItem $scenarioDir -Filter '*.js' | Sort-Object Name | ForEach-Object { $_.BaseName }
    if ($names -contains 'all') {
        return $all
    }
    foreach ($name in ($names | ForEach-Object { $_ -split ',' })) {
        $match = $all | Where-Object { $_ -eq $name -or $_ -match ('^0*' + [regex]::Escape($name.TrimStart('0')) + '-') }
        if (-not $match) {
            throw "No scenario '$name' in $scenarioDir. Scenarios: $($all -join ', ')"
        }
        $match
    }
}

function Get-ComposeArgs([string] $name) {
    $composeArgs = @('compose', '-p', $project, '-f', 'docker-compose.yml', '-f', 'docker-compose.load.yml')
    if ($productionLimitScenarios -notcontains $name) {
        $composeArgs += @('-f', 'docker-compose.load-capacity.yml')
    }
    return $composeArgs
}

function Invoke-Psql([string] $sql) {
    $sql | docker exec -i fileholder-postgres psql -U fileholder_user -d fileholder_db -v ON_ERROR_STOP=1 -At -f - 2>&1 |
        ForEach-Object { "$_" }
}

# Counts the database's backend processes rather than asking Postgres: a query needs a connection of its own,
# which is refused exactly when the count matters, once every connection is taken.
function Start-ConnectionSampler {
    Start-Job -ScriptBlock {
        while ($true) {
            docker exec fileholder-postgres sh -c "ps -o args | grep -c '^postgres: fileholder_user fileholder_db'"
            Start-Sleep -Seconds 2
        }
    }
}

function Stop-ConnectionSampler($job) {
    Stop-Job $job
    $samples = @(Receive-Job $job | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    Remove-Job $job
    if ($samples.Count -eq 0) {
        return $null
    }
    return ($samples | Measure-Object -Maximum).Maximum
}

Set-Location $repoRoot
New-Item -ItemType Directory -Force $resultDir | Out-Null

$results = @()
foreach ($name in (Resolve-Scenarios $Scenario)) {
    $composeArgs = Get-ComposeArgs $name
    $limits = if ($productionLimitScenarios -contains $name) { 'production' } else { 'raised' }
    Write-Host ""
    Write-Host "=== $name (rate limits: $limits)" -ForegroundColor Cyan

    $upArgs = $composeArgs + @('up', '-d', '--wait')
    if ($Build) {
        $upArgs += '--build'
    }
    & docker @upArgs api ui prometheus
    if ($LASTEXITCODE -ne 0) {
        throw "The stack didn't start (docker compose up exited with $LASTEXITCODE)."
    }

    $maxAllowed = [int](Invoke-Psql 'SHOW max_connections' | Select-Object -First 1)

    $runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $name.Split('-')[0]
    $since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $sampler = Start-ConnectionSampler

    $envArgs = @('-e', "RUN_ID=$runId")
    foreach ($pair in ($K6Env | ForEach-Object { $_ -split ',' })) {
        $envArgs += @('-e', $pair)
    }
    $runArgs = $composeArgs + @('--profile', 'load', 'run', '--rm') + $envArgs +
        @('k6', 'run', '--summary-export', "/results/$name-$runId.json", "/scripts/scenarios/$name.js")
    & docker @runArgs
    $k6Exit = $LASTEXITCODE

    $maxConnections = Stop-ConnectionSampler $sampler
    $failures = @()

    if ($k6Exit -ne 0) {
        $failures += "k6 exited with $k6Exit (99 means a threshold or check failed)"
    }

    if ($null -eq $maxConnections) {
        $failures += 'no Postgres connection samples were taken'
    } elseif ($maxConnections -ge $maxAllowed) {
        $failures += "the API took all $maxAllowed connections Postgres allows, so nothing else could connect"
    }

    $logArgs = $composeArgs + @('logs', '--no-color', '--since', $since, 'api')
    $errorLines = @(& docker @logArgs 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match ' (ERR|FTL)\]|Unhandled exception' })
    if ($errorLines.Count -gt 0) {
        $failures += "the API logged $($errorLines.Count) error line(s), e.g.: $($errorLines[0])"
    }

    $sqlFile = Join-Path $checkDir "$name.sql"
    if (Test-Path $sqlFile) {
        # The checks find the run's bundles by the run id, which they read as :'run_id'.
        $sqlRows = @(Invoke-Psql ("\set run_id '$runId'`n" + (Get-Content $sqlFile -Raw)) | Where-Object { $_.Trim() -ne '' })
        if ($LASTEXITCODE -ne 0) {
            $failures += "checks/$name.sql failed to run: $($sqlRows -join ' ')"
        } else {
            $failures += $sqlRows | ForEach-Object { "database: $_" }
        }
    }

    foreach ($failure in $failures) {
        Write-Host "FAIL $failure" -ForegroundColor Red
    }
    $results += [pscustomobject]@{
        Scenario       = $name
        RunId          = $runId
        Result         = if ($failures.Count -eq 0) { 'pass' } else { 'FAIL' }
        MaxConnections = "$maxConnections of $maxAllowed"
        Failures       = $failures.Count
    }
}

if (-not $KeepLoadConfig) {
    Write-Host ""
    Write-Host 'Starting the API with its usual configuration again (-KeepLoadConfig skips this).'
    & docker compose -p $project up -d --wait api ui
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
if (@($results | Where-Object { $_.Result -ne 'pass' }).Count -gt 0) {
    exit 1
}
