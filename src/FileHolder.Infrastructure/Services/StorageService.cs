using System.Data;
using System.IO.Compression;
using System.IO.Pipelines;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Core.Security;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;

namespace FileHolder.Infrastructure.Services;

public class StorageService : IStorageService
{
    private readonly IAmazonS3 _internalS3Client;
    private readonly IAmazonS3 _presignS3Client;
    private readonly AppDbContext _dbContext;
    private readonly HybridCache _cache;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly StorageOptions _options;

    private static readonly HashSet<string> PreCompressedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".avi", ".mkv",
        ".zip", ".tar", ".gz", ".7z", ".rar", ".pdf", ".mp3", ".wav"
    };
    
    public StorageService(
        IAmazonS3 internalS3Client,
        AppDbContext dbContext,
        HybridCache cache,
        IDateTimeProvider dateTimeProvider,
        IOptions<StorageOptions> options)
    {
        _internalS3Client = internalS3Client;
        _dbContext = dbContext;
        _cache = cache;
        _dateTimeProvider = dateTimeProvider;
        _options = options.Value;
        
        var presignConfig = new AmazonS3Config
        {
            ServiceURL = _options.PublicBaseUrl,
            ForcePathStyle = true,
            UseHttp = true,
            AuthenticationRegion = "us-east-1"
        };
        _presignS3Client = new AmazonS3Client(_options.AccessKey, _options.SecretKey, presignConfig);
    }

    public async Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto)
    {
        var uploadToken = Guid.NewGuid().ToString("N");
        var items = new List<PresignedItemDto>();

        if (dto.IsEncrypted)
        {
            var storageKey = $"uploads/{Guid.NewGuid():N}.enc";
            var request = new GetPreSignedUrlRequest
            {
                BucketName = _options.BucketName,
                Key = storageKey,
                Verb = HttpVerb.PUT,
                Expires = _dateTimeProvider.UtcNow.AddMinutes(15),
                Protocol = Protocol.HTTP
            };

            string presignedUrl = _presignS3Client.GetPreSignedURL(request);
            items.Add(new PresignedItemDto("fileGroup.enc", presignedUrl, storageKey));

            return new PresignedUrlResponseDto(uploadToken, items);
        }
        
        foreach (var file in dto.Files)
        {
            var storageKey = FileSecurityUtils.GenerateStorageKey(file.FileName);

            var request = new GetPreSignedUrlRequest
            {
                BucketName = _options.BucketName,
                Key = storageKey,
                Verb = HttpVerb.PUT,
                Expires = _dateTimeProvider.UtcNow.AddMinutes(15),
                Protocol = Protocol.HTTP
            };

            string presignedUrl = _presignS3Client.GetPreSignedURL(request);
            items.Add(new PresignedItemDto(file.FileName, presignedUrl, storageKey));
        }
        
        return new PresignedUrlResponseDto(uploadToken, items);       
    }

    public async Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto dto)
    {
        foreach (var item in dto.Files)
        {
            try
            {
                var metadata = await _internalS3Client.GetObjectMetadataAsync(_options.BucketName, item.StorageKey);
                if (item.SizeBytes > 0 && metadata.ContentLength != item.SizeBytes)
                {
                    throw new InvalidOperationException($"File size mismatch for {item.FileName}.");
                }
            }
            catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                throw new KeyNotFoundException($"Uploaded object for {item.FileName} was not found in storage.");
            }
        }

        var shareToken = CryptoUtils.GenerateShortToken();
        var passwordHash = CryptoUtils.HashPassword(dto.Password);

        var fileGroup = new FileGroup
        {
            ShareToken = shareToken,
            Title = string.IsNullOrWhiteSpace(dto.Title) ? null : dto.Title.Trim(),
            PasswordHash = passwordHash,
            MaxDownloads = dto.MaxDownloads,
            ExpiresAt = dto.ExpireInHours.HasValue ? _dateTimeProvider.UtcNow.AddHours(dto.ExpireInHours.Value) : null,
            CreatedAt = _dateTimeProvider.UtcNow,
            IsEncrypted = dto.IsEncrypted,
            EncryptedManifest = dto.EncryptedManifest
        };

        foreach (var item in dto.Files)
        {
            fileGroup.Files.Add(new SharedFile
            {
                OriginalFileName = FileSecurityUtils.SanitizeFileName(item.FileName),
                StorageKey = item.StorageKey,
                ContentType = item.ContentType,
                SizeBytes = item.SizeBytes
            });
        }
        
        _dbContext.FileGroups.Add(fileGroup);
        await _dbContext.SaveChangesAsync();
        
        await _cache.SetAsync($"file_group:{shareToken}", fileGroup);
        
        return shareToken;
    }

    public async Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken)
    {
        var group = await _cache.GetOrCreateAsync(
            $"file_group:{shareToken}",
            async cancel => await _dbContext.FileGroups
                .AsNoTracking()
                .Include(g => g.Files)
                .FirstOrDefaultAsync(g => g.ShareToken == shareToken, cancel)
        );

        if (group == null) return null;

        var now = _dateTimeProvider.UtcNow;
        
        if (group.RequiresPassword && !group.IsExpired(now))
        {
            return new FileGroupMetadataResponseDto(
                group.ShareToken,
                group.Title,
                0,
                group.Files.Count,
                true,
                false,
                group.IsEncrypted,
                group.EncryptedManifest,
                group.ExpiresAt,
                group.RemainingDownloads,
                false,
                new List<FileItemMetadataDto>()
            );
        }

        var fileItemDtos = group.Files.Select(f => new FileItemMetadataDto(
            f.Id,
            f.OriginalFileName,
            f.SizeBytes,
            f.ContentType
        )).ToList();

        return new FileGroupMetadataResponseDto(
            group.ShareToken,
            group.Title,
            group.TotalSizeBytes,
            fileItemDtos.Count,
            group.RequiresPassword,
            !group.RequiresPassword,
            group.IsEncrypted,
            group.EncryptedManifest,
            group.ExpiresAt,
            group.RemainingDownloads,
            group.IsExpired(now),
            fileItemDtos
        );
    }
    
    public async Task<UnlockResult> UnlockGroupAsync(string shareToken, string password)
    {
        var group = await _dbContext.FileGroups
            .AsNoTracking()
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.ShareToken == shareToken && !g.IsDeleted);

        if (group == null)
        {
            return new UnlockResult(false, false, true, null);
        }

        var now = _dateTimeProvider.UtcNow;
        if (group.IsExpired(now))
        {
            return new UnlockResult(false, false, true, null);
        }

        if (!group.VerifyPassword(password))
        {
            return new UnlockResult(false, true, false, null);
        }

        var fileItemDtos = group.Files.Select(f => new FileItemMetadataDto(
            f.Id,
            f.OriginalFileName,
            f.SizeBytes,
            f.ContentType
        )).ToList();

        var unlockedMetadata = new FileGroupMetadataResponseDto(
            group.ShareToken,
            group.Title,
            group.TotalSizeBytes,
            fileItemDtos.Count,
            true,
            true, 
            group.IsEncrypted,
            group.EncryptedManifest,
            group.ExpiresAt,
            group.RemainingDownloads,
            false,
            fileItemDtos
        );

        return new UnlockResult(true, false, false, unlockedMetadata);
    }

    public async Task<DownloadResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, string? password)
    {
        var group = await _dbContext.FileGroups
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.ShareToken == shareToken && !g.IsDeleted);

        if (group == null) return new DownloadResult(false, true, null);

        if (!group.VerifyPassword(password))
        {
            return new DownloadResult(true, false, null);       
        }
        
        var now = _dateTimeProvider.UtcNow;

        if (group.IsExpired(now))
        {
            return new DownloadResult(false, true, null);      
        }

        var childFile = group.Files.FirstOrDefault(f => f.Id == fileId);
        if (childFile == null) return new DownloadResult(false, true, null);

        group.DownloadCount++;
        await _dbContext.SaveChangesAsync();

        await _cache.RemoveAsync($"file_group:{shareToken}");

        var presignedRequest = new GetPreSignedUrlRequest
        {
            BucketName = _options.BucketName,
            Key = childFile.StorageKey,
            Verb = HttpVerb.GET,
            Expires = _dateTimeProvider.UtcNow.AddMinutes(5),
            Protocol = Protocol.HTTP,
            ResponseHeaderOverrides = new ResponseHeaderOverrides
            {
                ContentDisposition = $"attachment; filename=\"{childFile.OriginalFileName}\"",
                ContentType = childFile.ContentType
            }
        };
        
        var downloadUrl = _presignS3Client.GetPreSignedURL(presignedRequest);
        
        return new DownloadResult(false, false, downloadUrl);       
    }

    public async Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken, 
        string? password, 
        string? existingLeaseToken, 
        Stream destinationStream, 
        Action<string>? onLeaseAcquired = null, 
        CancellationToken cancellationToken = default
    )
    {
        var now = _dateTimeProvider.UtcNow;
        DownloadLease? currentLease = null;
        FileGroup? group = null;

        // Step 2: Handle Existing Lease Check Cleanly
        if (!string.IsNullOrWhiteSpace(existingLeaseToken))
        {
            currentLease = await _dbContext.DownloadLeases
                .Include(l => l.FileGroup)
                .ThenInclude(g => g.Files)
                .FirstOrDefaultAsync(
                    l => l.LeaseToken == existingLeaseToken && l.Status == LeaseStatus.Active && l.ExpiresAt > now, 
                    cancellationToken);

            group = currentLease?.FileGroup;

            if (currentLease != null)
            {
                if (group == null)
                {
                    return new StreamZipResult(StreamZipStatus.NotFound, null);
                }

                if (!group.VerifyPassword(password))
                {
                    return new StreamZipResult(StreamZipStatus.InvalidPassword, null);
                }

                if (group.IsExpired(now))
                {
                    return new StreamZipResult(StreamZipStatus.Expired, null);
                }

                if (group.Files.Count == 0)
                {
                    return new StreamZipResult(StreamZipStatus.EmptyBundle, null);
                }
            }
        }

        // Step 3: Atomic Lock & Direct Database Lease Count
        if (currentLease == null)
        {
            // 1. Begin database transaction
            await using var tx = await _dbContext.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);

            // 2. Acquire exclusive pessimistic lock on the single row (no JOINs)
            var lockedGroup = await _dbContext.FileGroups
                .FromSqlInterpolated($"SELECT * FROM \"FileGroups\" WHERE \"ShareToken\" = {shareToken} FOR UPDATE")
                .FirstOrDefaultAsync(cancellationToken);

            if (lockedGroup == null)
            {
                await tx.RollbackAsync(cancellationToken);
                return new StreamZipResult(StreamZipStatus.NotFound, null);
            }

            // 3. Verify Domain Invariants under Lock
            if (!lockedGroup.VerifyPassword(password))
            {
                await tx.RollbackAsync(cancellationToken);
                return new StreamZipResult(StreamZipStatus.InvalidPassword, null);
            }

            if (lockedGroup.IsExpired(now))
            {
                await tx.RollbackAsync(cancellationToken);
                return new StreamZipResult(StreamZipStatus.Expired, null);
            }

            // 4. Load Child Files explicitly for the locked group
            await _dbContext.Entry(lockedGroup).Collection(g => g.Files).LoadAsync(cancellationToken);

            if (lockedGroup.Files.Count == 0)
            {
                await tx.RollbackAsync(cancellationToken);
                return new StreamZipResult(StreamZipStatus.EmptyBundle, null);
            }

            // 5. Query Active Leases directly from committed database state under the lock
            int activeLeases = await _dbContext.DownloadLeases
                .CountAsync(
                    l => l.FileGroupId == lockedGroup.Id && l.Status == LeaseStatus.Active && l.ExpiresAt > now, 
                    cancellationToken);

            if (lockedGroup.MaxDownloads.HasValue && (lockedGroup.DownloadCount + activeLeases >= lockedGroup.MaxDownloads.Value))
            {
                await tx.RollbackAsync(cancellationToken);
                return new StreamZipResult(StreamZipStatus.CapacityReached, null);
            }

            // 6. Create Lease, Save & Commit
            currentLease = new DownloadLease
            {
                FileGroupId = lockedGroup.Id,
                LeaseToken = Guid.NewGuid().ToString("N"),
                Status = LeaseStatus.Active,
                ExpiresAt = now.AddMinutes(15),
                CreatedAt = now
            };

            _dbContext.DownloadLeases.Add(currentLease);
            await _dbContext.SaveChangesAsync(cancellationToken);
            await tx.CommitAsync(cancellationToken);

            group = lockedGroup;
        }
        
        onLeaseAcquired?.Invoke(currentLease.LeaseToken);
        
        var pipe = new Pipe(new PipeOptions(
            pauseWriterThreshold: 128 * 1024,
            resumeWriterThreshold: 64 * 1024,
            useSynchronizationContext: false));
        
        var producerTask = Task.Run(async () =>
        {
            Exception? producerException = null;
            try
            {
                await using var pipeStream = pipe.Writer.AsStream();
                await using (var zipArchive = new ZipArchive(pipeStream, ZipArchiveMode.Create, leaveOpen: true))
                {
                    foreach (var file in group.Files)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        var compressionLevel = DetermineCompressionLevel(file.OriginalFileName);
                        var entry = zipArchive.CreateEntry(file.OriginalFileName, compressionLevel);

                        await using var entryStream = await entry.OpenAsync(cancellationToken);

                        var getObjectRequest = new GetObjectRequest
                        {
                            BucketName = _options.BucketName,
                            Key = file.StorageKey
                        };

                        using var response =
                            await _internalS3Client.GetObjectAsync(getObjectRequest, cancellationToken);
                        await using var s3Stream = response.ResponseStream;

                        await s3Stream.CopyToAsync(entryStream, 65536, cancellationToken);
                    }
                }
            }
            catch (Exception ex)
            {
                producerException = ex;
            }
            finally
            {
                await pipe.Writer.CompleteAsync(producerException);
            }
            
        }, cancellationToken);

        try
        {
            await pipe.Reader.CopyToAsync(destinationStream, cancellationToken);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
        }

        await producerTask;

        currentLease.Status = LeaseStatus.Completed;
        currentLease.CompletedAt = _dateTimeProvider.UtcNow;
        group.DownloadCount++;

        bool shouldPurgeImmediately = group.MaxDownloads.HasValue && group.DownloadCount >= group.MaxDownloads.Value;
        if (shouldPurgeImmediately)
        {
            group.IsDeleted = true;
        }

        await _dbContext.SaveChangesAsync(CancellationToken.None);
        await _cache.RemoveAsync($"file_group:{shareToken}", CancellationToken.None);

        if (shouldPurgeImmediately)
        {
            _ = Task.Run(async () =>
            {
                var keysToDelete = group.Files.Select(f => new KeyVersion { Key = f.StorageKey }).ToList();
                if (keysToDelete.Count > 0)
                {
                    await _internalS3Client.DeleteObjectsAsync(new DeleteObjectsRequest
                    {
                        BucketName = _options.BucketName,
                        Objects = keysToDelete
                    });
                }
            });
        }
        
        return new StreamZipResult(StreamZipStatus.Success, group.Title ?? group.ShareToken, currentLease.LeaseToken);      
    }

    public async Task<int> PurgeExpiredFilesAsync(CancellationToken cancellationToken = default)
    {
        var now = _dateTimeProvider.UtcNow;
        
        var expiredGroups = await _dbContext.FileGroups
            .Include(g => g.Files)
            .Where(g => !g.IsDeleted && (
                (g.ExpiresAt != null && g.ExpiresAt <= now) ||
                (g.MaxDownloads != null && g.DownloadCount >= g.MaxDownloads)
            ))
            .OrderBy(g => g.CreatedAt)
            .Take(100)
            .ToListAsync(cancellationToken);
        
        if (expiredGroups.Count == 0) return 0;

        var allKeysToDelete = expiredGroups
            .SelectMany(g => g.Files)
            .Select(f => new KeyVersion { Key = f.StorageKey })
            .ToList();

        if (allKeysToDelete.Count > 0)
        {
            var deleteObjectsRequest = new DeleteObjectsRequest
            {
                BucketName = _options.BucketName,
                Objects = allKeysToDelete
            };

            try
            {
                await _internalS3Client.DeleteObjectsAsync(deleteObjectsRequest, cancellationToken);
            }
            catch (AmazonS3Exception)
            {
                
            }
        }

        foreach (var group in expiredGroups)
        {
            group.IsDeleted = true;
            await _cache.RemoveAsync($"file_group:{group.ShareToken}", cancellationToken);
        }
        
        await _dbContext.SaveChangesAsync(cancellationToken);
        return expiredGroups.Count;       
    }

    private static CompressionLevel DetermineCompressionLevel(string fileName)
    {
        var ext = Path.GetExtension(fileName);
        return PreCompressedExtensions.Contains(ext)
            ? CompressionLevel.NoCompression
            : CompressionLevel.Fastest;
    }
}