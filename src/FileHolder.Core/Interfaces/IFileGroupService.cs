using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IFileGroupService
{
    /// <param name="tier">What the access code (or its absence) allows (#169); unrestricted when omitted.</param>
    Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto, UploadTier? tier = null);
    Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto dto);
    Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken);
    Task<UnlockResult> UnlockGroupAsync(string shareToken, string password);
    Task<DownloadUrlResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, Guid? downloadSessionId);
}