<#
.SYNOPSIS
    Runs, on this machine, every check CI, the nightly job and the security workflow would run, and ends with a
    pass/fail summary (README, Running the Tests → Before a deploy). For use before deploying while GitHub Actions
    are off; about 25 minutes, unattended.

.DESCRIPTION
    1. Tests: .NET (unit and integration), Vitest, and both property suites at nightly strength (FsCheck 20,000 cases,
       fast-check 10,000 runs).
    2. Dependency audits: NuGet (vulnerable packages, transitive too) and npm (fails on production dependencies,
       warns on development ones).
    3. Browser tests: rebuilds the dev stack from this checkout in CI's setup (docker-compose.ci.yml), runs Playwright
       on Chromium, Firefox and WebKit plus the fault tests, then restarts the stack with its usual files (your
       docker-compose.override.yml included). The stack runs CI's setup for about 10 minutes. -SkipBrowserTests
       leaves it alone.
    4. Image scans (Trivy, the version CI pins): the API, UI and sample-keeper images built here, and the images production runs
       (Caddy, Postgres, Prometheus, Tempo) plus Silo. HIGH and CRITICAL findings that have a fix fail, except those
       accepted in .trivyignore (every image) or docker/trivy/<image>.trivyignore (that image only). -SkipImageScans
       skips them.
    5. Code and secret scans: Semgrep with CI's rule sets, and gitleaks over the whole git history.
    6. DNS for fileholder.app, over HTTPS (port 53 may be blocked): DNSSEC, CAA, DMARC, and the A/AAAA records.

    Every step's output goes to a log folder under %TEMP%\fileholder-pre-deploy-check; the summary names it.
    Exit code 0 when nothing failed.

.EXAMPLE
    scripts/pre-deploy-check.ps1

.EXAMPLE
    scripts/pre-deploy-check.ps1 -SkipBrowserTests
#>
# Named parameters only, as in the other scripts.
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$SkipBrowserTests,
    [switch]$SkipImageScans
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ui = Join-Path $root 'src/fileholder-ui'
$logDir = Join-Path ([IO.Path]::GetTempPath()) "fileholder-pre-deploy-check\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force $logDir | Out-Null

# The Trivy version CI pins (ci.yml), by digest.
$trivy = 'aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c'
# Trivy's vulnerability database, kept between runs so each run downloads only updates.
$trivyCache = 'fileholder-trivy-cache'
$domain = 'fileholder.app'

$results = New-Object System.Collections.Generic.List[object]

# Runs a native command with its output in the step's log. Docker, npm and dotnet report progress on stderr, which
# Windows PowerShell 5.1 would turn into terminating errors; their exit codes say whether they failed.
function Invoke-Logged([string]$log, [scriptblock]$command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $command *>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log }
    finally { $ErrorActionPreference = $previous }
    return $LASTEXITCODE
}

# Runs one step: its script block returns 'PASS', 'WARN' or 'FAIL' and a short detail; an exception is a FAIL.
function Invoke-Step([string]$name, [scriptblock]$body) {
    Write-Host "==> $name" -ForegroundColor Cyan
    $log = Join-Path $logDir (($name -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLowerInvariant() + '.log')
    $started = Get-Date
    try { $status, $detail = & $body $log }
    catch { $status = 'FAIL'; $detail = $_.Exception.Message }
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    $results.Add([pscustomobject]@{ Step = $name; Status = $status; Seconds = $seconds; Detail = $detail })
    $colour = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red' }[$status]
    Write-Host "    $status ($seconds s) $detail" -ForegroundColor $colour
}

# The summary lines a test runner printed ("Passed! - Failed: 0, Passed: 204 …", "Tests  505 passed"), shortened.
function Get-TestSummary([string]$log, [string]$pattern) {
    # Without terminal colour codes (gitleaks writes them even into a file).
    $lines = Get-Content $log | ForEach-Object { $_ -replace '\x1b\[[0-9;]*m', '' }
    (($lines | Where-Object { $_ -match $pattern } | ForEach-Object { ($_ -replace '\s+', ' ').Trim() }) -join '; ')
}

function Invoke-WithEnvironment([hashtable]$variables, [scriptblock]$command) {
    foreach ($name in $variables.Keys) { Set-Item "Env:$name" $variables[$name] }
    try { & $command } finally { foreach ($name in $variables.Keys) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } }
}

