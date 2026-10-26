using System.Diagnostics.Metrics;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Exceptions;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// fileholder_access_code_rejections_total: codes refused (unknown, expired or revoked). Codes are too long to guess,
/// so instead of a global limit (which would let anyone lock out real codes on purpose), a guessing attempt shows up here.
/// </summary>
public sealed class AccessCodeMetrics
{
    public const string RejectionsInstrument = "fileholder.access_code.rejections";

    private readonly Counter<long> _rejections;

    public AccessCodeMetrics(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create(StorageLifecycleStatus.MeterName);
        _rejections = meter.CreateCounter<long>(RejectionsInstrument, description: "Access codes refused: unknown, expired or revoked.");
    }

    public void RecordRejection() => _rejections.Add(1);
}

public class AccessCodeService(
    AppDbContext dbContext,
    IDateTimeProvider dateTimeProvider,
    AccessCodeMetrics metrics,
    ILogger<AccessCodeService> logger) : IAccessCodeService
{
    public async Task<AccessCodeResolution> ResolveAsync(string? code, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return new AccessCodeResolution(AccessCodeStatus.None);
        }

        if (code.Length > AccessCodeRules.MaxCodeLength)
        {
            metrics.RecordRejection();
            return new AccessCodeResolution(AccessCodeStatus.Invalid);
        }

        var hash = AccessCodeRules.Hash(code);
        var found = await dbContext.AccessCodes.AsNoTracking().FirstOrDefaultAsync(c => c.CodeHash == hash, ct);
        if (found is null || !found.IsValid(dateTimeProvider.UtcNow))
        {
            metrics.RecordRejection();
            return new AccessCodeResolution(AccessCodeStatus.Invalid);
        }

        return new AccessCodeResolution(AccessCodeStatus.Valid, found.Id);
    }

    public async Task<AccessCodeCreatedDto> CreateAsync(CreateAccessCodeRequestDto request, CancellationToken ct = default)
    {
        if (await dbContext.AccessCodes.AnyAsync(c => c.Label == request.Label, ct))
        {
            throw new ConflictException($"A code labelled {request.Label} already exists; pick another label.");
        }

        var now = dateTimeProvider.UtcNow;
        var code = AccessCodeRules.Generate(request.Label);
        var accessCode = new AccessCode
        {
            Label = request.Label,
            CodeHash = AccessCodeRules.Hash(code),
            CreatedAt = now,
            ExpiresAt = ExpiryFrom(now, request.ExpiresInDays, request.NoExpiry),
        };
        dbContext.AccessCodes.Add(accessCode);
        await dbContext.SaveChangesAsync(ct);

        logger.LogWarning("Access code {Label} created, expires {ExpiresAt}.", accessCode.Label, accessCode.ExpiresAt?.ToString("u") ?? "never");
        return new AccessCodeCreatedDto(accessCode.Label, code, accessCode.ExpiresAt);
    }

    public async Task<IReadOnlyList<AccessCodeDto>> ListAsync(CancellationToken ct = default)
    {
        var now = dateTimeProvider.UtcNow;
        var codes = await dbContext.AccessCodes.AsNoTracking().OrderBy(c => c.CreatedAt).ToListAsync(ct);
        return codes.Select(c => ToDto(c, now)).ToList();
    }

    public async Task<AccessCodeDto?> ExtendAsync(string label, ExtendAccessCodeRequestDto request, CancellationToken ct = default)
    {
        var accessCode = await dbContext.AccessCodes.FirstOrDefaultAsync(c => c.Label == label, ct);
        if (accessCode is null) return null;

        var now = dateTimeProvider.UtcNow;
        accessCode.ExpiresAt = ExpiryFrom(now, request.Days, request.NoExpiry);
        await dbContext.SaveChangesAsync(ct);

        logger.LogWarning("Access code {Label} now expires {ExpiresAt}.", label, accessCode.ExpiresAt?.ToString("u") ?? "never");
        return ToDto(accessCode, now);
    }

    public async Task<AccessCodeDto?> RevokeAsync(string label, CancellationToken ct = default)
    {
        var accessCode = await dbContext.AccessCodes.FirstOrDefaultAsync(c => c.Label == label, ct);
        if (accessCode is null) return null;

        var now = dateTimeProvider.UtcNow;
        accessCode.RevokedAt ??= now;
        await dbContext.SaveChangesAsync(ct);

        logger.LogWarning("Access code {Label} revoked.", label);
        return ToDto(accessCode, now);
    }

    private static DateTime? ExpiryFrom(DateTime now, int? days, bool noExpiry)
    {
        if (noExpiry) return null;
        return now + (days.HasValue ? TimeSpan.FromDays(days.Value) : AccessCodeRules.DefaultLifetime);
    }

    private static string StatusOf(AccessCode c, DateTime now)
    {
        if (c.RevokedAt is not null) return "revoked";
        return c.IsValid(now) ? "active" : "expired";
    }

    private static AccessCodeDto ToDto(AccessCode c, DateTime now) => new(
        c.Label, StatusOf(c, now), c.CreatedAt, c.ExpiresAt, c.RevokedAt, c.BundleCount, c.BytesUploaded, c.FirstUsedAt, c.LastUsedAt);
}
