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

    private static (long PartSizeBytes, int TotalParts) CalculatePartSizing(long totalSizeBytes, bool isEncrypted)
    {
        long calculatePartSize = (long)Math.Ceiling((double)totalSizeBytes / 9000);
        long partSize = Math.Max(MinPartSizeBytes, calculatePartSize);

        // An encrypted part must hold whole encrypted chunks, so the browser can encrypt it on its own.
        if (isEncrypted)
        {
            const long chunk = EncryptedStreamFormat.EncryptedChunkBytes;
            partSize = (partSize + chunk - 1) / chunk * chunk;
        }

        int totalParts = (int)Math.Ceiling((double)totalSizeBytes / partSize);
        return (partSize, totalParts);
    }

    public async Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto)
    {
        var uploadToken = Guid.NewGuid().ToString("N");
        var items = new List<PresignedItemDto>();
        var now = _dateTimeProvider.UtcNow;
        var pendingExpiresAt = now + UploadTimings.PendingUploadLifetime;

        // Until SaveChangesAsync succeeds, no MultipartUploadSession row records these uploads, so the purge
        // could never abort them: if a later file or the save fails, they are aborted here instead.
        var startedUploads = new List<(string StorageKey, string UploadId)>();

        try
        {
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
                    var (partSizeBytes, totalParts) = CalculatePartSizing(file.SizeBytes, dto.IsEncrypted);

                    var uploadId = await _storageProvider.InitiateMultipartUploadAsync(storageKey, file.ContentType);
                    startedUploads.Add((storageKey, uploadId));

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
        }
        catch
        {
            await AbortQuietlyAsync(startedUploads);
            throw;
        }

        return new PresignedUrlResponseDto(uploadToken, items);
    }

    private async Task AbortQuietlyAsync(IEnumerable<(string StorageKey, string UploadId)> uploads)
    {
        foreach (var (storageKey, uploadId) in uploads)
        {
            try
            {
                await _storageProvider.AbortMultipartUploadAsync(storageKey, uploadId, CancellationToken.None);
            }
            catch
            {
                // Best effort: the error that failed the presign is the one worth reporting.
            }
        }
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
        }

        // Everything above only reads the database. Claimed before the storage checks, copies and bcrypt, so
        // parallel confirms of one upload token can't each do that work and have all but one thrown away.
        var claimId = await ClaimPendingUploadsAsync(dto.UploadToken, pendingUploads.Count, now);

        // A single-file PUT URL stays valid after confirm, so the uploader could overwrite the checked object.
        // Those files are served from a copy under a key no URL was issued for, and its size is checked on
        // the copy. Multipart files need no copy: completing the upload consumed its upload ID, so its part
        // URLs can no longer write. Each confirm copies to fresh keys, so a confirm that fails and cleans up
        // its copies never touches another bundle's.
        var copiedKeys = new List<string>();

        try
        {
            foreach (var item in dto.Files)
            {
                var pending = pendingByKey[item.StorageKey];

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
                KeySalt = dto.KeySalt,
                EncryptedTitle = string.IsNullOrEmpty(dto.EncryptedTitle) ? null : dto.EncryptedTitle,
                KeyMode = dto.KeyMode
            };

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

            // Deleting the rows makes the token single-use. Only this confirm's claim is deleted: if it outlived
            // ConfirmClaimLifetime and another confirm took the rows over, this one loses instead.
            int claimed = await _dbContext.PendingUploads
                .Where(p => p.UploadToken == dto.UploadToken && p.ClaimId == claimId)
                .ExecuteDeleteAsync();

            if (claimed != pendingUploads.Count)
            {
                await tx.RollbackAsync();
                throw new ConflictException("This upload was confirmed by another request.");
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

            await _cache.SetAsync($"file_group:{shareToken}", fileGroup);

            return shareToken;
        }
        catch
        {
            if (copiedKeys.Count > 0)
            {
                await _storageProvider.DeleteObjectsAsync(copiedKeys, CancellationToken.None);
            }

            await ReleaseClaimAsync(claimId);
            throw;
        }
    }

    /// <summary>
    /// Claims all of the upload's pending rows for this confirm, or none: a claim another confirm still holds
    /// refuses this one with 409. Returns the claim's id, which the final delete and the release match on.
    /// </summary>
    private async Task<Guid> ClaimPendingUploadsAsync(string uploadToken, int expectedCount, DateTime now)
    {
        var claimId = Guid.NewGuid();
        var claimedUntil = now + UploadTimings.ConfirmClaimLifetime;

        // One conditional UPDATE: a parallel confirm waits on the row locks, then Postgres re-checks the WHERE
        // clause, finds the rows claimed and updates none of them.
        int claimed = await _dbContext.PendingUploads
            .Where(p => p.UploadToken == uploadToken
                        && p.ExpiresAt > now
                        && (p.ClaimedUntil == null || p.ClaimedUntil <= now))
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.ClaimId, claimId)
                .SetProperty(p => p.ClaimedUntil, claimedUntil));

        if (claimed != expectedCount)
        {
            await ReleaseClaimAsync(claimId);
            throw new ConflictException("This upload is already being confirmed. Wait a moment, then try again.");
        }

        return claimId;
    }

    /// <summary>
    /// Frees the rows of a confirm that failed, so the uploader can retry straight away. Best effort: if it
    /// fails too, the claim simply runs out after <see cref="UploadTimings.ConfirmClaimLifetime"/>.
    /// </summary>
    private async Task ReleaseClaimAsync(Guid claimId)
    {
        try
        {
            await _dbContext.PendingUploads
                .Where(p => p.ClaimId == claimId)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(p => p.ClaimId, (Guid?)null)
                    .SetProperty(p => p.ClaimedUntil, (DateTime?)null), CancellationToken.None);
        }
        catch
        {
            // The error that failed the confirm is the one worth reporting.
        }
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
            // Like the file names and sizes, the title can say what the bundle holds, so only the password reveals it.
            return new FileGroupMetadataResponseDto(
                group.ShareToken,
                null,
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
                new List<FileItemMetadataDto>(),
                KeyMode: group.KeyMode
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
            fileItemDtos,
            group.EncryptedTitle,
            group.KeyMode
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
            fileItemDtos,
            group.EncryptedTitle,
            group.KeyMode
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