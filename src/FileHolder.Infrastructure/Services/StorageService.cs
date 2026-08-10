using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Core.Security;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Configuration;

namespace FileHolder.Infrastructure.Services;

public class StorageService : IStorageService
{
    private readonly IAmazonS3 _internalS3Client;
    private readonly IAmazonS3 _presignS3Client;
    private readonly AppDbContext _dbContext;
    private readonly HybridCache _cache;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly string _bucketName;

    public StorageService(
        IAmazonS3 internalS3Client,
        AppDbContext dbContext,
        HybridCache cache,
        IDateTimeProvider dateTimeProvider,
        IConfiguration config)
    {
        _internalS3Client = internalS3Client;
        _dbContext = dbContext;
        _cache = cache;
        _dateTimeProvider = dateTimeProvider;
        _bucketName = config["Storage:BucketName"] ?? "fileholder-bucket";

        var publicBaseUrl = config["Storage:PublicBaseUrl"] ?? "http://localhost:9000";
        var accessKey = config["Storage:AccessKey"] ?? "minioadmin";
        var secretKey = config["Storage:SecretKey"] ?? "minioadmin";

        var presignConfig = new AmazonS3Config
        {
            ServiceURL = publicBaseUrl,
            ForcePathStyle = true,
            UseHttp = true
        };
        _presignS3Client = new AmazonS3Client(accessKey, secretKey, presignConfig);
    }

