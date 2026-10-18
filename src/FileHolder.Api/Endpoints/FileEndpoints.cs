using FileHolder.Api.Validation;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;

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
            .AddEndpointFilter<ValidationFilter<PresignPartBatchRequestDto>>()
            .WithName("PresignPartBatch");

        multipart.MapPost("/complete", CompleteMultipartUpload)
            .AddEndpointFilter<ValidationFilter<CompleteMultipartUploadRequestDto>>()
            .WithName("CompleteMultipartUpload");

        multipart.MapPost("/abort", AbortMultipartUpload)
            .AddEndpointFilter<ValidationFilter<AbortMultipartUploadRequestDto>>()
            .WithName("AbortMultipartUpload");

        group.MapPost("/confirm", ConfirmUpload)
            .AddEndpointFilter<ValidationFilter<ConfirmUploadRequestDto>>()
            .WithName("ConfirmUpload");

        group.MapGet("/{shareToken}", GetGroupMetadata)
            .WithName("GetGroupMetadata");

        group.MapPost("/{shareToken}/unlock", UnlockGroup)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("UnlockGroup");

        group.MapPost("/{shareToken}/downloads", OpenDownloadSession)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("OpenDownloadSession");

        group.MapPost("/{shareToken}/download/{fileId:guid}", GenerateDownloadLink)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("GenerateDownloadLink");

        group.MapPost("/{shareToken}/download-all", StreamBundleZip)
            .RequireRateLimiting("DownloadPolicy")
            .WithName("StreamBundleZip");
    }

    public static async Task<Ok<PresignedUrlResponseDto>> GetPresignedUploadUrl(
        CreatePresignedUrlRequestDto dto,
        IFileGroupService fileGroupService)
    {
        var response = await fileGroupService.CreatePresignedUploadUrlAsync(dto);
        return TypedResults.Ok(response);
    }

    public static async Task<Ok<PresignPartBatchResponseDto>> PresignPartBatch(
        PresignPartBatchRequestDto dto,
        IMultipartUploadService multipartService)
    {
        var response = await multipartService.PresignPartBatchAsync(dto);
        return TypedResults.Ok(response);
    }

    public static async Task<Ok<bool>> CompleteMultipartUpload(
        CompleteMultipartUploadRequestDto dto,
        IMultipartUploadService multipartService)
    {
        var success = await multipartService.CompleteMultipartUploadAsync(dto);
        return TypedResults.Ok(success);
    }

    public static async Task<Ok<bool>> AbortMultipartUpload(
        AbortMultipartUploadRequestDto dto,
        IMultipartUploadService multipartService)
    {
        var success = await multipartService.AbortMultipartUploadAsync(dto);
        return TypedResults.Ok(success);
    }

    public static async Task<Results<Ok<FileGroupMetadataResponseDto>, NotFound, ProblemHttpResult>> GetGroupMetadata(
        string shareToken,
        IFileGroupService fileGroupService)
    {
        var metadata = await fileGroupService.GetGroupMetadataByTokenAsync(shareToken);
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
        IFileGroupService fileGroupService)
    {
        var result = await fileGroupService.UnlockGroupAsync(shareToken, dto.Password ?? string.Empty);

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

    public static async Task<Results<Ok<DownloadSessionResponseDto>, NotFound, ProblemHttpResult>> OpenDownloadSession(
        string shareToken,
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] DownloadRequestDto? dto,
        IDownloadSessionService downloadSessionService,
        CancellationToken ct)
    {
        var result = await downloadSessionService.OpenSessionAsync(shareToken, dto?.Password, ct);

        return result.Status switch
        {
            OpenDownloadSessionStatus.Success => TypedResults.Ok(result.Session!),
            OpenDownloadSessionStatus.InvalidPassword => TypedResults.Problem(
                detail: "Incorrect password. Please try again.",
                statusCode: StatusCodes.Status401Unauthorized,
                title: "Unauthorized"),
            OpenDownloadSessionStatus.Expired => TypedResults.Problem(
                detail: "This shared file bundle has expired or reached its download limit.",
                statusCode: StatusCodes.Status410Gone,
                title: "Link Expired"),
            _ => TypedResults.NotFound()
        };
    }

    public static async Task<Results<Ok<DownloadUrlResponseDto>, NotFound, ProblemHttpResult>>
        GenerateDownloadLink(
            string shareToken,
            Guid fileId,
            [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] DownloadRequestDto? dto,
            IFileGroupService fileGroupService)
    {
        var result = await fileGroupService.CreatePresignedDownloadUrlAsync(shareToken, fileId, dto?.DownloadSessionId);

        return result.Status switch
        {
            DownloadUrlStatus.Success => TypedResults.Ok(new DownloadUrlResponseDto(result.DownloadUrl!)),
            DownloadUrlStatus.SessionInvalid => SessionInvalidProblem(),
            _ => TypedResults.NotFound()
        };
    }

    public static async
        Task<Results<EmptyHttpResult, NotFound, UnauthorizedHttpResult, ProblemHttpResult, BadRequest<string>>>
        StreamBundleZip(
            string shareToken,
            DownloadRequestDto dto,
            HttpContext context,
            IBundleStreamService bundleStreamService)
    {
        var result = await bundleStreamService.StreamBundleZipAsync(
            shareToken,
            dto.Password,
            dto.DownloadSessionId,
            context.Response.Body,
            bundleTitle =>
            {
                var safeTitle = !string.IsNullOrWhiteSpace(bundleTitle)
                    ? System.Text.RegularExpressions.Regex.Replace(
                        bundleTitle,
                        @"[^\w.-]",
                        "_",
                        System.Text.RegularExpressions.RegexOptions.None,
                        TimeSpan.FromSeconds(1))
                    : "bundle";

                context.Response.ContentType = "application/zip";
                context.Response.Headers.Append("Content-Disposition", $"attachment; filename=\"{safeTitle}_{shareToken}.zip\"");
                context.Response.Headers.Append("X-Content-Type-Options", "nosniff");
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
            StreamZipStatus.SessionInvalid => SessionInvalidProblem(),
            StreamZipStatus.EmptyBundle => TypedResults.BadRequest("Bundle contains no files to download."),
            StreamZipStatus.Success => TypedResults.Empty,
            _ => TypedResults.Empty
        };
    }

    private static ProblemHttpResult SessionInvalidProblem() => TypedResults.Problem(
        detail: "The download session is missing or has expired. Start a new download.",
        statusCode: StatusCodes.Status401Unauthorized,
        title: "Download Session Invalid");

    public static async Task<Ok<string>> ConfirmUpload(
        ConfirmUploadRequestDto dto,
        IFileGroupService fileGroupService)
    {
        var shareToken = await fileGroupService.ConfirmAndPersistFileGroupAsync(dto);
        return TypedResults.Ok(shareToken);
    }
}