<#
.SYNOPSIS
    The owner's controls for a running FileHolder: show or switch the maintenance mode, and take bundles down
    (README, Maintenance Modes and Takedown).

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

.EXAMPLE
    scripts/admin.ps1 takedown "https://fileholder.app/f/Ab3dE6gH#k=..." -Reason "phishing, reported to abuse@ on 2026-10-27"

.EXAMPLE
    scripts/admin.ps1 takedowns

.EXAMPLE
    scripts/admin.ps1 code-create a03
    A new access code (#169) under a neutral label, valid for 30 days; prints the personal link to put in an
    application. -ExpiresInDays 60 or -NoExpiry for another expiry. Keep which company a03 is in your own notes.

.EXAMPLE
    scripts/admin.ps1 codes
    scripts/admin.ps1 code-extend a03 -Days 30
    scripts/admin.ps1 code-revoke a03
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('status', 'mode', 'takedown', 'takedowns', 'codes', 'code-create', 'code-extend', 'code-revoke')]
    [string]$Command,

    # For mode: Normal, UploadsPaused, ReadOnly or Closed. For takedown: the bundle's link, or just its share token.
    # For the code commands: the code's label (a01, a02, …).
    [Parameter(Position = 1)]
    [string]$Target,

    # Why: goes into the log, never shown to visitors. Required to change the mode or take a bundle down.
    [string]$Reason,

    # Shown to visitors in the banner and in refusals.
    [string]$Message,

    # When you expect to switch back, shown to visitors. Nothing switches back by itself. An ISO date, e.g. 2026-10-27T14:00Z.
    [string]$Until,

    [string]$ChangedBy = $env:USERNAME,

    # code-create: days until the code expires (default 30); code-extend: days from now (default 30).
    [int]$ExpiresInDays,
    [int]$Days,

    # code-create and code-extend: the code never expires (until revoked).
    [switch]$NoExpiry,

    # code-create: the site the personal link points at.
    [string]$SiteUrl = 'https://fileholder.app',

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
        $Mode = $Target
        if ($Mode -notin 'Normal', 'UploadsPaused', 'ReadOnly', 'Closed') { throw 'Say which mode: Normal, UploadsPaused, ReadOnly or Closed.' }
        if (-not $Reason) { throw 'Say why with -Reason; it goes into the log.' }

        $body = @{ mode = $Mode; reason = $Reason; changedBy = $ChangedBy }
        if ($Message) { $body.message = $Message }
        if ($Until) { $body.until = ([DateTimeOffset]::Parse($Until, [Globalization.CultureInfo]::InvariantCulture)).UtcDateTime.ToString('o') }

        $json = $body | ConvertTo-Json
        $response = Invoke-RestMethod -Method Put -Uri "$BaseUrl/admin/mode" -Headers $headers `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
        "Now in mode $($response.mode)."
    }
    'takedown' {
        if (-not $Target) { throw 'Give the bundle''s link or share token.' }
        if (-not $Reason) { throw 'Say why with -Reason; it goes into the takedown record.' }

        # Only the share token is sent: never the #k= key of an encrypted bundle's link.
        $shareToken = ($Target -split '#', 2)[0].TrimEnd('/')
        if ($shareToken -match '/f/([^/?]+)') { $shareToken = $Matches[1] }

        $json = @{ shareToken = $shareToken; reason = $Reason; changedBy = $ChangedBy } | ConvertTo-Json
        try {
            $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/takedown" -Headers $headers `
                -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
        }
        catch {
            $status = [int]$_.Exception.Response.StatusCode
            if ($status -eq 404) { throw "No bundle has the share token '$shareToken'." }
            if ($status -eq 409) { throw "Bundle '$shareToken' already expired and its files are deleted; nothing to take down." }
            throw
        }

        if ($response.alreadyTakenDown) {
            "Bundle $shareToken was already taken down on $($response.record.takenDownAt): $($response.record.reason)"
        }
        elseif ($response.filesNotYetDeleted -gt 0) {
            "Bundle $shareToken is taken down. $($response.filesNotYetDeleted) file(s) couldn't be deleted yet; the purge retries within 30 minutes."
        }
        else {
            "Bundle $shareToken is taken down and its $($response.filesDeleted) file(s) are deleted."
        }
    }
    'takedowns' {
        Invoke-RestMethod -Method Get -Uri "$BaseUrl/admin/takedowns" -Headers $headers |
            Format-Table takenDownAt, shareToken, reason, changedBy, fileCount, isEncrypted -AutoSize
    }
    'codes' {
        Invoke-RestMethod -Method Get -Uri "$BaseUrl/admin/access-codes" -Headers $headers |
            Format-Table label, status, expiresAt, bundleCount, bytesUploaded, firstUsedAt, lastUsedAt, createdAt -AutoSize
    }
    'code-create' {
        if (-not $Target) { throw 'Give the new code a neutral label: scripts/admin.ps1 code-create a03' }
        $body = @{ label = $Target }
        if ($NoExpiry) { $body.noExpiry = $true } elseif ($ExpiresInDays) { $body.expiresInDays = $ExpiresInDays }
        $created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/access-codes" -Headers $headers `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json)))
        $expires = if ($created.expiresAt) { "expires $($created.expiresAt)" } else { 'never expires' }
        "Code $($created.label) ($expires). It's shown only now; the server keeps a hash."
        "  Code:          $($created.code)"
        "  Personal link: $($SiteUrl.TrimEnd('/'))/?code=$($created.code)"
    }
    'code-extend' {
        if (-not $Target) { throw 'Say which code: scripts/admin.ps1 code-extend a03 -Days 30' }
        $body = @{}
        if ($NoExpiry) { $body.noExpiry = $true } elseif ($Days) { $body.days = $Days }
        $code = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/access-codes/$Target/extend" -Headers $headers `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json)))
        "Code $($code.label) is $($code.status), expires $(if ($code.expiresAt) { $code.expiresAt } else { 'never' })."
    }
    'code-revoke' {
        if (-not $Target) { throw 'Say which code: scripts/admin.ps1 code-revoke a03' }
        $code = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/access-codes/$Target/revoke" -Headers $headers
        "Code $($code.label) is revoked."
    }
}
