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

        var expiredGroups = await _dbContext.FileGroups
            .Include(g => g.Files)
            .Where(g => !g.IsDeleted && (
                (g.ExpiresAt != null && g.ExpiresAt <= now) ||
                (g.MaxDownloads != null && g.DownloadCount >= g.MaxDownloads)
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

        if (allKeysToDelete.Count > 0)
        {
            await _storageProvider.DeleteObjectsAsync(allKeysToDelete, ct);
        }

        foreach (var group in expiredGroups)
        {
            group.IsDeleted = true;
            await _cache.RemoveAsync($"file_group:{group.ShareToken}", ct);
        }

        await _dbContext.SaveChangesAsync(ct);
        _logger.LogInformation("Purged {GroupCount} expired groups and deleted {KeyCount} storage objects.", expiredGroups.Count, allKeysToDelete.Count);
        return expiredGroups.Count;
    }
}