using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IFileGroupService
{
    Task<PresignedUrlResponseDto> CreatePresignedUploadUrlAsync(CreatePresignedUrlRequestDto dto);
    Task<string> ConfirmAndPersistFileGroupAsync(ConfirmUploadRequestDto dto);
    Task<FileGroupMetadataResponseDto?> GetGroupMetadataByTokenAsync(string shareToken);
    Task<UnlockResult> UnlockGroupAsync(string shareToken, string password);
    Task<DownloadUrlResult> CreatePresignedDownloadUrlAsync(string shareToken, Guid fileId, Guid? downloadSessionId);
}