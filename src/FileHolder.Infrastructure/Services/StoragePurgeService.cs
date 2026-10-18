using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Services;

public class StoragePurgeService(
    AppDbContext dbContext,
    IS3StorageProvider storageProvider,
    HybridCache cache,
    IDateTimeProvider dateTimeProvider,
    ILogger<StoragePurgeService> logger)
    : IStoragePurgeService
{
    /// <summary>
    /// Must outlast a download session plus the last presigned URL it issued, so an in-flight download is never cut off.
    /// </summary>
    public static readonly TimeSpan DeletionGracePeriod = DownloadTimings.StorageDeletionGracePeriod;

    private readonly AppDbContext _dbContext = dbContext;
    private readonly IS3StorageProvider _storageProvider = storageProvider;
    private readonly HybridCache _cache = cache;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;
    private readonly ILogger<StoragePurgeService> _logger = logger;


    public async Task<int> PurgeExpiredFilesAsync(CancellationToken ct = default)
    {
        var now = _dateTimeProvider.UtcNow;

        var expiredSessions = await _dbContext.MultipartUploadSessions
            .Where(s => !s.IsCompleted && !s.IsAborted && s.ExpiresAt <= now)
            .Take(50)
            .ToListAsync(ct);

        foreach (var session in expiredSessions)
        {
            await _storageProvider.AbortMultipartUploadAsync(session.StorageKey, session.UploadId, ct);
            session.IsAborted = true;
        }

        await _dbContext.DownloadSessions
            .Where(s => s.ExpiresAt <= now - DownloadTimings.ExpiredSessionRetention)
            .ExecuteDeleteAsync(ct);

        await PurgeAbandonedUploadsAsync(now, ct);

        // Groups closed within the grace period may still have an active download session or presigned URL.
        var graceCutoff = now - DeletionGracePeriod;

        var expiredGroups = await _dbContext.FileGroups
            .Include(g => g.Files)
            .Where(g => g.StoragePurgedAt == null && (
                (g.ExpiresAt != null && g.ExpiresAt <= graceCutoff) ||
                ((g.IsDeleted || (g.MaxDownloads != null && g.DownloadCount >= g.MaxDownloads)) &&
                 (g.DeletedAt == null || g.DeletedAt <= graceCutoff))
            ))
            .OrderBy(g => g.CreatedAt)
            .Take(100)
            .ToListAsync(ct);

        if (expiredGroups.Count == 0)
        {
            if (expiredSessions.Count > 0)
            {
                await _dbContext.SaveChangesAsync(ct);
            }

            return 0;
        }

        var allKeysToDelete = expiredGroups
            .SelectMany(g => g.Files)
            .Select(f => f.StorageKey)
            .ToList();

        var failedKeys = await _storageProvider.DeleteObjectsAsync(allKeysToDelete, ct);

        int purgedCount = 0;
        foreach (var group in expiredGroups)
        {
            group.MarkDeleted(now);
            await _cache.RemoveAsync($"file_group:{group.ShareToken}", ct);

            if (group.Files.Any(f => failedKeys.Contains(f.StorageKey)))
            {
                continue;
            }

            group.StoragePurgedAt = now;
            purgedCount++;
        }

        await _dbContext.SaveChangesAsync(ct);

        if (failedKeys.Count > 0)
        {
            _logger.LogWarning("Failed to delete {FailedCount} storage objects across {GroupCount} groups; they will be retried on the next run.",
                failedKeys.Count, expiredGroups.Count - purgedCount);
        }

        _logger.LogInformation("Purged {GroupCount} expired groups and deleted {KeyCount} storage objects.",
            purgedCount, allKeysToDelete.Count - failedKeys.Count);
        return purgedCount;
    }

    /// <summary>
    /// Deletes objects that were presigned but never confirmed into a bundle. Confirm removes a file's
    /// pending row, so any row left past its expiry (plus a grace period) belongs to nobody.
    /// </summary>
    private async Task PurgeAbandonedUploadsAsync(DateTime now, CancellationToken ct)
    {
        var cutoff = now - UploadTimings.PendingUploadPurgeGrace;

        var abandoned = await _dbContext.PendingUploads
            .AsNoTracking()
            .Where(p => p.ExpiresAt <= cutoff)
            .OrderBy(p => p.ExpiresAt)
            .Take(500)
            .ToListAsync(ct);

        if (abandoned.Count == 0)
        {
            return;
        }

        var failedKeys = await _storageProvider.DeleteObjectsAsync(abandoned.Select(p => p.StorageKey), ct);

        // Rows whose object could not be deleted stay behind and are retried on the next run.
        var removedIds = abandoned
            .Where(p => !failedKeys.Contains(p.StorageKey))
            .Select(p => p.Id)
            .ToList();

        await _dbContext.PendingUploads
            .Where(p => removedIds.Contains(p.Id))
            .ExecuteDeleteAsync(ct);

        if (failedKeys.Count > 0)
        {
            _logger.LogWarning("Failed to delete {FailedCount} abandoned upload objects; they will be retried on the next run.",
                failedKeys.Count);
        }

        _logger.LogInformation("Deleted {Count} abandoned uploads that were never confirmed.", removedIds.Count);
    }
}