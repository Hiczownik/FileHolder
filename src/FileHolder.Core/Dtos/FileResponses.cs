using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Serialization;
using FileHolder.Core.Entities;

namespace FileHolder.Core.Dtos;

[SuppressMessage("Naming", "CA1720:Identifiers should not contain type names", Justification = "Refers to single-file upload mode, not System.Single")]
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UploadMode
{
    Single,
    Multipart
}

public record PresignedItemDto(
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("storageKey")] string StorageKey,
    [property: JsonPropertyName("uploadMode")] UploadMode UploadMode,
    [property: JsonPropertyName("uploadUrl")] string? UploadUrl,
    [property: JsonPropertyName("uploadId")] string? UploadId,
    [property: JsonPropertyName("partSizeBytes")] long? PartSizeBytes,
    [property: JsonPropertyName("totalParts")] int? TotalParts
);

public record PresignedUrlResponseDto(
    [property: JsonPropertyName("uploadToken")] string UploadToken,
    [property: JsonPropertyName("items")] List<PresignedItemDto> Items
);

public record PartPresignedUrlDto(
    [property: JsonPropertyName("partNumber")] int PartNumber,
    [property: JsonPropertyName("uploadUrl")] string UploadUrl
);

public record PresignPartBatchResponseDto(
    [property: JsonPropertyName("parts")] List<PartPresignedUrlDto> Parts
);

public record FileItemMetadataDto(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("sizeBytes")] long SizeBytes,
    [property: JsonPropertyName("contentType")] string ContentType
);

public record FileGroupMetadataResponseDto(
    [property: JsonPropertyName("shareToken")] string ShareToken,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("totalSizeBytes")] long TotalSizeBytes,
    [property: JsonPropertyName("fileCount")] int FileCount,
    [property: JsonPropertyName("requiresPassword")] bool RequiresPassword,
    [property: JsonPropertyName("isUnlocked")] bool IsUnlocked,
    [property: JsonPropertyName("isEncrypted")] bool IsEncrypted,
    [property: JsonPropertyName("encryptedManifest")] string? EncryptedManifest,
    [property: JsonPropertyName("keyEnvelope")] string? KeyEnvelope,
    [property: JsonPropertyName("keySalt")] string? KeySalt,
    [property: JsonPropertyName("expiresAt")] DateTime? ExpiresAt,
    [property: JsonPropertyName("remainingDownloads")] int? RemainingDownloads,
    [property: JsonPropertyName("isExpired")] bool IsExpired,
    [property: JsonPropertyName("files")] List<FileItemMetadataDto> Files,
    // Like the manifest, only returned once the bundle is unlocked.
    [property: JsonPropertyName("encryptedTitle")] string? EncryptedTitle = null,
    // Returned while locked too: the download page needs it to know how to unlock.
    [property: JsonPropertyName("keyMode")] KeyMode? KeyMode = null,
    // Like the salt, returned while locked: the passkey has to be stretched before it can unlock anything.
    [property: JsonPropertyName("kdfParams")] string? KdfParams = null,
    // Taken down by the owner: the link answers 410 "removed" rather than "expired".
    [property: JsonPropertyName("isRemoved")] bool IsRemoved = false
);

public record UnlockResult(
    bool IsSuccess,
    bool IsPasswordInvalid,
    bool IsExpired,
    FileGroupMetadataResponseDto? Metadata,
    bool IsLockedOut = false,
    DateTime? LockedUntil = null,
    bool IsRemoved = false
);

/// <summary>
/// What an upload may be on this deployment (UploadLimits), so the UI checks a bundle before uploading it and offers
/// only the expiries the server accepts. The server still enforces every limit itself.
/// </summary>
public record UploadLimitsResponseDto(
    [property: JsonPropertyName("maxBundleSizeBytes")] long MaxBundleSizeBytes,
    [property: JsonPropertyName("maxFilesPerBundle")] int MaxFilesPerBundle,
    [property: JsonPropertyName("minExpiryHours")] int MinExpiryHours,
    [property: JsonPropertyName("maxExpiryHours")] int MaxExpiryHours,
    // True when uploads without an access code get these (smaller) limits, and a code unlocks more (#169).
    [property: JsonPropertyName("accessCodesEnabled")] bool AccessCodesEnabled = false,
    // The longest any bundle can live, with a code or without: what the privacy page promises about deletion.
    [property: JsonPropertyName("longestExpiryHours")] int? LongestExpiryHours = null
);

public record DownloadUrlResponseDto(
    [property: JsonPropertyName("downloadUrl")] string DownloadUrl
);

public record DownloadSessionResponseDto(
    [property: JsonPropertyName("downloadSessionId")] Guid DownloadSessionId,
    [property: JsonPropertyName("expiresAt")] DateTime ExpiresAt,
    [property: JsonPropertyName("remainingDownloads")] int? RemainingDownloads
);

public enum OpenDownloadSessionStatus
{
    Success,
    NotFound,
    InvalidPassword,
    Expired,
    /// <summary>Taken down by the owner.</summary>
    Removed,
    LockedOut
}

public record OpenDownloadSessionResult(
    OpenDownloadSessionStatus Status,
    DownloadSessionResponseDto? Session,
    DateTime? LockedUntil = null
);

public enum DownloadUrlStatus
{
    Success,
    SessionInvalid,
    FileNotFound
}

public record DownloadUrlResult(
    DownloadUrlStatus Status,
    string? DownloadUrl
);

public enum StreamZipStatus
{
    Success,
    NotFound,
    InvalidPassword,
    Expired,
    /// <summary>Taken down by the owner.</summary>
    Removed,
    SessionInvalid,
    EmptyBundle,
    LockedOut
}

public record StreamZipResult(
    StreamZipStatus Status,
    string? BundleTitle,
    DateTime? LockedUntil = null
);