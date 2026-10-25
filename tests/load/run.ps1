<#
.SYNOPSIS
Runs k6 load-test scenarios against the compose stack, then checks what each run left behind.

.DESCRIPTION
For each scenario: starts the stack with docker-compose.load.yml (and docker-compose.load-capacity.yml, unless the
scenario tests the production rate limits), runs it in the k6 container, and then checks:
  - k6's own thresholds and checks (its exit code);
  - Postgres connections, sampled every 2 s during the run, never took every connection Postgres allows;
  - the API and nginx logged no errors during the run;
  - checks/<scenario>.sql, if there is one, prints no rows;
  - after making everything the run created due for purging and restarting the API (whose purge runs at start),
    the purge removes all of it in one pass, and storage holds no object or unfinished upload from the run.
    -NoPurge skips this and keeps the run's bundles.
k6 sends its metrics to Prometheus as it runs (the "FileHolder load tests" dashboard in Grafana), and its summary of
each run is saved in tests/load/results. Afterwards the stack is started with its usual configuration again
(docker-compose.yml plus your docker-compose.override.yml), unless -KeepLoadConfig is given.

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

    # Keep the run's bundles and files instead of purging them, e.g. to look at them.
    [switch] $NoPurge,

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

# Runs a SQL file with the run's id and start time set, as :'run_id' and :'since'.
function Invoke-PsqlFile([string] $path, [string] $runId, [string] $since) {
    Invoke-Psql ("\set run_id '$runId'`n\set since '$since'`n" + (Get-Content $path -Raw))
}

# Objects (or, with -Incomplete, unfinished multipart uploads) in the bucket written at or after $since.
function Get-StorageEntriesSince([string] $since, [switch] $Incomplete) {
    $flag = if ($Incomplete) { '--incomplete ' } else { '' }
    $list = 'mc alias set lt http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ' +
        "mc ls $flag--recursive --json lt/fileholder-bucket"
    $start = [DateTimeOffset]::Parse($since)
    docker exec fileholder-minio sh -c $list |
        Where-Object { $_.Trim().StartsWith('{') } |
        ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.key -and [DateTimeOffset]::Parse($_.lastModified) -ge $start }
}

# Makes everything the run created due, restarts the API so its purge runs, and checks that one pass removed it all.
function Invoke-RunPurge([string[]] $composeArgs, [string] $runId, [string] $since) {
    $failures = @()
    $expired = Invoke-PsqlFile (Join-Path $PSScriptRoot 'lib\expire-run.sql') $runId $since
    if ($LASTEXITCODE -ne 0) {
        return @("lib/expire-run.sql failed: $($expired -join ' ')")
    }

    & docker @($composeArgs + @('restart', 'api')) 2>&1 | Out-Null
    & docker @($composeArgs + @('up', '-d', '--wait', 'api')) 2>&1 | Out-Null

    # The pass starts with the API; give it a little while to finish.
    $remaining = $null
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 5
        $remaining = [int](Invoke-PsqlFile (Join-Path $PSScriptRoot 'lib\purge-remaining.sql') $runId $since | Select-Object -First 1)
    } while ($remaining -gt 0 -and (Get-Date) -lt $deadline)

    if ($remaining -gt 0) {
        $failures += "one purge pass left $remaining of the run's bundles, pending uploads or multipart sessions"
    }

    $objects = @(Get-StorageEntriesSince $since)
    if ($objects.Count -gt 0) {
        $failures += "storage still holds $($objects.Count) object(s) from the run, e.g. $($objects[0].key)"
    }
    $incomplete = @(Get-StorageEntriesSince $since -Incomplete)
    if ($incomplete.Count -gt 0) {
        $failures += "storage still holds $($incomplete.Count) unfinished multipart upload(s) from the run, e.g. $($incomplete[0].key)"
    }
    return $failures
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
    # The database's clock, which rows are stamped with; storage and the logs run on the same Docker host.
    $since = Invoke-Psql "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD""T""HH24:MI:SS.MS""Z""')" | Select-Object -First 1
    $sampler = Start-ConnectionSampler

    $envArgs = @('-e', "RUN_ID=$runId")
    foreach ($pair in ($K6Env | ForEach-Object { $_ -split ',' })) {
        $envArgs += @('-e', $pair)
    }
    # Metrics go to Prometheus as the run goes, tagged with the run id (the dashboard's "Run" picker).
    $runArgs = $composeArgs + @('--profile', 'load', 'run', '--rm') + $envArgs +
        @('k6', 'run', '-o', 'experimental-prometheus-rw', '--tag', "testid=$runId",
          '--summary-export', "/results/$name-$runId.json", "/scripts/scenarios/$name.js")
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

    # nginx logs errors to stderr: failed connections to the API, and responses it had to spool to disk, which
    # it must never do for a streamed ZIP (proxy_buffering off).
    $nginxArgs = $composeArgs + @('logs', '--no-color', '--since', $since, 'ui')
    $nginxErrors = @(& docker @nginxArgs 2>&1 | ForEach-Object { "$_" } |
        Where-Object { $_ -match '\[(error|crit|alert|emerg)\]|buffered to a temporary file' })
    if ($nginxErrors.Count -gt 0) {
        $failures += "nginx logged $($nginxErrors.Count) error line(s), e.g.: $($nginxErrors[0])"
    }

    $sqlFile = Join-Path $checkDir "$name.sql"
    if (Test-Path $sqlFile) {
        # The checks find the run's bundles by the run id or start time, which they read as :'run_id' and :'since'.
        $sqlRows = @(Invoke-PsqlFile $sqlFile $runId $since | Where-Object { $_.Trim() -ne '' })
        if ($LASTEXITCODE -ne 0) {
            $failures += "checks/$name.sql failed to run: $($sqlRows -join ' ')"
        } else {
            $failures += $sqlRows | ForEach-Object { "database: $_" }
        }
    }

    if (-not $NoPurge) {
        $failures += @(Invoke-RunPurge $composeArgs $runId $since | Where-Object { $_ })
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
    & docker compose -p $project up -d --wait api ui prometheus
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
if (@($results | Where-Object { $_.Result -ne 'pass' }).Count -gt 0) {
    exit 1
}
