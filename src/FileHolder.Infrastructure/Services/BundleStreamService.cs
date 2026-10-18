using System.Data;
using System.IO.Compression;
using System.IO.Pipelines;
using FileHolder.Core.Dtos;
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

    public Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Stream destinationStream,
        CancellationToken ct = default)
    {
        return StreamBundleZipAsync(shareToken, password, destinationStream, null, ct);
    }

    public async Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Stream destinationStream,
        Action<string>? onBeforeStream = null,
        CancellationToken ct = default)
    {
        await using var tx = await _dbContext.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

        var lockedGroup = await _dbContext.FileGroups
            .FromSqlInterpolated($"SELECT * FROM \"FileGroups\" WHERE \"ShareToken\" = {shareToken} FOR UPDATE")
            .FirstOrDefaultAsync(ct);

        if (lockedGroup == null)
        {
            await tx.RollbackAsync(ct);
            return new StreamZipResult(StreamZipStatus.NotFound, null);
        }

        if (!lockedGroup.VerifyPassword(password))
        {
            await tx.RollbackAsync(ct);
            return new StreamZipResult(StreamZipStatus.InvalidPassword, null);
        }

        var now = _dateTimeProvider.UtcNow;
        if (lockedGroup.IsExpired(now))
        {
            await tx.RollbackAsync(ct);
            return new StreamZipResult(StreamZipStatus.Expired, null);
        }

        await _dbContext.Entry(lockedGroup).Collection(g => g.Files).LoadAsync(ct);

        if (lockedGroup.Files.Count == 0)
        {
            await tx.RollbackAsync(ct);
            return new StreamZipResult(StreamZipStatus.EmptyBundle, null);
        }

        if (lockedGroup.MaxDownloads.HasValue && lockedGroup.DownloadCount >= lockedGroup.MaxDownloads.Value)
        {
            await tx.RollbackAsync(ct);
            return new StreamZipResult(StreamZipStatus.CapacityReached, null);
        }

        lockedGroup.DownloadCount++;
        bool shouldPurgeImmediately = lockedGroup.MaxDownloads.HasValue && lockedGroup.DownloadCount >= lockedGroup.MaxDownloads.Value;
        if (shouldPurgeImmediately)
        {
            lockedGroup.MarkDeleted(now);
        }

        await _dbContext.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        await _cache.RemoveAsync($"file_group:{shareToken}", CancellationToken.None);

        var fileEntries = lockedGroup.Files
            .Select(f => new BundleFileEntry(f.OriginalFileName, f.StorageKey))
            .ToList();

        var keysToDelete = shouldPurgeImmediately
            ? lockedGroup.Files.Select(f => f.StorageKey).ToList()
            : null;

        var bundleTitle = lockedGroup.Title ?? lockedGroup.ShareToken;

        onBeforeStream?.Invoke(bundleTitle);

        await StreamArchiveInternalAsync(fileEntries, destinationStream, ct);

        // Best-effort eager cleanup; anything left behind (including when streaming fails) is retried by the purge worker.
        if (shouldPurgeImmediately && keysToDelete != null && keysToDelete.Count > 0)
        {
            var failedKeys = await _storageProvider.DeleteObjectsAsync(keysToDelete, CancellationToken.None);
            if (failedKeys.Count == 0)
            {
                lockedGroup.StoragePurgedAt = _dateTimeProvider.UtcNow;
                await _dbContext.SaveChangesAsync(CancellationToken.None);
            }
        }

        return new StreamZipResult(StreamZipStatus.Success, bundleTitle);
    }

    private async Task StreamArchiveInternalAsync(IEnumerable<BundleFileEntry> files, Stream destinationStream, CancellationToken ct)
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
                // Preserve the original consumer/client exception
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