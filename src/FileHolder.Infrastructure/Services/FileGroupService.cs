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

public class FileGroupService
    : IFileGroupService
{
    private const long MultipartThreshold = 50L * 1024 * 1024;
    private const long MinPartSizeBytes = 16L * 1024 * 1024;

    private readonly AppDbContext _dbContext;
    private readonly IS3StorageProvider _storageProvider;
    private readonly HybridCache _cache;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly StorageOptions _options;

    public FileGroupService(AppDbContext dbContext, IS3StorageProvider storageProvider, HybridCache cache, IDateTimeProvider dateTimeProvider, IOptions<StorageOptions> options)
    {
        _dbContext = dbContext;
        _storageProvider = storageProvider;
        _cache = cache;
        _dateTimeProvider = dateTimeProvider;
        _options = options.Value;
    }

    private static (long PartSizeBytes, int TotalParts) CalculatePartSizing(long totalSizeBytes)
    {
        long calculatePartSize = (long)Math.Ceiling((double)totalSizeBytes / 9000);
        long partSize = Math.Max(MinPartSizeBytes, calculatePartSize);
        int totalParts = (int)Math.Ceiling((double)totalSizeBytes / partSize);
        return (partSize, totalParts);
    }

    public async Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto)
    {
        var uploadToken = Guid.NewGuid().ToString("N");
        var items = new List<PresignedItemDto>();
        bool sessionsAdded = false;

        if (dto.IsEncrypted)
        {
            var storageKey = $"uploads/{Guid.NewGuid():N}.enc";
            var presignedUrl = _storageProvider.GeneratePresignedUploadUrl(
                storageKey,
                _dateTimeProvider.UtcNow.AddMinutes(15));

            items.Add(new PresignedItemDto("fileGroup.enc", storageKey, UploadMode.Single, presignedUrl, null, null, null));
            return new PresignedUrlResponseDto(uploadToken, items);
        }

        foreach (var file in dto.Files)
        {
            var storageKey = FileSecurityUtils.GenerateStorageKey(file.FileName);

            if (file.SizeBytes > MultipartThreshold)
            {
                var (partSizeBytes, totalParts) = CalculatePartSizing(file.SizeBytes);

                var uploadId = await _storageProvider.InitiateMultipartUploadAsync(storageKey, file.ContentType);

                var session = new MultipartUploadSession
                {
                    UploadToken = uploadToken,
                    UploadId = uploadId,
                    StorageKey = storageKey,
                    FileName = FileSecurityUtils.SanitizeFileName(file.FileName),
                    ContentType = file.ContentType,
                    PartSizeBytes = partSizeBytes,
                    TotalSizeBytes = file.SizeBytes,
                    TotalParts = totalParts,
                    ExpiresAt = _dateTimeProvider.UtcNow.AddHours(24),
                    CreatedAt = _dateTimeProvider.UtcNow,
                };

                _dbContext.MultipartUploadSessions.Add(session);
                sessionsAdded = true;

                items.Add(new PresignedItemDto(
                    file.FileName,
                    storageKey,
                    UploadMode.Multipart,
                    null,
                    uploadId,
                    partSizeBytes,
                    totalParts
                ));
            }
            else
            {
                var presignedUrl = _storageProvider.GeneratePresignedUploadUrl(
                    storageKey,
                    _dateTimeProvider.UtcNow.AddMinutes(15));

                items.Add(new PresignedItemDto(file.FileName, storageKey, UploadMode.Single, presignedUrl, null, null, null));
            }
        }

        if (sessionsAdded)
        {
            await _dbContext.SaveChangesAsync();
        }

        return new PresignedUrlResponseDto(uploadToken, items);
    }

    public async Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto dto)
    {
        foreach (var item in dto.Files)
        {
            var remoteSize = await _storageProvider.GetObjectSizeAsync(item.StorageKey);
            if (remoteSize is null)
            {
                throw new KeyNotFoundException($"Uploaded object for {item.FileName} was not found in storage.");
            }

            if (item.SizeBytes > 0 && remoteSize.Value != item.SizeBytes)
            {
                throw new InvalidOperationException($"File size mismatch for {item.FileName}");
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
            return new UnlockResult(false, true, false, null);
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
        if (childFile == null) return new DownloadResult(false, false, null);

        group.DownloadCount++;
        await _dbContext.SaveChangesAsync();

        await _cache.RemoveAsync($"file_group:{shareToken}");

        var downloadUrl = _storageProvider.GeneratePresignedDownloadUrl(
            childFile.StorageKey,
            childFile.OriginalFileName,
            childFile.ContentType,
            _dateTimeProvider.UtcNow.AddMinutes(5));

        return new DownloadResult(false, false, downloadUrl);
    }
}