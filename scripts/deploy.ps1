<#
.SYNOPSIS
    Deploys this checkout to the production server (README, Production → Deploying), or rolls the server back.

.DESCRIPTION
    1. Checks: no uncommitted changes (unless -AllowDirty), and the server has Docker Compose and its .env.
    2. Builds fileholder-api and fileholder-ui here, tagged <version>-<commit> (e.g. 0.9.0-4ba83f2).
    3. Copies them to the server over SSH (docker save, scp -C, docker load), with docker-compose.prod.yml and the
       Caddy, Prometheus and Tempo configs. No registry: the images are built here and only ever copied (#82).
    4. On the server: points FILEHOLDER_VERSION in .env at the new tag, remembers the old one, and runs
       docker compose up --wait. If anything doesn't come up healthy, it switches back to the old version by itself.
    5. Checks the API's /healthz/ready on the server, and the public /api/v1/status, report the new commit.
    6. Keeps the new and the previous images on the server, removes older ones, and adds a line to deploy.log.

    -Rollback switches the server back to the version before the current one, without building anything.

    The server is an SSH destination, best a Host in ~/.ssh/config (user, address, key). Its directory (/opt/fileholder)
    must hold the .env made from .env.prod.example; everything else is copied by this script.

.EXAMPLE
    scripts/deploy.ps1 -Server fileholder

.EXAMPLE
    scripts/deploy.ps1 -Server fileholder -Rollback
#>
# Named parameters only: a stray value must not land in -RemoteDir or -SiteUrl by its position.
[CmdletBinding(PositionalBinding = $false)]
param(
    # The SSH destination: a Host from ~/.ssh/config, or user@address.
    [string]$Server = $env:FILEHOLDER_SERVER,

    # Where the production files live on the server.
    [string]$RemoteDir = '/opt/fileholder',

    # The public address, checked after the deploy. Empty skips that check (e.g. before DNS points at the server).
    [string]$SiteUrl = 'https://fileholder.app',

    # Switch back to the previous version instead of deploying.
    [switch]$Rollback,

    # Deploy even with uncommitted changes; the commit shown in the footer then isn't quite what runs.
    [switch]$AllowDirty,

    # An SSH config file to use instead of ~/.ssh/config (tests use one for a stand-in server).
    [string]$SshConfig
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$images = @('fileholder-api', 'fileholder-ui')
# The files the server needs next to its .env, at the same paths as in the repository.
$configFiles = @('docker-compose.prod.yml', 'docker/caddy/Caddyfile', 'docker/prometheus/prometheus.yml', 'docker/tempo/tempo.yaml')
$healthTimeoutSeconds = 300

if (-not $Server) { throw 'Say which server: -Server <ssh host>, or set FILEHOLDER_SERVER.' }
$sshArgs = if ($SshConfig) { @('-F', $SshConfig) } else { @() }

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }

# Docker, ssh and git report progress on stderr, which Windows PowerShell 5.1 would turn into terminating errors;
# their exit codes say whether they failed.
function Invoke-Native([string]$what, [scriptblock]$command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $command } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

# Runs a bash script on the server. It goes over as a file with LF line endings and runs from there: passed as an
# argument it would depend on how Windows PowerShell 5.1 quotes native arguments, which mangles double quotes.
function Invoke-Remote([string]$what, [string]$script) {
    $local = [IO.Path]::GetTempFileName()
    $remote = "/tmp/fileholder-deploy-$([guid]::NewGuid().ToString('N')).sh"
    try {
        $text = "set -eu`n" + ($script -replace "`r`n", "`n") + "`n"
        [IO.File]::WriteAllText($local, $text, (New-Object Text.UTF8Encoding $false))
        Invoke-Native "$what (copying the step)" { scp @sshArgs -q $local "${Server}:$remote" }
        Invoke-Native $what { ssh @sshArgs $Server "bash $remote; status=`$?; rm -f $remote; exit `$status" }
    }
    finally {
        Remove-Item $local -ErrorAction SilentlyContinue
    }
}

Push-Location $root
try {
    Write-Step "Checking the server ($Server)"
    Invoke-Remote 'Checking the server' @"
command -v docker >/dev/null || { echo 'Docker is not installed on the server.' >&2; exit 2; }
docker compose version >/dev/null || { echo 'The Docker Compose plugin is not installed on the server.' >&2; exit 2; }
mkdir -p '$RemoteDir'
test -f '$RemoteDir/.env' || { echo 'No $RemoteDir/.env on the server: make it from .env.prod.example first (README, Production).' >&2; exit 3; }
"@

    if ($Rollback) {
        Write-Step 'Rolling back to the previous version'
        Invoke-Remote 'Rolling back' @"
cd '$RemoteDir'
test -s .previous-version || { echo 'No previous version recorded: nothing to roll back to.' >&2; exit 4; }
previous=`$(cat .previous-version)
current=`$(grep '^FILEHOLDER_VERSION=' .env | cut -d= -f2)
sed -i "s/^FILEHOLDER_VERSION=.*/FILEHOLDER_VERSION=`$previous/" .env
echo "`$current" > .previous-version
docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout $healthTimeoutSeconds
echo "`$(date -u +%FT%TZ) rollback `$current -> `$previous" >> deploy.log
echo "Rolled back from `$current to `$previous."
"@
        return
    }

    Write-Step 'Checking this checkout'
    $commit = (git rev-parse --short=7 HEAD).Trim()
    $dirty = git status --porcelain
    if ($dirty -and -not $AllowDirty) {
        throw "There are uncommitted changes, which the deploy would include under commit $commit. Commit or stash them, or pass -AllowDirty."
    }
    $version = (Get-Content (Join-Path $root 'version.txt') -TotalCount 1).Trim()
    $tag = "$version-$commit"
    Write-Host "Deploying $tag"

    Write-Step 'Building the images'
    Invoke-Native 'Building fileholder-api' {
        docker build --build-arg "GIT_SHA=$commit" --build-arg "VERSION=$version" -t "fileholder-api:$tag" -f src/FileHolder.Api/Dockerfile .
    }
    Invoke-Native 'Building fileholder-ui' {
        docker build --build-arg "GIT_SHA=$commit" --build-arg "VERSION=$version" -t "fileholder-ui:$tag" src/fileholder-ui
    }

    Write-Step 'Copying the images and configs to the server'
    $staging = Join-Path ([IO.Path]::GetTempPath()) "fileholder-deploy-$tag"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force $staging | Out-Null
    try {
        # Files, not a pipe: Windows PowerShell 5.1 would re-encode binary data passed between programs.
        Invoke-Native 'Saving the images' { docker save -o (Join-Path $staging 'images.tar') ($images | ForEach-Object { "${_}:$tag" }) }
        foreach ($file in $configFiles) {
            $target = Join-Path $staging $file
            New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
            # LF endings, whatever this checkout has: the server's tools read them.
            $text = [IO.File]::ReadAllText((Join-Path $root $file)) -replace "`r`n", "`n"
            [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding $false))
        }
        Invoke-Remote 'Preparing the directories' "mkdir -p '$RemoteDir/docker/caddy' '$RemoteDir/docker/prometheus' '$RemoteDir/docker/tempo'"
        Invoke-Native 'Copying' {
            scp @sshArgs -C -r (Join-Path $staging 'images.tar') (Join-Path $staging 'docker-compose.prod.yml') (Join-Path $staging 'docker') "${Server}:$RemoteDir/"
        }
    }
    finally {
        Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    }

    Write-Step 'Starting the new version on the server'
    Invoke-Remote 'Starting the new version' @"
cd '$RemoteDir'
docker load -i images.tar
rm -f images.tar
previous=`$(grep '^FILEHOLDER_VERSION=' .env | cut -d= -f2 || true)
if grep -q '^FILEHOLDER_VERSION=' .env; then
    sed -i "s/^FILEHOLDER_VERSION=.*/FILEHOLDER_VERSION=$tag/" .env
else
    echo 'FILEHOLDER_VERSION=$tag' >> .env
fi
# What -Rollback goes back to. Kept as it was if this deploy fails, so a later rollback still has somewhere to go.
recorded=`$(cat .previous-version 2>/dev/null || true)
if [ -n "`$previous" ] && [ "`$previous" != '$tag' ]; then echo "`$previous" > .previous-version; fi
if ! docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout $healthTimeoutSeconds; then
    echo 'The new version did not come up healthy.' >&2
    docker compose -f docker-compose.prod.yml ps -a >&2
    if [ -n "`$previous" ] && [ "`$previous" != '$tag' ]; then
        echo "Switching back to `$previous." >&2
        sed -i "s/^FILEHOLDER_VERSION=.*/FILEHOLDER_VERSION=`$previous/" .env
        if [ -n "`$recorded" ]; then echo "`$recorded" > .previous-version; else rm -f .previous-version; fi
        docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout $healthTimeoutSeconds || true
        echo "`$(date -u +%FT%TZ) failed $tag, back on `$previous" >> deploy.log
    fi
    exit 5
fi
health=`$(docker compose -f docker-compose.prod.yml exec -T api wget -qO- http://localhost:8080/healthz/ready)
echo "`$health" | grep -q '"commit":"$commit"' || { echo "The API reports another build: `$health" >&2; exit 6; }
echo "`$(date -u +%FT%TZ) deployed $tag (was `${previous:-nothing})" >> deploy.log
# Keep the new and the previous images; older ones only take up disk.
for image in $($images -join ' '); do
    docker image ls "`$image" --format '{{.Tag}}' | grep -vx '$tag' | grep -vx "`${previous:-none}" | while read -r old; do
        docker image rm "`$image:`$old" >/dev/null && echo "Removed `$image:`$old"
    done
done
echo "Running $tag."
"@

    if ($SiteUrl) {
        Write-Step "Checking $SiteUrl"
        $status = $null
        foreach ($attempt in 1..10) {
            try { $status = Invoke-RestMethod "$($SiteUrl.TrimEnd('/'))/api/v1/status" -TimeoutSec 10; break }
            catch { Start-Sleep -Seconds 3 }
        }
        if (-not $status) { throw "$SiteUrl/api/v1/status didn't answer. The server runs $tag; check Caddy's logs (docker compose logs caddy)." }
        if ($status.commit -ne $commit) { throw "$SiteUrl reports commit $($status.commit), not $commit." }
        Write-Host "$SiteUrl runs $($status.version) ($($status.commit)), mode $($status.mode)."
    }

    Write-Step "Deployed $tag"
}
finally {
    Pop-Location
}
