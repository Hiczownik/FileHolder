using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IMultipartUploadService
{
    Task<PresignPartBatchResponseDto> PresignPartBatchAsync(PresignPartBatchRequestDto dto);
    Task<bool> CompleteMultipartUploadAsync(CompleteMultipartUploadRequestDto dto);
    Task<bool> AbortMultipartUploadAsync(AbortMultipartUploadRequestDto dto);
}