    public async Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto)
    {
        var storageKey = FileSecurityUtils.GenerateStorageKey(dto.FileName);
        var uploadToken = Guid.NewGuid().ToString("N");

        var request = new GetPreSignedUrlRequest
        {
            BucketName = _bucketName,
            Key = storageKey,
            Verb = HttpVerb.PUT,
            Expires = _dateTimeProvider.UtcNow.AddMinutes(15),
            Protocol = Protocol.HTTP // Explicitly force HTTP scheme (http://localhost:9000)
        };

        string presignedUrl = _presignS3Client.GetPreSignedURL(request);

        return new PresignedUrlResponseDto(presignedUrl, storageKey, uploadToken);
    }

    public async Task<string> ConfirmAndPersistFileAsync(ConfirmUploadRequestDto dto)
    {
        try
        {
            var metadata = await _internalS3Client.GetObjectMetadataAsync(_bucketName, dto.StorageKey);

            if (dto.SizeBytes > 0 && metadata.ContentLength != dto.SizeBytes)
            {
                throw new InvalidOperationException("Uploaded file size does not match request metadata.");
            }
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            throw new KeyNotFoundException("Uploaded object was not found in storage.");
        }

        var shareToken = CryptoUtils.GenerateShortToken();
        var passwordHash = CryptoUtils.HashPassword(dto.Password);
        var sanitizedFileName = FileSecurityUtils.SanitizeFileName(dto.FileName);

        var sharedFile = new SharedFile
        {
            ShareToken = shareToken,
            OriginalFileName = sanitizedFileName,
            StorageKey = dto.StorageKey,
            ContentType = dto.ContentType,
            SizeBytes = dto.SizeBytes,
            PasswordHash = passwordHash,
            MaxDownloads = dto.MaxDownloads,
            ExpiresAt = dto.ExpireInHours.HasValue ? _dateTimeProvider.UtcNow.AddHours(dto.ExpireInHours.Value) : null,
            CreatedAt = _dateTimeProvider.UtcNow
        };

        _dbContext.SharedFiles.Add(sharedFile);
        await _dbContext.SaveChangesAsync();

        await _cache.SetAsync($"file_meta:{shareToken}", sharedFile);

        return shareToken;
    }

    public async Task<FileMetadataResponseDto?> GetMetadataByTokenAsync(string shareToken)
    {
        var file = await _cache.GetOrCreateAsync(
            $"file_meta:{shareToken}",
            async cancel => await _dbContext.SharedFiles
                .AsNoTracking()
                .FirstOrDefaultAsync(f => f.ShareToken == shareToken && !f.IsDeleted, cancel)
        );

        if (file == null) return null;

        var now = _dateTimeProvider.UtcNow;
        bool isExpired = (file.ExpiresAt.HasValue && file.ExpiresAt.Value <= now) ||
                         (file.MaxDownloads.HasValue && file.DownloadCount >= file.MaxDownloads.Value);

        int? remainingDownloads = file.MaxDownloads.HasValue
            ? Math.Max(0, file.MaxDownloads.Value - file.DownloadCount)
            : null;

        return new FileMetadataResponseDto(
            file.ShareToken,
            file.OriginalFileName,
            file.SizeBytes,
            file.ContentType,
            !string.IsNullOrEmpty(file.PasswordHash),
            file.ExpiresAt,
            remainingDownloads,
            isExpired
        );
    }

    public async Task<DownloadResult> CreatePresignedDownloadUrlAsync(string shareToken, string? password)
    {
        var file = await _dbContext.SharedFiles.FirstOrDefaultAsync(f => f.ShareToken == shareToken && !f.IsDeleted);

        if (file == null) return new DownloadResult(false, true, null);

        if (!string.IsNullOrEmpty(file.PasswordHash))
        {
            if (string.IsNullOrEmpty(password) || !CryptoUtils.VerifyPassword(password, file.PasswordHash))
            {
                return new DownloadResult(true, false, null);
            }
        }

        var now = _dateTimeProvider.UtcNow;

        if ((file.ExpiresAt.HasValue && file.ExpiresAt.Value <= now) ||
            (file.MaxDownloads.HasValue && file.DownloadCount >= file.MaxDownloads.Value))
        {
            return new DownloadResult(false, true, null);
        }

        file.DownloadCount++;
        await _dbContext.SaveChangesAsync();

        await _cache.RemoveAsync($"file_meta:{shareToken}");

        var presignedRequest = new GetPreSignedUrlRequest
        {
            BucketName = _bucketName,
            Key = file.StorageKey,
            Verb = HttpVerb.GET,
            Expires = _dateTimeProvider.UtcNow.AddMinutes(5),
            Protocol = Protocol.HTTP, // Explicitly force HTTP scheme
            ResponseHeaderOverrides = new ResponseHeaderOverrides
            {
                ContentDisposition = $"attachment; filename=\"{file.OriginalFileName}\"",
                ContentType = file.ContentType
            }
        };

        string downloadUrl = _presignS3Client.GetPreSignedURL(presignedRequest);

        return new DownloadResult(false, false, downloadUrl);
    }

    public async Task<int> PurgeExpiredFilesAsync(CancellationToken cancellationToken = default)
    {
        var now = _dateTimeProvider.UtcNow;

        var expiredFiles = await _dbContext.SharedFiles
            .Where(f => !f.IsDeleted && (
                (f.ExpiresAt != null && f.ExpiresAt <= now) ||
                (f.MaxDownloads != null && f.DownloadCount >= f.MaxDownloads)
            ))
            .OrderBy(f => f.CreatedAt) // Added OrderBy to fix EF Core row-limiting warning
            .Take(100)
            .ToListAsync(cancellationToken);

        if (expiredFiles.Count == 0) return 0;

        var deleteObjectsRequest = new DeleteObjectsRequest
        {
            BucketName = _bucketName,
            Objects = expiredFiles.Select(f => new KeyVersion { Key = f.StorageKey }).ToList()
        };

        try
        {
            await _internalS3Client.DeleteObjectsAsync(deleteObjectsRequest, cancellationToken);
        }
        catch (AmazonS3Exception)
        {
            
        }

        foreach (var file in expiredFiles)
        {
            file.IsDeleted = true;
            await _cache.RemoveAsync($"file_meta:{file.ShareToken}", cancellationToken);
        }

        await _dbContext.SaveChangesAsync(cancellationToken);
        return expiredFiles.Count;
    }
}