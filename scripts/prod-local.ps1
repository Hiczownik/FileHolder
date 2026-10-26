<#
.SYNOPSIS
    Runs the production setup (docker-compose.prod.yml) on this machine, behind Caddy at https://localhost:18443, to
    check it before it reaches the server (README, Production).

.DESCRIPTION
    up     Builds the images from this checkout and starts the stack, waiting until every service is healthy.
    test   Runs the Playwright checks for it (e2e/production.spec.ts) against https://localhost:18443.
    down   Stops it. Add -Volumes to delete its database, storage and certificates too.

    The stack is a compose project of its own (fileholder-prodtest) with its own volumes and ports, so it runs next to
    the dev stack without touching it. Its secrets are random, made on first use in .env.prod-local (git ignores it).
    Storage is Silo instead of R2 (docker-compose.prod-local.yml).

.EXAMPLE
    scripts/prod-local.ps1 up; scripts/prod-local.ps1 test; scripts/prod-local.ps1 down -Volumes
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('up', 'test', 'down')]
    [string]$Command,

    [switch]$Volumes
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root '.env.prod-local'

function New-Secret([int]$bytes = 16) {
    $b = New-Object byte[] $bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

if (-not (Test-Path $envFile)) {
    @(
        '# Made by scripts/prod-local.ps1 for the local production test; random, never used anywhere else.'
        'SITE_ADDRESS=localhost'
        'ACME_EMAIL=prodtest@example.invalid'
        'FILEHOLDER_VERSION=local'
        'STORAGE_PUBLIC_URL=http://localhost:19000'
        'STORAGE_BUCKET=fileholder-bucket'
        'STORAGE_ACCESS_KEY=fileholder-api'
        "STORAGE_SECRET_KEY=$(New-Secret)"
        "POSTGRES_PASSWORD=$(New-Secret)"
        "ADMIN_TOKEN=$(New-Secret 32)"
        # For minio and minio-init, taken from docker-compose.yml, which compose reads whole, so Grafana's too.
        'STORAGE_ROOT_USER=prodtest-admin'
        "STORAGE_ROOT_PASSWORD=$(New-Secret)"
        "GRAFANA_ADMIN_PASSWORD=$(New-Secret)"
    ) | Set-Content -Encoding ascii $envFile
    # minio-init gives the API's storage user the same secret.
    Add-Content -Encoding ascii $envFile "STORAGE_API_SECRET_KEY=$((Get-Content $envFile | Where-Object { $_ -like 'STORAGE_SECRET_KEY=*' }).Split('=', 2)[1])"
}

$compose = @('compose', '--project-name', 'fileholder-prodtest', '--project-directory', $root,
    '--file', (Join-Path $root 'docker-compose.prod.yml'), '--file', (Join-Path $root 'docker-compose.prod-local.yml'),
    '--env-file', $envFile)

Push-Location $root
try {
    # Docker and npx report progress on stderr, which Windows PowerShell 5.1 turns into errors that 'Stop' would
    # end the script on; their exit codes say whether they failed.
    $ErrorActionPreference = 'Continue'
    switch ($Command) {
        'up' {
            $env:GIT_SHA = (git rev-parse --short HEAD).Trim()
            & docker @compose up --build --detach --wait
            if ($LASTEXITCODE -ne 0) { throw 'The production stack did not come up healthy; see docker compose logs.' }
            'Up: https://localhost:18443 (Caddy''s local certificate, so the browser warns once).'
        }
        'test' {
            $env:PROD_LOCAL_URL = 'https://localhost:18443'
            $env:ADMIN_URL = 'http://localhost:19465'
            $env:ADMIN_TOKEN = (Get-Content $envFile | Where-Object { $_ -like 'ADMIN_TOKEN=*' }).Split('=', 2)[1]
            Push-Location (Join-Path $root 'src/fileholder-ui')
            try {
                npx playwright test --project=production
                if ($LASTEXITCODE -ne 0) { throw 'The production checks failed.' }
            }
            finally { Pop-Location }
        }
        'down' {
            $downArgs = @('down')
            if ($Volumes) { $downArgs += '--volumes' }
            & docker @compose @downArgs
        }
    }
}
finally {
    Pop-Location
}
