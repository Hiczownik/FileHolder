using FileHolder.Api.Validation;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileHolder.Api.Endpoints;

public static class FileEndpoints
{
    public static void MapFileEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/files")
            .WithTags("Files");

        group.MapPost("/presign", GetPresignedUploadUrl)
            .AddEndpointFilter<ValidationFilter<CreatePresignedUrlRequestDto>>()
            .RequireRateLimiting("UploadPolicy")
            .WithName("GetPresignedUploadUrl");

        group.MapPost("/confirm", ConfirmUpload)
            .AddEndpointFilter<ValidationFilter<ConfirmUploadRequestDto>>()
            .WithName("ConfirmUpload");
        
        group.MapGet("/{shareToken}", GetFileMetadata)
            .WithName("GetFileMetadata");

        group.MapPost("/{shareToken}/download", GenerateDownloadLink)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("GenerateDownloadLink");
    }

    public static async Task<Ok<PresignedUrlResponseDto>> GetPresignedUploadUrl(
        CreatePresignedUrlRequestDto dto,
        IStorageService storageService)
    {
        var response = await storageService.CreatePresignedUploadUrlAsync(dto);
        return TypedResults.Ok(response);
    }

    public static async Task<Results<Ok<FileMetadataResponseDto>, NotFound, ProblemHttpResult>> GetFileMetadata(
        string shareToken,
        IStorageService storageService)
    {
        var metadata = await storageService.GetMetadataByTokenAsync(shareToken);
        if (metadata == null)
        {
            return TypedResults.NotFound();
        }

        if (metadata.IsExpired)
        {
            return TypedResults.Problem(
                detail: "This shared file link has expired or reached its download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired");
        }

        return TypedResults.Ok(metadata);
    }

    public static async Task<Results<Ok<DownloadUrlResponseDto>, UnauthorizedHttpResult, ProblemHttpResult>>
        GenerateDownloadLink(
            string shareToken,
            DownloadRequestDto dto,
            IStorageService storageService)
    {
        var result = await storageService.CreatePresignedDownloadUrlAsync(shareToken, dto.Password);

        if (result.IsPasswordInvalid)
        {
            return TypedResults.Unauthorized();
        }

        if (result.IsExpired)
        {
            return TypedResults.Problem(
                detail: "Link has expired or reached maximum download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired");
        }

        return TypedResults.Ok(new DownloadUrlResponseDto(result.DownloadUrl!));
    }

    public static async Task<Ok<string>> ConfirmUpload(
        ConfirmUploadRequestDto dto,
        IStorageService storageService)
    {
        var shareToken = await storageService.ConfirmAndPersistFileAsync(dto);
        return TypedResults.Ok(shareToken);       
    }
}