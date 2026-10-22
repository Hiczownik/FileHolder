using FileHolder.Core.Configuration;
using FileHolder.Core.Entities;
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
            session.FinishedAt = now;
        }

        if (expiredSessions.Count > 0)
        {
            await _dbContext.SaveChangesAsync(ct);
        }

        // Finished sessions are never read again, but they hold the file's name.
        await _dbContext.MultipartUploadSessions
            .Where(s => s.FinishedAt != null && s.FinishedAt <= now - PurgeTimings.FinishedUploadSessionRetention)
            .ExecuteDeleteAsync(ct);

        await _dbContext.DownloadSessions
            .Where(s => s.ExpiresAt <= now - DownloadTimings.ExpiredSessionRetention)
            .ExecuteDeleteAsync(ct);

        await PurgeAbandonedUploadsAsync(now, ct);

        int purgedCount = await PurgeExpiredGroupsAsync(now, ct);

        // The tombstone's last job is answering "expired" for a while; deleting it cascades to its download sessions.
        int deletedTombstones = await _dbContext.FileGroups
            .Where(g => g.StoragePurgedAt != null && g.StoragePurgedAt <= now - PurgeTimings.PurgedGroupRetention)
            .ExecuteDeleteAsync(ct);

        if (deletedTombstones > 0)
        {
            _logger.LogInformation("Deleted {Count} purged bundle tombstones.", deletedTombstones);
        }

        return purgedCount;
    }

    private async Task<int> PurgeExpiredGroupsAsync(DateTime now, CancellationToken ct)
    {
        var expiredGroups = await _dbContext.FileGroups
            .Include(g => g.Files)
            .DueForPurge(_dbContext, now)
            .OrderBy(g => g.CreatedAt)
            .Take(100)
            .ToListAsync(ct);

        var allKeysToDelete = expiredGroups
            .SelectMany(g => g.Files)
            .Select(f => f.StorageKey)
            .ToList();

        var failedKeys = await _storageProvider.DeleteObjectsAsync(allKeysToDelete, ct);

        int purgedCount = 0;
        foreach (var group in expiredGroups)
        {
            group.MarkDeleted(now);

            if (group.Files.Any(f => failedKeys.Contains(f.StorageKey)))
            {
                continue;
            }

            group.StoragePurgedAt = now;
            purgedCount++;
        }

        // Recording the purge and scrubbing the group share a transaction, so a group is never left purged
        // with its details still there. Runs even with nothing new to purge: the scrub covers every purged group.
        await using (var tx = await _dbContext.Database.BeginTransactionAsync(ct))
        {
            await _dbContext.SaveChangesAsync(ct);
            await ScrubPurgedGroupsAsync(ct);
            await tx.CommitAsync(ct);
        }

        // Only after the commit: a request in between would otherwise cache the group again, details and all.
        foreach (var group in expiredGroups)
        {
            await _cache.RemoveAsync($"file_group:{group.ShareToken}", ct);
        }

        if (expiredGroups.Count == 0)
        {
            return 0;
        }

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
    /// Reduces every purged group to a tombstone: its file rows are deleted and every detail of the bundle is
    /// cleared, leaving only what tells a visitor the link has expired. Once the files are gone nothing needs the
    /// rest, and an encrypted bundle's salt, key envelope and manifest would let anyone with the database guess
    /// its passkey offline and read its file names. Only touches groups that still have something to clear, so
    /// repeating it is harmless.
    /// </summary>
    private async Task ScrubPurgedGroupsAsync(CancellationToken ct)
    {
        await _dbContext.SharedFiles
            .Where(f => f.FileGroup.StoragePurgedAt != null)
            .ExecuteDeleteAsync(ct);

        await _dbContext.FileGroups
            .Where(g => g.StoragePurgedAt != null && (
                g.Title != null || g.PasswordHash != null || g.EncryptedManifest != null || g.KeyEnvelope != null ||
                g.KeySalt != null || g.EncryptedTitle != null || g.KeyMode != null || g.MaxDownloads != null ||
                g.DownloadCount != 0 || g.FailedPasswordAttempts != 0 || g.PasswordLockedUntil != null))
            .ExecuteUpdateAsync(s => s
                .SetProperty(g => g.Title, (string?)null)
                .SetProperty(g => g.PasswordHash, (string?)null)
                .SetProperty(g => g.EncryptedManifest, (string?)null)
                .SetProperty(g => g.KeyEnvelope, (string?)null)
                .SetProperty(g => g.KeySalt, (string?)null)
                .SetProperty(g => g.EncryptedTitle, (string?)null)
                .SetProperty(g => g.KeyMode, (KeyMode?)null)
                .SetProperty(g => g.MaxDownloads, (int?)null)
                .SetProperty(g => g.DownloadCount, 0)
                .SetProperty(g => g.FailedPasswordAttempts, 0)
                .SetProperty(g => g.PasswordLockedUntil, (DateTime?)null), ct);
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