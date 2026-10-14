using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Serialization;

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
    [property: JsonPropertyName("files")] List<FileItemMetadataDto> Files
);

public record UnlockResult(
    bool IsSuccess,
    bool IsPasswordInvalid,
    bool IsExpired,
    FileGroupMetadataResponseDto? Metadata
);

public record DownloadUrlResponseDto(
    [property: JsonPropertyName("downloadUrl")] string DownloadUrl
);

public record DownloadResult(
    bool IsPasswordInvalid,
    bool IsExpired,
    string? DownloadUrl
);

public enum StreamZipStatus
{
    Success,
    NotFound,
    InvalidPassword,
    Expired,
    CapacityReached,
    EmptyBundle
}

public record StreamZipResult(
    StreamZipStatus Status,
    string? BundleTitle
);