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
using Microsoft.EntityFrameworkCore.Metadata.Conventions;
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
            CreatedAt = _dateTimeProvider.UtcNow
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
                .FirstOrDefaultAsync(g => g.ShareToken == shareToken && !g.IsDeleted, cancel)
        );

        if (group == null) return null;
        
        var now = _dateTimeProvider.UtcNow;
        
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
            !string.IsNullOrEmpty(group.PasswordHash),
            group.ExpiresAt,
            group.RemainingDownloads,
            group.IsExpired(now),
            fileItemDtos);
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

    public async Task<StreamZipResult> StreamBundleZipAsync(string shareToken, string? password, Stream destinationStream,
        CancellationToken cancellationToken = default)
    {
        var group = await _dbContext.FileGroups.Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.ShareToken == shareToken && !g.IsDeleted, cancellationToken);

        if (group == null)
        {
            return new StreamZipResult(StreamZipStatus.NotFound, null);
        }

        if (!group.VerifyPassword(password))
        {
            return new StreamZipResult(StreamZipStatus.InvalidPassword, null);       
        }

        var now = _dateTimeProvider.UtcNow;
        if (group.IsExpired(now))
        {
            return new StreamZipResult(StreamZipStatus.Expired, null);
        }

        if (group.Files.Count == 0)
        {
            return new StreamZipResult(StreamZipStatus.EmptyBundle, null);
        }
        
        group.DownloadCount++;
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _cache.RemoveAsync($"file_group:{shareToken}", cancellationToken);

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
        
        return new StreamZipResult(StreamZipStatus.Success, group.Title ?? group.ShareToken);      
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