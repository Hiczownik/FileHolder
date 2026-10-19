using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Exceptions;
using FileHolder.Core.Interfaces;
using FileHolder.Core.Security;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;

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
    private readonly IDownloadSessionService _downloadSessionService;
    private readonly IPasswordAttemptGuard _passwordGuard;

    public FileGroupService(
        AppDbContext dbContext,
        IS3StorageProvider storageProvider,
        HybridCache cache,
        IDateTimeProvider dateTimeProvider,
        IDownloadSessionService downloadSessionService,
        IPasswordAttemptGuard passwordGuard)
    {
        _dbContext = dbContext;
        _storageProvider = storageProvider;
        _cache = cache;
        _dateTimeProvider = dateTimeProvider;
        _downloadSessionService = downloadSessionService;
        _passwordGuard = passwordGuard;
    }

    private static bool IsMultipart(long sizeBytes) => sizeBytes > MultipartThreshold;

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
        var now = _dateTimeProvider.UtcNow;
        var pendingExpiresAt = now + UploadTimings.PendingUploadLifetime;

        foreach (var file in dto.Files)
        {
            var storageKey = dto.IsEncrypted
                ? $"uploads/{Guid.NewGuid():N}.enc"
                : FileSecurityUtils.GenerateStorageKey(file.FileName);

            // Confirm only accepts files recorded here, so the bundle's files are the ones this request approved.
            _dbContext.PendingUploads.Add(new PendingUpload
            {
                UploadToken = uploadToken,
                StorageKey = storageKey,
                FileName = FileSecurityUtils.SanitizeFileName(file.FileName),
                ContentType = file.ContentType,
                SizeBytes = file.SizeBytes,
                IsEncrypted = dto.IsEncrypted,
                CreatedAt = now,
                ExpiresAt = pendingExpiresAt
            });

            if (IsMultipart(file.SizeBytes))
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
                    ExpiresAt = pendingExpiresAt,
                    CreatedAt = now,
                };

                _dbContext.MultipartUploadSessions.Add(session);

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
                    file.SizeBytes,
                    now + UploadTimings.SinglePutUrlLifetime);

                items.Add(new PresignedItemDto(file.FileName, storageKey, UploadMode.Single, presignedUrl, null, null, null));
            }
        }

        await _dbContext.SaveChangesAsync();

        return new PresignedUrlResponseDto(uploadToken, items);
    }

    public async Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto dto)
    {
        var now = _dateTimeProvider.UtcNow;

        var pendingUploads = await _dbContext.PendingUploads
            .AsNoTracking()
            .Where(p => p.UploadToken == dto.UploadToken && p.ExpiresAt > now)
            .ToListAsync();

        if (pendingUploads.Count == 0)
        {
            throw new ResourceNotFoundException("Upload session was not found, has expired, or was already confirmed.");
        }

        var pendingByKey = pendingUploads.ToDictionary(p => p.StorageKey, StringComparer.Ordinal);
        var submittedKeys = dto.Files.Select(f => f.StorageKey).ToHashSet(StringComparer.Ordinal);

        if (submittedKeys.Count != dto.Files.Count || !submittedKeys.SetEquals(pendingByKey.Keys))
        {
            throw new InvalidRequestException("Confirmed files must be exactly the files presigned for this upload.");
        }

        if (pendingUploads.Any(p => p.IsEncrypted != dto.IsEncrypted))
        {
            throw new InvalidRequestException("Encryption mode does not match the presigned upload.");
        }

        foreach (var item in dto.Files)
        {
            var pending = pendingByKey[item.StorageKey];

            if (FileSecurityUtils.SanitizeFileName(item.FileName) != pending.FileName
                || item.ContentType != pending.ContentType
                || item.SizeBytes != pending.SizeBytes)
            {
                throw new InvalidRequestException($"File details for {item.FileName} do not match the presigned upload.");
            }

            // The presigned URL doesn't limit size, so the stored object is checked against what presign approved.
            var remoteSize = await _storageProvider.GetObjectSizeAsync(pending.StorageKey);
            if (remoteSize is null)
            {
                throw new ResourceNotFoundException($"Uploaded object for {item.FileName} was not found in storage.");
            }

            if (remoteSize.Value != pending.SizeBytes)
            {
                throw new InvalidRequestException($"File size mismatch for {item.FileName}");
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
            ExpiresAt = dto.ExpireInHours.HasValue ? now.AddHours(dto.ExpireInHours.Value) : null,
            IsEncrypted = dto.IsEncrypted,
            EncryptedManifest = dto.EncryptedManifest,
            KeyEnvelope = dto.KeyEnvelope,
            KeySalt = dto.KeySalt
        };

        // A single-file PUT URL stays valid after confirm, so the uploader could overwrite the checked object.
        // Those files are served from a copy under a key no URL was issued for, and its size is checked on
        // the copy. Multipart files need no copy: completing the upload consumed its upload ID, so its part
        // URLs can no longer write. Each confirm copies to fresh keys, so a racing confirm that loses and
        // cleans up its copies never touches the winner's.
        var copiedKeys = new List<string>();

        try
        {
            foreach (var item in dto.Files)
            {
                var pending = pendingByKey[item.StorageKey];
                var servedKey = pending.StorageKey;

                if (!IsMultipart(pending.SizeBytes))
                {
                    servedKey = $"files/{Guid.NewGuid():N}";
                    await _storageProvider.CopyObjectAsync(pending.StorageKey, servedKey);
                    copiedKeys.Add(servedKey);

                    var copiedSize = await _storageProvider.GetObjectSizeAsync(servedKey);
                    if (copiedSize != pending.SizeBytes)
                    {
                        throw new InvalidRequestException($"File size mismatch for {item.FileName}");
                    }
                }

                fileGroup.Files.Add(new SharedFile
                {
                    OriginalFileName = pending.FileName,
                    StorageKey = servedKey,
                    ContentType = pending.ContentType,
                    SizeBytes = pending.SizeBytes
                });
            }

            await using var tx = await _dbContext.Database.BeginTransactionAsync();

            // Claiming the rows makes the token single-use: the DELETE locks them, so a concurrent confirm
            // waits, then deletes nothing and is rejected instead of creating a second bundle.
            int claimed = await _dbContext.PendingUploads
                .Where(p => p.UploadToken == dto.UploadToken && p.ExpiresAt > now)
                .ExecuteDeleteAsync();

            if (claimed != pendingUploads.Count)
            {
                await tx.RollbackAsync();
                throw new InvalidRequestException("This upload was already confirmed.");
            }

            // The copied originals are left to the abandoned-upload purge, which deletes them once their PUT
            // URL has expired (see UploadTimings.SinglePutUrlLifetime). Deleting them now would let the uploader
            // put a fresh object there that nothing tracks. The new token was never handed out, so no confirm
            // can claim these rows.
            var purgeToken = Guid.NewGuid().ToString("N");
            foreach (var pending in pendingUploads.Where(p => !IsMultipart(p.SizeBytes)))
            {
                _dbContext.PendingUploads.Add(new PendingUpload
                {
                    UploadToken = purgeToken,
                    StorageKey = pending.StorageKey,
                    FileName = pending.FileName,
                    ContentType = pending.ContentType,
                    SizeBytes = pending.SizeBytes,
                    IsEncrypted = pending.IsEncrypted,
                    CreatedAt = now,
                    ExpiresAt = now
                });
            }

            _dbContext.FileGroups.Add(fileGroup);
            await _dbContext.SaveChangesAsync();
            await tx.CommitAsync();
        }
        catch
        {
            if (copiedKeys.Count > 0)
            {
                await _storageProvider.DeleteObjectsAsync(copiedKeys, CancellationToken.None);
            }

            throw;
        }

        await _cache.SetAsync($"file_group:{shareToken}", fileGroup);

        return shareToken;
    }

    public async Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken)
    {
        var cacheKey = $"file_group:{shareToken}";

        // Prefer the live group if a deleted one reused the token, as the unlock and session lookups do.
        var group = await _cache.GetOrCreateAsync(
            cacheKey,
            async cancel => await _dbContext.FileGroups
                .AsNoTracking()
                .Include(g => g.Files)
                .Where(g => g.ShareToken == shareToken)
                .OrderBy(g => g.IsDeleted)
                .ThenByDescending(g => g.CreatedAt)
                .FirstOrDefaultAsync(cancel)
        );

        if (group == null)
        {
            // HybridCache keeps null results too. Unknown tokens are whatever a caller makes up, so caching
            // them would let anyone fill memory with requests for random tokens.
            await _cache.RemoveAsync(cacheKey);
            return null;
        }

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
                null,
                null,
                group.KeySalt,
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
            group.KeyEnvelope,
            group.KeySalt,
            group.ExpiresAt,
            group.RemainingDownloads,
            group.IsExpired(now),
            fileItemDtos
        );
    }

    public async Task<UnlockResult> UnlockGroupAsync(string shareToken, string password)
    {
        // Same lookup as opening a download session: deleted groups are included so a used-up or
        // purged bundle reports "expired" rather than "not found", but a live group reusing the token wins.
        var group = await _dbContext.FileGroups
            .AsNoTracking()
            .Include(g => g.Files)
            .Where(g => g.ShareToken == shareToken)
            .OrderBy(g => g.IsDeleted)
            .ThenByDescending(g => g.CreatedAt)
            .FirstOrDefaultAsync();

        if (group == null)
        {
            return new UnlockResult(false, false, false, null);
        }

        var now = _dateTimeProvider.UtcNow;
        if (group.IsExpired(now))
        {
            return new UnlockResult(false, false, true, null);
        }

        var passwordCheck = await _passwordGuard.CheckAsync(group, password);
        if (passwordCheck.Outcome == PasswordCheckOutcome.LockedOut)
        {
            return new UnlockResult(false, false, false, null, IsLockedOut: true, LockedUntil: passwordCheck.LockedUntil);
        }

        if (passwordCheck.Outcome == PasswordCheckOutcome.Incorrect)
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
            group.KeyEnvelope,
            group.KeySalt,
            group.ExpiresAt,
            group.RemainingDownloads,
            false,
            fileItemDtos
        );

        return new UnlockResult(true, false, false, unlockedMetadata);
    }

    public async Task<DownloadUrlResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, Guid? downloadSessionId)
    {
        // The download was already counted (and the password checked) when the session was opened.
        if (!downloadSessionId.HasValue)
        {
            return new DownloadUrlResult(DownloadUrlStatus.SessionInvalid, null);
        }

        var session = await _downloadSessionService.GetActiveSessionAsync(shareToken, downloadSessionId.Value);
        if (session == null)
        {
            return new DownloadUrlResult(DownloadUrlStatus.SessionInvalid, null);
        }

        var childFile = session.FileGroup.Files.FirstOrDefault(f => f.Id == fileId);
        if (childFile == null)
        {
            return new DownloadUrlResult(DownloadUrlStatus.FileNotFound, null);
        }

        var downloadUrl = _storageProvider.GeneratePresignedDownloadUrl(
            childFile.StorageKey,
            childFile.OriginalFileName,
            childFile.ContentType,
            _dateTimeProvider.UtcNow + DownloadTimings.PresignedUrlLifetime);

        return new DownloadUrlResult(DownloadUrlStatus.Success, downloadUrl);
    }
}