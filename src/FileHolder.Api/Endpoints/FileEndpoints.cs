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
            .RequireRateLimiting("UploadInitiatePolicy")
            .WithName("GetPresignedUploadUrl");

        var multipart = group.MapGroup("/multipart")
            .WithTags("Multipart Uploads")
            .RequireRateLimiting("MultipartPipelinePolicy");

        multipart.MapPost("/presign-batch", PresignPartBatch)
            .WithName("PresignPartBatch");

        multipart.MapPost("/complete", CompleteMultipartUpload)
            .WithName("CompleteMultipartUpload");

        multipart.MapPost("/abort", AbortMultipartUpload)
            .WithName("AbortMultipartUpload");

        group.MapPost("/confirm", ConfirmUpload)
            .AddEndpointFilter<ValidationFilter<ConfirmUploadRequestDto>>()
            .WithName("ConfirmUpload");

        group.MapGet("/{shareToken}", GetGroupMetadata)
            .WithName("GetGroupMetadata");

        group.MapPost("/{shareToken}/unlock", UnlockGroup)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("UnlockGroup");

        group.MapPost("/{shareToken}/download/{fileId:guid}", GenerateDownloadLink)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("GenerateDownloadLink");
        
        group.MapPost("/{shareToken}/download-all", StreamBundleZip)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("StreamBundleZip");
    }

    public static async Task<Ok<PresignedUrlResponseDto>> GetPresignedUploadUrl(
        CreatePresignedUrlRequestDto dto,
        IStorageService storageService)
    {
        var response = await storageService.CreatePresignedUploadUrlAsync(dto);
        return TypedResults.Ok(response);
    }

    public static async Task<Ok<PresignPartBatchResponseDto>> PresignPartBatch(
        PresignPartBatchRequestDto dto,
        IStorageService storageService)
    {
        var response = await storageService.PresignPartBatchAsync(dto);
        return TypedResults.Ok(response);
    }

    public static async Task<Ok<bool>> CompleteMultipartUpload(
        CompleteMultipartUploadRequestDto dto,
        IStorageService storageService)
    {
        var success = await storageService.CompleteMultipartUploadAsync(dto);
        return TypedResults.Ok(success);
    }

    public static async Task<Ok<bool>> AbortMultipartUpload(
        AbortMultipartUploadRequestDto dto,
        IStorageService storageService)
    {
        var success = await storageService.AbortMultipartUploadAsync(dto);
        return TypedResults.Ok(success);
    }

    public static async Task<Results<Ok<FileGroupMetadataResponseDto>, NotFound, ProblemHttpResult>> GetGroupMetadata(
        string shareToken,
        IStorageService storageService)
    {
        var metadata = await storageService.GetGroupMetadataByTokenAsync(shareToken);
        if (metadata == null)
        {
            return TypedResults.NotFound();
        }

        if (metadata.IsExpired)
        {
            return TypedResults.Problem(
                detail: "This shared file bundle has expired or reached its download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired");
        }

        return TypedResults.Ok(metadata);
    }

    public static async Task<Results<Ok<FileGroupMetadataResponseDto>, NotFound, ProblemHttpResult>> UnlockGroup(
        string shareToken,
        DownloadRequestDto dto,
        IStorageService storageService)
    {
        var result = await storageService.UnlockGroupAsync(shareToken, dto.Password ?? string.Empty);

        if (result.IsPasswordInvalid)
        {
            return TypedResults.Problem(
                detail: "Incorrect password. Please try again.",
                statusCode: StatusCodes.Status401Unauthorized,
                title: "Unauthorized");
        }

        if (result.IsExpired)
        {
            return TypedResults.Problem(
                detail: "This shared file bundle has expired or reached its download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired");
        }

        if (result.Metadata == null)
        {
            return TypedResults.NotFound();
        }

        return TypedResults.Ok(result.Metadata);
    }
    
    public static async Task<Results<Ok<DownloadUrlResponseDto>, UnauthorizedHttpResult, ProblemHttpResult>>
        GenerateDownloadLink(
            string shareToken,
            Guid fileId,
            DownloadRequestDto dto,
            IStorageService storageService)
    {
        var result = await storageService.CreatePresignedDownloadUrlAsync(shareToken, fileId, dto.Password);

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

    public static async
        Task<Results<EmptyHttpResult, NotFound, UnauthorizedHttpResult, ProblemHttpResult, BadRequest<string>>>
        StreamBundleZip(
            string shareToken,
            DownloadRequestDto dto,
            [Microsoft.AspNetCore.Mvc.FromQuery] string? lease,
            HttpContext context,
            IStorageService storageService)
    {
        var result = await storageService.StreamBundleZipAsync(
            shareToken,
            dto.Password, 
            lease, 
            context.Response.Body,
            leaseToken =>
            {
                context.Response.ContentType = "application/zip";
                context.Response.Headers.Append("Content-Disposition", $"attachment; filename=\"bundle_{shareToken}.zip\"");
                context.Response.Headers.Append("X-Content-Type-Options", "nosniff");
                context.Response.Headers.Append("X-Download-Lease", leaseToken);
            },
            context.RequestAborted);
        
        return result.Status switch
        {
            StreamZipStatus.NotFound => TypedResults.NotFound(),
            StreamZipStatus.InvalidPassword => TypedResults.Unauthorized(),
            StreamZipStatus.Expired => TypedResults.Problem(
                detail: "Bundle has expired or reached maximum download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired"),
            StreamZipStatus.CapacityReached => TypedResults.Problem(
                detail: "All download slots are currently in use or exhausted.",
                statusCode: StatusCodes.Status410Gone,
                title: "Download Limit Reached"),
            StreamZipStatus.EmptyBundle => TypedResults.BadRequest("Bundle contains no files to download."),
            StreamZipStatus.Success => TypedResults.Empty,
            _ => TypedResults.Empty
        };
    }
    
    public static async Task<Ok<string>> ConfirmUpload(
        ConfirmUploadRequestDto dto,
        IStorageService storageService)
    {
        var shareToken = await storageService.ConfirmAndPersistFileGroupAsync(dto);
        return TypedResults.Ok(shareToken);       
    }
}