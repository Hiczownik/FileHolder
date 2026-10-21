using System.ComponentModel.DataAnnotations;

namespace FileHolder.Api.RateLimiting;

/// <summary>
/// Requests each client address may make per one-minute window, per policy. The defaults are the production limits;
/// only a test stack that sends everything from one address (CI's end-to-end tests) should raise them.
/// </summary>
public class RateLimitOptions
{
    public const string SectionName = "RateLimits";

    public const int DefaultUploadInitiatePermitLimit = 10;

    // A valid bundle needs a presign-batch (50 parts each) and a complete call per multipart file: 50 files
    // take about 100 requests, and a 5 GB bundle at most 7 more batches. This leaves room for re-signing
    // expired or failed part URLs, and the browser waits out a 429's Retry-After instead of failing.
    public const int DefaultMultipartPipelinePermitLimit = 300;

    // Each upload confirms once, plus a retry or two. Confirm does the expensive work (copies, size
    // checks, bcrypt), so it is bounded like presign.
    public const int DefaultConfirmPermitLimit = 10;

    public const int DefaultDownloadPermitLimit = 30;
    public const int DefaultMetadataPermitLimit = 60;

    // High enough for any test stack; a typo can't switch limiting off altogether.
    private const int MaxPermitLimit = 100_000;

    [Range(1, MaxPermitLimit)]
    public int UploadInitiatePermitLimit { get; set; } = DefaultUploadInitiatePermitLimit;

    [Range(1, MaxPermitLimit)]
    public int MultipartPipelinePermitLimit { get; set; } = DefaultMultipartPipelinePermitLimit;

    [Range(1, MaxPermitLimit)]
    public int ConfirmPermitLimit { get; set; } = DefaultConfirmPermitLimit;

    [Range(1, MaxPermitLimit)]
    public int DownloadPermitLimit { get; set; } = DefaultDownloadPermitLimit;

    [Range(1, MaxPermitLimit)]
    public int MetadataPermitLimit { get; set; } = DefaultMetadataPermitLimit;
}
