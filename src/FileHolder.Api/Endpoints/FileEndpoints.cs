using FileHolder.Api.RateLimiting;
using FileHolder.Api.ServiceModes;
using FileHolder.Api.Validation;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using FileHolder.Core.Security;
using FileHolder.Infrastructure.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Endpoints;

public static class FileEndpoints
{
    public static void MapFileEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/files")
            .WithTags("Files");

        // A literal segment, so it wins over /{shareToken} (and share tokens are 8 characters, never "limits").
        group.MapGet("/limits", GetUploadLimits)
            .RequireRateLimiting(RateLimitPolicies.Metadata)
            .WithName("GetUploadLimits");

        group.MapPost("/presign", GetPresignedUploadUrl)
            .RequireServiceMode(ServiceCapability.StartUpload)
            .AddEndpointFilter<ValidationFilter<CreatePresignedUrlRequestDto>>()
            .RequireRateLimiting(RateLimitPolicies.UploadInitiate)
            .WithName("GetPresignedUploadUrl");

        var multipart = group.MapGroup("/multipart")
            .WithTags("Multipart Uploads")
            .RequireRateLimiting(RateLimitPolicies.MultipartPipeline);

        multipart.MapPost("/presign-batch", PresignPartBatch)
            .RequireServiceMode(ServiceCapability.ContinueUpload)
            .AddEndpointFilter<ValidationFilter<PresignPartBatchRequestDto>>()
            .WithName("PresignPartBatch");

        multipart.MapPost("/complete", CompleteMultipartUpload)
            .RequireServiceMode(ServiceCapability.ContinueUpload)
            .AddEndpointFilter<ValidationFilter<CompleteMultipartUploadRequestDto>>()
            .WithName("CompleteMultipartUpload");

        // No mode check: aborting only frees storage, which is welcome in any mode.
        multipart.MapPost("/abort", AbortMultipartUpload)
            .AddEndpointFilter<ValidationFilter<AbortMultipartUploadRequestDto>>()
            .WithName("AbortMultipartUpload");

        group.MapPost("/confirm", ConfirmUpload)
            .RequireRateLimiting(RateLimitPolicies.Confirm)
            .RequireServiceMode(ServiceCapability.ContinueUpload)
            .AddEndpointFilter<ValidationFilter<ConfirmUploadRequestDto>>()
            .WithName("ConfirmUpload");

        group.MapGet("/{shareToken}", GetGroupMetadata)
            .RequireRateLimiting(RateLimitPolicies.Metadata)
            .RequireServiceMode(ServiceCapability.ViewBundle)
            .WithName("GetGroupMetadata");

        group.MapPost("/{shareToken}/unlock", UnlockGroup)
            .RequireRateLimiting(RateLimitPolicies.Download)
            .RequireServiceMode(ServiceCapability.ViewBundle)
            .WithName("UnlockGroup");

        group.MapPost("/{shareToken}/downloads", OpenDownloadSession)
            .RequireRateLimiting(RateLimitPolicies.Download)
            .RequireServiceMode(ServiceCapability.StartDownload)
            .WithName("OpenDownloadSession");

        group.MapPost("/{shareToken}/download/{fileId:guid}", GenerateDownloadLink)
            .RequireRateLimiting(RateLimitPolicies.Download)
            .RequireServiceMode(ServiceCapability.ContinueDownload)
            .WithName("GenerateDownloadLink");

        group.MapPost("/{shareToken}/download-all", StreamBundleZip)
            .RequireRateLimiting(RateLimitPolicies.Download)
            // Without a session this ZIP opens one, which counts a download.
            .RequireServiceMode(context => context.Arguments.OfType<DownloadRequestDto>().FirstOrDefault()?.DownloadSessionId is null
                ? ServiceCapability.StartDownload
                : ServiceCapability.ContinueDownload)
            .WithName("StreamBundleZip");

