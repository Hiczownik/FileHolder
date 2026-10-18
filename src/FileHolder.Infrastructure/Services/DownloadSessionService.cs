using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;

namespace FileHolder.Infrastructure.Services;

public class DownloadSessionService(
    AppDbContext dbContext,
    HybridCache cache,
    IDateTimeProvider dateTimeProvider)
    : IDownloadSessionService
{
    private readonly AppDbContext _dbContext = dbContext;
    private readonly HybridCache _cache = cache;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;

    public async Task<OpenDownloadSessionResult> OpenSessionAsync(string shareToken, string? password, CancellationToken ct = default)
    {
        // Share tokens are only unique among live groups, so prefer the live one if a deleted group reused it.
        var group = await _dbContext.FileGroups
            .AsNoTracking()
            .Where(g => g.ShareToken == shareToken)
            .OrderBy(g => g.IsDeleted)
            .ThenByDescending(g => g.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (group == null)
        {
            return new OpenDownloadSessionResult(OpenDownloadSessionStatus.NotFound, null);
        }

        if (!group.VerifyPassword(password))
        {
            return new OpenDownloadSessionResult(OpenDownloadSessionStatus.InvalidPassword, null);
        }

        var now = _dateTimeProvider.UtcNow;
        if (group.IsExpired(now))
        {
            return new OpenDownloadSessionResult(OpenDownloadSessionStatus.Expired, null);
        }

        await using var tx = await _dbContext.Database.BeginTransactionAsync(ct);

        // Single conditional UPDATE: the row lock it takes serializes concurrent openers, and Postgres
        // re-checks the WHERE clause after waiting, so exactly MaxDownloads sessions can ever succeed.
        // SET expressions see the pre-update row, hence DownloadCount + 1 when detecting the last download.
        int consumed = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id
                        && !g.IsDeleted
                        && (g.ExpiresAt == null || g.ExpiresAt > now)
                        && (g.MaxDownloads == null || g.DownloadCount < g.MaxDownloads))
            .ExecuteUpdateAsync(s => s
                .SetProperty(g => g.DownloadCount, g => g.DownloadCount + 1)
                .SetProperty(g => g.IsDeleted, g => g.MaxDownloads != null && g.DownloadCount + 1 >= g.MaxDownloads)
                .SetProperty(g => g.DeletedAt, g => g.MaxDownloads != null && g.DownloadCount + 1 >= g.MaxDownloads
                    ? (DateTime?)now
                    : g.DeletedAt), ct);

        if (consumed == 0)
        {
            await tx.RollbackAsync(ct);
            return new OpenDownloadSessionResult(OpenDownloadSessionStatus.Expired, null);
        }

        int downloadCount = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id)
            .Select(g => g.DownloadCount)
            .FirstAsync(ct);

        var sessionExpiresAt = now + DownloadTimings.SessionLifetime;
        if (group.ExpiresAt.HasValue && group.ExpiresAt.Value < sessionExpiresAt)
        {
            sessionExpiresAt = group.ExpiresAt.Value;
        }

        var session = new DownloadSession
        {
            FileGroupId = group.Id,
            CreatedAt = now,
            ExpiresAt = sessionExpiresAt
        };

        _dbContext.DownloadSessions.Add(session);
        await _dbContext.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        await _cache.RemoveAsync($"file_group:{shareToken}", CancellationToken.None);

        int? remainingDownloads = group.MaxDownloads.HasValue
            ? Math.Max(0, group.MaxDownloads.Value - downloadCount)
            : null;

        return new OpenDownloadSessionResult(
            OpenDownloadSessionStatus.Success,
            new DownloadSessionResponseDto(session.Id, session.ExpiresAt, remainingDownloads));
    }

    public async Task<DownloadSession?> GetActiveSessionAsync(string shareToken, Guid sessionId, CancellationToken ct = default)
    {
        var session = await _dbContext.DownloadSessions
            .AsNoTracking()
            .Include(s => s.FileGroup)
            .ThenInclude(g => g.Files)
            .FirstOrDefaultAsync(s => s.Id == sessionId && s.FileGroup.ShareToken == shareToken, ct);

        // A session outlives its group's IsDeleted flag on purpose (the last download keeps working),
        // but never its storage.
        if (session == null
            || !session.IsActive(_dateTimeProvider.UtcNow)
            || session.FileGroup.StoragePurgedAt != null)
        {
            return null;
        }

        return session;
    }
}
