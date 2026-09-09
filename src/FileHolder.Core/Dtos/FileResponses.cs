using System.Text.Json.Serialization;

namespace FileHolder.Core.Dtos;

public record PresignedItemDto(
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("uploadUrl")] string UploadUrl,
    [property: JsonPropertyName("storageKey")] string StorageKey
);

public record PresignedUrlResponseDto(
    [property: JsonPropertyName("uploadToken")] string UploadToken,
    [property: JsonPropertyName("items")] List<PresignedItemDto> Items
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
    [property: JsonPropertyName("expiresAt")] DateTime? ExpiresAt,
    [property: JsonPropertyName("remainingDownloads")] int? RemainingDownloads,
    [property: JsonPropertyName("isExpired")] bool IsExpired,
    [property: JsonPropertyName("files")] List<FileItemMetadataDto> Files
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
    EmptyBundle
}

public record StreamZipResult(
    StreamZipStatus Status,
    string? BundleTitle
);