Push-Location $root
try {
    $commit = (git rev-parse --short=7 HEAD).Trim()
    if (git status --porcelain) { Write-Host "Note: uncommitted changes are checked too (commit $commit plus them)." -ForegroundColor Yellow }
    Write-Host "Checking $commit; logs in $logDir"
    $dockerOk = (Invoke-Logged (Join-Path $logDir 'docker.log') { docker version }) -eq 0
    if (-not $dockerOk) { throw 'Docker is not running: the integration tests, browser tests and scans need it.' }

    # 1. Tests
    Invoke-Step '.NET tests' {
        param($log)
        $exit = Invoke-Logged $log { dotnet test FileHolder.sln }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^(Passed|Failed)!'))
    }
    Invoke-Step 'FsCheck properties (20,000 cases)' {
        param($log)
        $exit = Invoke-WithEnvironment @{ FSCHECK_RANDOM = '1'; FSCHECK_MAX_TEST = '20000' } {
            Invoke-Logged $log { dotnet test tests/FileHolder.Tests.Unit/FileHolder.Tests.Unit.csproj -c Release --filter 'FullyQualifiedName~Properties|FullyQualifiedName~FileNameVectorTests' }
        }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^(Passed|Failed)!'))
    }
    Invoke-Step 'Vitest' {
        param($log)
        Push-Location $ui
        try { $exit = Invoke-Logged $log { npx vitest run } } finally { Pop-Location }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^\s*Tests\s'))
    }
    Invoke-Step 'fast-check properties (10,000 runs)' {
        param($log)
        Push-Location $ui
        try {
            $exit = Invoke-WithEnvironment @{ FC_RANDOM = '1'; FC_NUM_RUNS = '10000' } {
                Invoke-Logged $log { npx vitest run properties --testTimeout=600000 }
            }
        }
        finally { Pop-Location }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^\s*Tests\s'))
    }

    # 2. Dependency audits
    Invoke-Step 'NuGet audit' {
        param($log)
        $null = Invoke-Logged $log { dotnet list FileHolder.sln package --vulnerable --include-transitive }
        $vulnerable = @(Get-Content $log | Where-Object { $_ -match 'has the following vulnerable packages' })
        if ($vulnerable.Count -gt 0) { @('FAIL', "$($vulnerable.Count) project(s) with vulnerable packages") } else { @('PASS', 'no vulnerable packages') }
    }
    Invoke-Step 'npm audit' {
        param($log)
        Push-Location $ui
        try {
            $production = Invoke-Logged $log { npm audit --omit=dev --audit-level=high }
            $all = Invoke-Logged $log { npm audit }
        }
        finally { Pop-Location }
        if ($production -ne 0) { @('FAIL', 'vulnerabilities in production dependencies') }
        elseif ($all -ne 0) { @('WARN', 'vulnerabilities in development dependencies only (see the log)') }
        else { @('PASS', 'no vulnerabilities') }
    }

    # 3. Browser tests on the dev stack, in CI's setup
    $env:GIT_SHA = $commit
    if (-not $SkipBrowserTests) {
        try {
            Invoke-Step 'Stack in CI setup' {
                param($log)
                $exit = Invoke-Logged $log { docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --build --wait }
                @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), "rebuilt from $commit")
            }
            Invoke-Step 'Playwright (3 browsers)' {
                param($log)
                Push-Location $ui
                try { $exit = Invoke-Logged $log { npx playwright test --project=chromium --project=firefox --project=webkit --reporter=line } } finally { Pop-Location }
                @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^\s+\d+ (passed|failed|flaky|skipped)'))
            }
            Invoke-Step 'Fault tests (3 browsers)' {
                param($log)
                Push-Location $ui
                try { $exit = Invoke-Logged $log { npx playwright test --project=faults --project=faults-firefox --project=faults-webkit --reporter=line } } finally { Pop-Location }
                @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^\s+\d+ (passed|failed|flaky|skipped)'))
            }
        }
        finally {
            Invoke-Step 'Stack back to its usual setup' {
                param($log)
                $exit = Invoke-Logged $log { docker compose up -d --wait }
                @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), 'docker compose up with the usual files')
            }
        }
    }
    if (-not $SkipImageScans) {
        # The browser tests' stack already built the API and UI images; the sample keeper is no part of the dev stack,
        # so it's built here either way.
        Invoke-Step 'Build images to scan' {
            param($log)
            $exit = 0
            if ($SkipBrowserTests) { $exit = Invoke-Logged $log { docker compose -f docker-compose.yml build api ui } }
            if ($exit -eq 0) { $exit = Invoke-Logged $log { docker build --target sample -t fileholder-sample:latest src/fileholder-ui } }
            @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), "built from $commit; the running stack is untouched")
        }
    }

    # 4. Image scans
    if (-not $SkipImageScans) {
        $prod = Get-Content (Join-Path $root 'docker-compose.prod.yml') -Raw
        $dev = Get-Content (Join-Path $root 'docker-compose.yml') -Raw
        $pinned = { param($text, $pattern) ([regex]::Match($text, "image:\s*($pattern[^\s#]+)")).Groups[1].Value }
        # What each image is, where it comes from, and anything scoped to it alone.
        $images = [ordered]@{
            api        = @{ Ref = 'fileholder-api:latest'; Local = $true }
            ui         = @{ Ref = 'fileholder-ui:latest'; Local = $true }
            sample     = @{ Ref = 'fileholder-sample:latest'; Local = $true }
            caddy      = @{ Ref = (& $pinned $prod 'caddy:') }
            # gosu only switches to the postgres user when the container starts; it never touches the network, so the
            # Go library flaws Trivy finds in it can't be reached. The rest of the image is scanned.
            postgres   = @{ Ref = (& $pinned $prod 'postgres:'); Args = @('--skip-files', 'usr/local/bin/gosu') }
            prometheus = @{ Ref = (& $pinned $prod 'prom/prometheus:') }
            tempo      = @{ Ref = (& $pinned $prod 'grafana/tempo:') }
            silo       = @{ Ref = (& $pinned $dev 'pgsty/silo:') }
        }
        # Not $name: inside a step that would be Invoke-Step's own parameter (the step's title).
        foreach ($imageName in $images.Keys) {
            $image = $images[$imageName]
            Invoke-Step "Trivy: $imageName" {
                param($log)
                if (-not $image.Ref) { return @('FAIL', 'image not found in the compose files') }
                # .trivyignore for every image, plus docker/trivy/<name>.trivyignore for this one.
                $ignore = Join-Path $logDir "$imageName.trivyignore"
                $scoped = Join-Path $root "docker/trivy/$imageName.trivyignore"
                (@(Get-Content (Join-Path $root '.trivyignore')) + $(if (Test-Path $scoped) { @(Get-Content $scoped) } else { @() })) |
                    Set-Content -Encoding ascii $ignore
                $source = if ($image.Local) { @('-v', '/var/run/docker.sock:/var/run/docker.sock') } else { @('--image-src', 'remote') }
                $dockerArgs = if ($image.Local) { $source } else { @() }
                $trivyArgs = @('image', '--quiet', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--ignorefile', "/out/$imageName.trivyignore", '--exit-code', '1')
                if (-not $image.Local) { $trivyArgs += $source }
                if ($image.Args) { $trivyArgs += $image.Args }
                $exit = Invoke-Logged $log { docker run --rm @dockerArgs -v "${trivyCache}:/root/.cache" -v "${logDir}:/out" $trivy @trivyArgs $image.Ref }
                $shortRef = $image.Ref.Split('@')[0]
                # Trivy exits 1 for findings and for its own errors alike, so the log tells them apart.
                $fatal = @(Get-Content $log | Where-Object { $_ -match '\bFATAL\b' })
                $found = @(Get-Content $log | ForEach-Object { [regex]::Matches($_, '\b(CVE|GHSA)-[0-9A-Za-z-]+') } | ForEach-Object { $_.Value } | Sort-Object -Unique)
                if ($fatal) { @('FAIL', "${shortRef}: the scan itself failed: $(($fatal[0] -split 'Fatal error')[-1].Trim())") }
                elseif ($exit -eq 0) { @('PASS', "${shortRef}: no fixable HIGH/CRITICAL") }
                else { @('FAIL', "${shortRef}: $($found.Count) finding(s): $(($found | Select-Object -First 5) -join ', ')") }
            }
        }
    }

    # 5. Code and secret scans, with the scanner images security.yml builds
    Invoke-Step 'Semgrep' {
        param($log)
        $null = Invoke-Logged $log { docker build -q -t fileholder-semgrep .github/scanners/semgrep }
        $exit = Invoke-Logged $log {
            docker run --rm -e HOME=/tmp -v "${root}:/src" -w /src fileholder-semgrep semgrep scan `
                --config p/csharp --config p/typescript --config p/react --config p/security-audit `
                --metrics=off --error --exclude node_modules --exclude bin --exclude obj --exclude dist
        }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '^Ran \d+ rules'))
    }
    Invoke-Step 'gitleaks (whole history)' {
        param($log)
        $null = Invoke-Logged $log { docker build -q -t fileholder-gitleaks .github/scanners/gitleaks }
        $exit = Invoke-Logged $log { docker run --rm -v "${root}:/repo" fileholder-gitleaks git /repo --config /repo/.gitleaks.toml --redact --no-banner }
        @((@('FAIL', 'PASS')[[int]($exit -eq 0)]), (Get-TestSummary $log '(commits scanned|no leaks found|leaks found)'))
    }

    # 6. DNS
    Invoke-Step 'DNS' {
        param($log)
        $ask = {
            param($name, $type)
            $answer = Invoke-RestMethod "https://cloudflare-dns.com/dns-query?name=$name&type=$type&do=1" -Headers @{ accept = 'application/dns-json' } -TimeoutSec 15
            "$name $type AD=$($answer.AD) $(@($answer.Answer | ForEach-Object { $_.data }) -join ' | ')" | Out-File -Append -Encoding utf8 $log
            $answer
        }
        $problems = @()
        $ds = & $ask $domain 'DS'
        if (-not $ds.AD -or -not ($ds.Answer | Where-Object { $_.type -eq 43 })) { $problems += 'DNSSEC not validating' }
        $caa = & $ask $domain 'CAA'
        if (-not ($caa.Answer | Where-Object { $_.data -match 'letsencrypt\.org' })) { $problems += "CAA doesn't allow Let's Encrypt" }
        $dmarc = & $ask "_dmarc.$domain" 'TXT'
        if (-not ($dmarc.Answer | Where-Object { $_.data -match 'p=reject' })) { $problems += 'DMARC is not p=reject' }
        $addresses = @((& $ask $domain 'A').Answer + (& $ask $domain 'AAAA').Answer | Where-Object { $_.type -in 1, 28 } | ForEach-Object { $_.data })
        $where = if ($addresses) { "points at $($addresses -join ', ')" } else { 'no A/AAAA yet' }
        if ($problems) { @('FAIL', ($problems -join '; ')) } else { @('PASS', "DNSSEC, CAA and DMARC fine; $where") }
    }
}
finally {
    Remove-Item Env:GIT_SHA -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ''
Write-Host "Pre-deploy check of $commit" -ForegroundColor Cyan
$results | Format-Table Step, Status, Seconds, Detail -AutoSize -Wrap | Out-String -Width 200 | Write-Host
$failed = @($results | Where-Object Status -eq 'FAIL')
$total = ($results | Measure-Object Seconds -Sum).Sum
Write-Host "Logs: $logDir ($([int]($total / 60)) min)"
if ($failed) {
    Write-Host "$($failed.Count) step(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host 'Everything passed.' -ForegroundColor Green
