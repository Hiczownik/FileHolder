<#
.SYNOPSIS
    Cuts FileHolder releases with release-please from this machine, while GitHub Actions are off (README, Versions
    and Releases). Same tool and config as .github/workflows/release.yml.

.DESCRIPTION
    Two steps, like the workflow:
      pr       Opens or updates the release PR: the version bump (version.txt, Directory.Build.props, the UI's
               package.json and package-lock.json) and CHANGELOG.md, from the conventional commits since the last
               release. Merge it like any PR once it reads right.
      release  After the release PR is merged: tags the merge commit (v0.9.1, ...) and creates the GitHub release
               with that version's changelog.
    Uses your GitHub CLI login (gh auth token); nothing is stored. Add -DryRun to see what would happen.
    Before the first run there must be a v0.9.0 release to start from (README, Versions and Releases).

.EXAMPLE
    scripts/release.ps1 pr -DryRun

.EXAMPLE
    scripts/release.ps1 pr

.EXAMPLE
    scripts/release.ps1 release
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('pr', 'release')]
    [string]$Step,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Pinned like everything else (#74); the workflow's action bundles the same major version.
$ReleasePlease = 'release-please@17.11.2'
$Repo = 'Hiczownik/FileHolder'

$root = Split-Path $PSScriptRoot -Parent
$token = (gh auth token).Trim()
if (-not $token) { throw 'Not logged in to the GitHub CLI: run gh auth login first.' }

$command = if ($Step -eq 'pr') { 'release-pr' } else { 'github-release' }
$arguments = @(
    '--yes', $ReleasePlease, $command,
    '--repo-url', $Repo,
    '--target-branch', 'main',
    '--config-file', 'release-please-config.json',
    '--manifest-file', '.release-please-manifest.json'
)
if ($DryRun) { $arguments += '--dry-run' }

Push-Location $root
try {
    # release-please only takes the token as an argument (no environment variable), so it is visible in this
    # machine's process list while the command runs. Fine on your own machine; don't run this on a shared one.
    & npx @arguments '--token' $token
    if ($LASTEXITCODE -ne 0) { throw "release-please $command failed (exit code $LASTEXITCODE)." }
}
finally {
    Pop-Location
}
