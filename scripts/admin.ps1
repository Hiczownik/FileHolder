<#
.SYNOPSIS
    The owner's controls for a running FileHolder: show or switch the maintenance mode (README, Maintenance Modes).

.DESCRIPTION
    Calls the API's admin endpoints on the admin port (9465), which compose binds to the host's loopback only. The
    token comes from -Token, else $env:FILEHOLDER_ADMIN_TOKEN, else ADMIN_TOKEN in the .env next to
    docker-compose.yml. On a server, run it there (or through an SSH tunnel to its port 9465).

.EXAMPLE
    scripts/admin.ps1 status

.EXAMPLE
    scripts/admin.ps1 mode UploadsPaused -Reason "abuse reports" -Message "Uploads are paused for a few hours." -Until "2026-10-27T14:00Z"

.EXAMPLE
    scripts/admin.ps1 mode Normal -Reason "all clear"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('status', 'mode')]
    [string]$Command,

    [Parameter(Position = 1)]
    [ValidateSet('Normal', 'UploadsPaused', 'ReadOnly', 'Closed')]
    [string]$Mode,

    # Why: goes into the log, never shown to visitors. Required to change the mode.
    [string]$Reason,

    # Shown to visitors in the banner and in refusals.
    [string]$Message,

    # When you expect to switch back, shown to visitors. Nothing switches back by itself. An ISO date, e.g. 2026-10-27T14:00Z.
    [string]$Until,

    [string]$ChangedBy = $env:USERNAME,

    [string]$BaseUrl = 'http://localhost:9465',

    [string]$Token
)

$ErrorActionPreference = 'Stop'

function Get-AdminToken {
    if ($Token) { return $Token }
    if ($env:FILEHOLDER_ADMIN_TOKEN) { return $env:FILEHOLDER_ADMIN_TOKEN }

    $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*ADMIN_TOKEN\s*=' } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }

    throw "No admin token: pass -Token, set FILEHOLDER_ADMIN_TOKEN, or put ADMIN_TOKEN in $envFile."
}

$headers = @{ Authorization = "Bearer $(Get-AdminToken)" }

switch ($Command) {
    'status' {
        $response = Invoke-RestMethod -Method Get -Uri "$BaseUrl/admin/mode" -Headers $headers
        $response.current | Format-List mode, message, until
        'Recent changes:'
        $response.history | Format-Table changedAt, mode, reason, changedBy, message -AutoSize
    }
    'mode' {
        if (-not $Mode) { throw 'Say which mode: Normal, UploadsPaused, ReadOnly or Closed.' }
        if (-not $Reason) { throw 'Say why with -Reason; it goes into the log.' }

        $body = @{ mode = $Mode; reason = $Reason; changedBy = $ChangedBy }
        if ($Message) { $body.message = $Message }
        if ($Until) { $body.until = ([DateTimeOffset]::Parse($Until, [Globalization.CultureInfo]::InvariantCulture)).UtcDateTime.ToString('o') }

        $json = $body | ConvertTo-Json
        $response = Invoke-RestMethod -Method Put -Uri "$BaseUrl/admin/mode" -Headers $headers `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
        "Now in mode $($response.mode)."
    }
}
