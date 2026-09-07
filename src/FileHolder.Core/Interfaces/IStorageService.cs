using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IStorageService
{
    Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto request);
    Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto request);
    Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken);
    Task<DownloadResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, string? password);
    Task<int> PurgeExpiredFilesAsync(CancellationToken cancellationToken = default);
}