namespace FileHolder.Core.Dtos;

public record CreatePresignedUrlRequestDto(
    string FileName,
    string ContentType,
    long SizeBytes,
    int? ExpireInHours,
    int? MaxDownloads,
    string? Password
    );
    
public record ConfirmUploadRequestDto(
    string UploadToken,
    string StorageKey,
    string FileName,
    string ContentType,
    long SizeBytes,
    int? ExpireInHours,
    int? MaxDownloads,
    string? Password
    );

public record DownloadRequestDto(
    string? Password
); 