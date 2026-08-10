namespace FileHolder.Core.Dtos;

public record PresignedUrlResponseDto(
    string UploadUrl,
    string StorageKey,
    string UploadToken
    );

public record FileMetadataResponseDto(
    string ShareToken,
    string FileName,
    long SizeBytes,
    string ContentType,
    bool RequiresPassword,
    DateTime? ExpiresAt,
    int? RemainingDownloads,
    bool IsExpired
    );

public record DownloadUrlResponseDto(string DownloadUrl); 

public record DownloadResult(
    bool IsPasswordInvalid,
    bool IsExpired,
    string? DownloadUrl);