        // The same ZIP for an open download session, as a plain GET the browser can navigate to, so it is
        // saved straight to disk instead of being buffered in page memory first.
        group.MapGet("/{shareToken}/download-all", StreamBundleZipForSession)
            .RequireRateLimiting(RateLimitPolicies.Download)
            .RequireServiceMode(ServiceCapability.ContinueDownload)
            .WithName("StreamBundleZipForSession");
    }

    public static Ok<UploadLimitsResponseDto> GetUploadLimits(IOptions<UploadLimitsOptions> uploadLimits)
    {
        var limits = uploadLimits.Value;
        return TypedResults.Ok(new UploadLimitsResponseDto(
            limits.MaxBundleSizeBytes, BundleRules.MaxFilesPerBundle, BundleLimits.MinExpiryHours, limits.MaxExpiryHours));
    }

    public static async Task<Results<Ok<PresignedUrlResponseDto>, ProblemHttpResult>> GetPresignedUploadUrl(
        CreatePresignedUrlRequestDto dto,
        IFileGroupService fileGroupService,
        StorageQuota storageQuota,
        HttpContext context,
        ILogger<StorageQuota> logger)
    {
        // Validation has already capped each bundle at the size limit, so this sum can't overflow.
        if (!await storageQuota.HasRoomForAsync(dto.Files.Sum(f => f.SizeBytes), context.RequestAborted))
        {
            logger.LogWarning("Refused a presign: the global storage quota is full.");
            // Space comes back as the purge removes expired bundles, so try again after its next run.
            context.Response.Headers.RetryAfter = ((int)PurgeTimings.CheckInterval.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return TypedResults.Problem(
                detail: "FileHolder's storage is full right now, so new uploads are paused. Space frees up as shared files expire; please try again later.",
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Storage Full");
        }

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
        HttpContext context,
        IFileGroupService fileGroupService,
        IDateTimeProvider dateTimeProvider)
    {
        var result = await fileGroupService.UnlockGroupAsync(shareToken, dto.Password ?? string.Empty);

        if (result.IsLockedOut)
        {
            return LockedOutProblem(context, result.LockedUntil, dateTimeProvider);
        }

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
        HttpContext context,
        IDownloadSessionService downloadSessionService,
        IDateTimeProvider dateTimeProvider,
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
            OpenDownloadSessionStatus.LockedOut => LockedOutProblem(context, result.LockedUntil, dateTimeProvider),
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

    public static Task<Results<EmptyHttpResult, NotFound, UnauthorizedHttpResult, ProblemHttpResult, BadRequest<string>>>
        StreamBundleZip(
            string shareToken,
            DownloadRequestDto dto,
            HttpContext context,
            IBundleStreamService bundleStreamService,
            IDateTimeProvider dateTimeProvider) =>
        StreamZipAsync(shareToken, dto.Password, dto.DownloadSessionId, context, bundleStreamService, dateTimeProvider);

    public static Task<Results<EmptyHttpResult, NotFound, UnauthorizedHttpResult, ProblemHttpResult, BadRequest<string>>>
        StreamBundleZipForSession(
            string shareToken,
            Guid downloadSessionId,
            HttpContext context,
            IBundleStreamService bundleStreamService,
            IDateTimeProvider dateTimeProvider) =>
        // Session only, never a password: a password in the URL would end up in logs and browser history.
        StreamZipAsync(shareToken, null, downloadSessionId, context, bundleStreamService, dateTimeProvider);

    private static async
        Task<Results<EmptyHttpResult, NotFound, UnauthorizedHttpResult, ProblemHttpResult, BadRequest<string>>>
        StreamZipAsync(
            string shareToken,
            string? password,
            Guid? downloadSessionId,
            HttpContext context,
            IBundleStreamService bundleStreamService,
            IDateTimeProvider dateTimeProvider)
    {
        var result = await bundleStreamService.StreamBundleZipAsync(
            shareToken,
            password,
            downloadSessionId,
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
                // The title may contain non-ASCII letters, which Kestrel rejects in raw header values.
                context.Response.Headers.ContentDisposition = ContentDispositionUtils.Attachment($"{safeTitle}_{shareToken}.zip");
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
            StreamZipStatus.LockedOut => LockedOutProblem(context, result.LockedUntil, dateTimeProvider),
            StreamZipStatus.Success => TypedResults.Empty,
            _ => TypedResults.Empty
        };
    }

    private static ProblemHttpResult LockedOutProblem(HttpContext context, DateTime? lockedUntil, IDateTimeProvider dateTimeProvider)
    {
        var remaining = (lockedUntil ?? dateTimeProvider.UtcNow) - dateTimeProvider.UtcNow;
        var retryAfterSeconds = Math.Max(1, (int)Math.Ceiling(remaining.TotalSeconds));
        var minutes = (int)Math.Ceiling(retryAfterSeconds / 60.0);

        context.Response.Headers.RetryAfter = retryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);

        return TypedResults.Problem(
            detail: $"Too many incorrect passwords. Try again in {minutes} minute{(minutes == 1 ? "" : "s")}.",
            statusCode: StatusCodes.Status429TooManyRequests,
            title: "Too Many Attempts");
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