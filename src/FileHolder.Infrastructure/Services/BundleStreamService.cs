using System.Data;
using System.IO.Compression;
using System.IO.Pipelines;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;

namespace FileHolder.Infrastructure.Services;

public class BundleStreamService(
    AppDbContext dbContext,
    IS3StorageProvider storageProvider,
    HybridCache cache,
    IDateTimeProvider dateTimeProvider
    )
    : IBundleStreamService
{
    private static readonly HashSet<string> PreCompressedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".avi", ".mkv",
        ".zip", ".tar", ".gz", ".7z", ".rar", ".pdf", ".mp3", ".wav"
    };

    private readonly AppDbContext _dbContext = dbContext;
    private readonly IS3StorageProvider _storageProvider = storageProvider;
    private readonly HybridCache _cache = cache;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;
    
    public async Task<AcquireLeaseResult> AcquireLeaseAsync(string shareToken, string? password, string? existingLeaseToken, CancellationToken ct = default)
    {
        var now = _dateTimeProvider.UtcNow;

        if (!string.IsNullOrWhiteSpace(existingLeaseToken))
        {
            var currentLease = await _dbContext.DownloadLeases
                .Include(l => l.FileGroup)
                .ThenInclude(g => g.Files)
                .FirstOrDefaultAsync(
                    l => l.LeaseToken == existingLeaseToken && l.Status == LeaseStatus.Active && l.ExpiresAt > now,
                    ct);

            if (currentLease != null)
            {
                var group = currentLease.FileGroup;
                if (group == null)
                {
                    return new AcquireLeaseResult(StreamZipStatus.NotFound);
                }

                if (!group.VerifyPassword(password))
                {
                    return new AcquireLeaseResult(StreamZipStatus.InvalidPassword);
                }

                if (group.IsExpired(now))
                {
                    return new AcquireLeaseResult(StreamZipStatus.Expired);
                }

                if (group.Files.Count == 0)
                {
                    return new AcquireLeaseResult(StreamZipStatus.EmptyBundle);
                }

                var cachedFiles = group.Files
                    .Select(f => new BundleFileEntry(f.OriginalFileName, f.StorageKey))
                    .ToList();

                return new AcquireLeaseResult(
                    StreamZipStatus.Success,
                    currentLease.LeaseToken,
                    group.Title ?? group.ShareToken,
                    group.Id,
                    cachedFiles);
            }
        }

        await using var tx = await _dbContext.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

        var lockedGroup = await _dbContext.FileGroups
            .FromSqlInterpolated($"SELECT * FROM \"FileGroups\" WHERE \"ShareToken\" = {shareToken} FOR UPDATE")
            .FirstOrDefaultAsync(ct);

        if (lockedGroup == null)
        {
            await tx.RollbackAsync(ct);
            return new AcquireLeaseResult(StreamZipStatus.NotFound);
        }

        if (!lockedGroup.VerifyPassword(password))
        {
            await tx.RollbackAsync(ct);
            return new AcquireLeaseResult(StreamZipStatus.InvalidPassword);
        }

        if (lockedGroup.IsExpired(now))
        {
            await tx.RollbackAsync(ct);
            return new AcquireLeaseResult(StreamZipStatus.Expired);
        }

        await _dbContext.Entry(lockedGroup).Collection(g => g.Files).LoadAsync(ct);

        if (lockedGroup.Files.Count == 0)
        {
            await tx.RollbackAsync(ct);
            return new AcquireLeaseResult(StreamZipStatus.EmptyBundle);
        }

        int activeLeases = await _dbContext.DownloadLeases
                .CountAsync(l =>
                    l.FileGroupId == lockedGroup.Id && l.Status == LeaseStatus.Active && l.ExpiresAt > now, ct);

        if (lockedGroup.MaxDownloads.HasValue &&
            (lockedGroup.DownloadCount + activeLeases >= lockedGroup.MaxDownloads.Value))
        {
            await tx.RollbackAsync(ct);
            return new AcquireLeaseResult(StreamZipStatus.CapacityReached);
        }

        var newLease = new DownloadLease
        {
            FileGroupId = lockedGroup.Id,
            LeaseToken = Guid.NewGuid().ToString("N"),
            Status = LeaseStatus.Active,
            ExpiresAt = now.AddMinutes(15),
            CreatedAt = now
        };

        _dbContext.DownloadLeases.Add(newLease);
        await _dbContext.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        var fileEntries = lockedGroup.Files
            .Select(f => new BundleFileEntry(f.OriginalFileName, f.StorageKey))
            .ToList();

        return new AcquireLeaseResult(
            StreamZipStatus.Success,
            newLease.LeaseToken,
            lockedGroup.Title ?? lockedGroup.ShareToken,
            lockedGroup.Id,
            fileEntries);
    }

    public async Task StreamArchiveAsync(IEnumerable<BundleFileEntry> files, Stream destinationStream, CancellationToken ct = default)
    {
        var pipe = new Pipe(new PipeOptions(
            pauseWriterThreshold: 128 * 1024,
            resumeWriterThreshold: 64 * 1024,
            useSynchronizationContext: false));

        var fileList = files.ToList();
        
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        
        var producerTask = Task.Run(async () =>
        {
            Exception? producerException = null;
            try
            {
                await using var pipeStream = pipe.Writer.AsStream(leaveOpen: true);
                await using var zipArchive = new ZipArchive(pipeStream, ZipArchiveMode.Create, leaveOpen: true);
                foreach (var file in fileList)
                {
                    // ReSharper disable AccessToDisposedClosure
                    linkedCts.Token.ThrowIfCancellationRequested();

                    var compressionLevel = DetermineCompressionLevel(file.OriginalFileName);
                    var entry = zipArchive.CreateEntry(file.OriginalFileName, compressionLevel);

                    await using var entryStream = await entry.OpenAsync(linkedCts.Token);
                    await using var s3Stream = await _storageProvider.OpenReadStreamAsync(file.StorageKey, linkedCts.Token);

                    await s3Stream.CopyToAsync(entryStream, 65536, linkedCts.Token);
                }
            }
            catch (Exception ex)
            {
                producerException = ex;
                throw;
            }
            finally
            {
                await pipe.Writer.CompleteAsync(producerException);
            }
        }, linkedCts.Token);

        Exception? consumerException = null;

        try
        {
            await pipe.Reader.CopyToAsync(destinationStream, linkedCts.Token);
        }
        catch (Exception ex)
        {
            consumerException = ex;
            await linkedCts.CancelAsync();
            throw;
        }
        finally
        {
            await pipe.Reader.CompleteAsync(consumerException);
            try
            {
                await producerTask;
            }
            catch when (consumerException != null)
            {
                // preserve the original consumer/client exception
            }
        }
    }

    public async Task FinalizeLeaseAsync(string leaseToken, Guid fileGroupId, string shareToken, CancellationToken ct = default)
    {
        var lease = await _dbContext.DownloadLeases
            .FirstOrDefaultAsync(l => l.LeaseToken == leaseToken, ct);

        if (lease != null)
        {
            lease.Status = LeaseStatus.Completed;
            lease.CompletedAt = _dateTimeProvider.UtcNow;
        }

        var group = await _dbContext.FileGroups
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == fileGroupId, ct);

        if (group != null)
        {
            group.DownloadCount++;

            bool shouldPurgeImmediately =
                group.MaxDownloads.HasValue && group.DownloadCount >= group.MaxDownloads.Value;

            if (shouldPurgeImmediately)
            {
                group.IsDeleted = true;
            }

            await _dbContext.SaveChangesAsync(CancellationToken.None);
            await _cache.RemoveAsync($"file_group:{shareToken}", CancellationToken.None);

            if (shouldPurgeImmediately)
            {
                var keysToDelete = group.Files.Select(f => f.StorageKey).ToList();
                if (keysToDelete.Count > 0)
                {
                    await _storageProvider.DeleteObjectsAsync(keysToDelete, CancellationToken.None);
                }
            }
        }
    }

    public async Task ReleaseLeaseAsync(string leaseToken, Guid fileGroupId, CancellationToken ct = default)
    {
        var lease = await _dbContext.DownloadLeases
            .Include(l => l.FileGroup)
            .FirstOrDefaultAsync(l => l.LeaseToken == leaseToken &&
                                      l.FileGroupId == fileGroupId && 
                                      l.Status == LeaseStatus.Active, ct);

        if (lease != null)
        {
            lease.Status = LeaseStatus.Expired;
            lease.CompletedAt = _dateTimeProvider.UtcNow;

            await _dbContext.SaveChangesAsync(ct);

            if (lease.FileGroup != null)
            {
                await _cache.RemoveAsync($"file_group:{lease.FileGroup.ShareToken}", ct);
            }
        }
    }

    private static CompressionLevel DetermineCompressionLevel(string fileName)
    {
        var ext = Path.GetExtension(fileName);
        return PreCompressedExtensions.Contains(ext)
            ? CompressionLevel.NoCompression
            : CompressionLevel.Fastest;
    }
}