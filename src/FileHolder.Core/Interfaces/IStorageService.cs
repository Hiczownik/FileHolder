using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IStorageService
{
    Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto request);
    Task<PresignPartBatchResponseDto> PresignPartBatchAsync(PresignPartBatchRequestDto dto);
    Task<bool> CompleteMultipartUploadAsync(CompleteMultipartUploadRequestDto dto);
    Task<bool> AbortMultipartUploadAsync(AbortMultipartUploadRequestDto dto);
    Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto request);
    Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken);
    Task<UnlockResult> UnlockGroupAsync(string shareToken, string password);
    Task<DownloadResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, string? password);
    Task<int> PurgeExpiredFilesAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Pipes multiple S3 object streams directly into an on-the-fly compressed ZIP archive
    /// streamed into the destination stream with constant low-memory overhead.
    /// </summary>
    /// <param name="shareToken"></param>
    /// <param name="password"></param>
    /// <param name="existingLeaseToken"></param>
    /// <param name="destinationStream"></param>
    /// <param name="onLeaseAcquired"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password, 
        string? existingLeaseToken,
        Stream destinationStream,
        Action<string>? onLeaseAcquired = null,
        CancellationToken cancellationToken = default);
}