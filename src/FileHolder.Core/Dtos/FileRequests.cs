namespace FileHolder.Core.Dtos;

public record FileItemInputDto(
    string FileName,
    string ContentType,
    long SizeBytes
    );

public record CreatePresignedUrlRequestDto(
    string? Title,
    List<FileItemInputDto> Files,
    int? ExpireInHours,
    int? MaxDownloads,
    string? Password,
    bool IsEncrypted = false
    );

public record ConfirmedFileItemDto(
    string StorageKey,
    string FileName,
    string ContentType,
    long SizeBytes
    );

public record ConfirmUploadRequestDto(
    string UploadToken,
    string? Title,
    List<ConfirmedFileItemDto> Files,
    int? ExpireInHours,
    int? MaxDownloads,
    string? Password,
    bool IsEncrypted = false,
    string? EncryptedManifest = null
    );

public record DownloadRequestDto(
    string? Password
); 