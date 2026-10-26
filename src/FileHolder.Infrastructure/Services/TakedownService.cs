using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Takes a bundle down in three steps, each safe to stop after: close it and record the takedown (the link answers
/// "removed" and its download sessions stop from here on); delete its files; then mark it purged and scrub it to a
/// tombstone. Files storage fails to delete stay due for the purge, which takes taken-down bundles without waiting
/// (<see cref="PurgeQueries.DueForPurge"/>).
/// </summary>
public class TakedownService(
    AppDbContext dbContext,
    IS3StorageProvider storageProvider,
    HybridCache cache,
    IDateTimeProvider dateTimeProvider,
    ILogger<TakedownService> logger)
    : ITakedownService
{
    public async Task<TakedownResult> TakeDownAsync(TakedownRequestDto request, CancellationToken ct = default)
    {
        var shareToken = request.ShareToken.Trim();

        // The same lookup as the download page: a live group reusing the token wins over a deleted one.
        var group = await dbContext.FileGroups
            .Include(g => g.Files)
            .Where(g => g.ShareToken == shareToken)
            .OrderBy(g => g.IsDeleted)
            .ThenByDescending(g => g.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (group == null)
        {
            return new TakedownResult(TakedownStatus.NotFound);
        }

        if (group.IsTakenDown)
        {
            var existing = await dbContext.Takedowns
                .AsNoTracking()
                .Where(t => t.FileGroupId == group.Id)
                .OrderByDescending(t => t.Id)
                .FirstOrDefaultAsync(ct);
            return new TakedownResult(TakedownStatus.AlreadyTakenDown, existing is null ? null : ToRecord(existing));
        }

        if (group.StoragePurgedAt != null)
        {
            return new TakedownResult(TakedownStatus.AlreadyPurged);
        }

        var now = dateTimeProvider.UtcNow;
        var takedown = new Takedown
        {
            ShareToken = group.ShareToken,
            FileGroupId = group.Id,
            Reason = request.Reason.Trim(),
            ChangedBy = string.IsNullOrWhiteSpace(request.ChangedBy) ? null : request.ChangedBy.Trim(),
            TakenDownAt = now,
            FileCount = group.Files.Count,
            TotalSizeBytes = group.TotalSizeBytes,
            IsEncrypted = group.IsEncrypted,
        };

        // Step 1: closed and recorded together, before any file is touched.
        group.MarkDeleted(now);
        group.TakenDownAt = now;
        dbContext.Takedowns.Add(takedown);
        await dbContext.SaveChangesAsync(ct);
        await cache.RemoveAsync(CacheKey(group.ShareToken), ct);

        logger.LogWarning("Took down bundle {FileGroupId} ({FileCount} files) by {ChangedBy}: {Reason}",
            group.Id, takedown.FileCount, takedown.ChangedBy ?? "(not given)", takedown.Reason);

        // Step 2: the files, now. If storage fails, the purge tries again on its next run.
        var keys = group.Files.Select(f => f.StorageKey).ToList();
        IReadOnlySet<string> failedKeys;
        try
        {
            failedKeys = await storageProvider.DeleteObjectsAsync(keys, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Couldn't delete the files of taken-down bundle {FileGroupId}; the purge will retry.", group.Id);
            failedKeys = keys.ToHashSet();
        }

        // Step 3: a tombstone, as the purge leaves, once nothing is left in storage.
        if (failedKeys.Count == 0)
        {
            group.StoragePurgedAt = now;
            await using var tx = await dbContext.Database.BeginTransactionAsync(ct);
            await dbContext.SaveChangesAsync(ct);
            await StoragePurgeService.ScrubPurgedGroupsAsync(dbContext, ct);
            await tx.CommitAsync(ct);
            await cache.RemoveAsync(CacheKey(group.ShareToken), ct);
        }
        else
        {
            logger.LogWarning("{FailedCount} files of taken-down bundle {FileGroupId} are still in storage; the purge will retry.",
                failedKeys.Count, group.Id);
        }

        return new TakedownResult(TakedownStatus.Success, ToRecord(takedown), keys.Count - failedKeys.Count, failedKeys.Count);
    }

    public async Task<IReadOnlyList<TakedownRecordDto>> GetHistoryAsync(int count, CancellationToken ct = default) =>
        await dbContext.Takedowns
            .AsNoTracking()
            .OrderByDescending(t => t.Id)
            .Take(count)
            .Select(t => new TakedownRecordDto(t.ShareToken, t.TakenDownAt, t.Reason, t.ChangedBy, t.FileCount, t.TotalSizeBytes, t.IsEncrypted))
            .ToListAsync(ct);

    private static string CacheKey(string shareToken) => $"file_group:{shareToken}";

    private static TakedownRecordDto ToRecord(Takedown t) =>
        new(t.ShareToken, t.TakenDownAt, t.Reason, t.ChangedBy, t.FileCount, t.TotalSizeBytes, t.IsEncrypted);
}
