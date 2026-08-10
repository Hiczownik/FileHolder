using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IStorageService
{
    Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto request);
    Task<string> ConfirmAndPersistFileAsync(ConfirmUploadRequestDto request);
    Task<FileMetadataResponseDto?> GetMetadataByTokenAsync(string shareToken);
    Task<DownloadResult> CreatePresignedDownloadUrlAsync(string shareToken, string? password);
    Task<int> PurgeExpiredFilesAsync(CancellationToken cancellationToken = default);
}