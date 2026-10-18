using FileHolder.Core.Dtos;
using FileHolder.Core.Exceptions;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Infrastructure.Services;

public class MultipartUploadService(
    AppDbContext dbContext,
    IS3StorageProvider storageProvider,
    IDateTimeProvider dateTimeProvider)
    : IMultipartUploadService
{
    private readonly AppDbContext _dbContext = dbContext;
    private readonly IS3StorageProvider _storageProvider = storageProvider;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;

    public async Task<PresignPartBatchResponseDto> PresignPartBatchAsync(PresignPartBatchRequestDto dto)
    {
        var session = await _dbContext.MultipartUploadSessions
            .FirstOrDefaultAsync(s =>
                s.UploadToken == dto.UploadToken && s.UploadId == dto.UploadId && !s.IsCompleted && !s.IsAborted);

        if (session == null)
        {
            throw new ResourceNotFoundException("Active multipart upload session not found.");
        }

        // The endpoint validator bounds these too; checked here so the loop below is always bounded by TotalParts.
        if (dto.StartPartNumber < 1 || dto.StartPartNumber > session.TotalParts || dto.Count < 1)
        {
            throw new InvalidRequestException($"Part range must start between 1 and {session.TotalParts} with a positive count.");
        }

        var parts = new List<PartPresignedUrlDto>();
        int endPart = (int)Math.Min((long)dto.StartPartNumber + dto.Count - 1, session.TotalParts);

        for (int partNumber = dto.StartPartNumber; partNumber <= endPart; partNumber++)
        {
            string presignedUrl = _storageProvider.GeneratePresignedPartUploadUrl(
                session.StorageKey,
                dto.UploadId,
                partNumber,
                _dateTimeProvider.UtcNow.AddMinutes(30));

            parts.Add(new PartPresignedUrlDto(partNumber, presignedUrl));
        }

        return new PresignPartBatchResponseDto(parts);
    }

    public async Task<bool> CompleteMultipartUploadAsync(CompleteMultipartUploadRequestDto dto)
    {
        var session = await _dbContext.MultipartUploadSessions
            .FirstOrDefaultAsync(s =>
                s.UploadToken == dto.UploadToken && s.UploadId == dto.UploadId && !s.IsCompleted && !s.IsAborted);

        if (session == null)
        {
            throw new ResourceNotFoundException("Active multipart upload session was not found.");
        }

        var parts = dto.Parts.Select(p => (p.PartNumber, p.ETag));
        await _storageProvider.CompleteMultipartUploadAsync(session.StorageKey, session.UploadId, parts);

        session.IsCompleted = true;
        await _dbContext.SaveChangesAsync();

        return true;
    }

    public async Task<bool> AbortMultipartUploadAsync(AbortMultipartUploadRequestDto dto)
    {
        var session = await _dbContext.MultipartUploadSessions
            .FirstOrDefaultAsync(s =>
                s.UploadToken == dto.UploadToken && s.UploadId == dto.UploadId && !s.IsCompleted && !s.IsAborted);

        if (session == null)
        {
            return false;
        }

        await _storageProvider.AbortMultipartUploadAsync(session.StorageKey, session.UploadId);

        session.IsAborted = true;
        await _dbContext.SaveChangesAsync();

        return true;
    }
}