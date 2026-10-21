using System.Globalization;
using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace FileHolder.Api.RateLimiting;

/// <summary>
/// The API's rate-limit policies, all fixed one-minute windows per client IP.
/// </summary>
public static class RateLimitPolicies
{
    public const string UploadInitiate = "UploadInitiatePolicy";
    public const string MultipartPipeline = "MultipartPipelinePolicy";
    public const string Confirm = "ConfirmPolicy";
    public const string Download = "DownloadPolicy";
    public const string Metadata = "MetadataPolicy";

    public const int UploadInitiatePermitLimit = 10;

    // A valid bundle needs a presign-batch (50 parts each) and a complete call per multipart file: 50 files
    // take about 100 requests, and a 5 GB bundle at most 7 more batches. This leaves room for re-signing
    // expired or failed part URLs, and the browser waits out a 429's Retry-After instead of failing.
    public const int MultipartPipelinePermitLimit = 300;

    // Each upload confirms once, plus a retry or two. Confirm does the expensive work (copies, size
    // checks, bcrypt), so it is bounded like presign.
    public const int ConfirmPermitLimit = 10;

    public const int DownloadPermitLimit = 30;
    public const int MetadataPermitLimit = 60;

    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);

    public static void Configure(RateLimiterOptions options)
    {
        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        options.OnRejected = WriteRetryAfterAsync;

        AddPerClientPolicy(options, UploadInitiate, UploadInitiatePermitLimit);
        AddPerClientPolicy(options, MultipartPipeline, MultipartPipelinePermitLimit);
        AddPerClientPolicy(options, Confirm, ConfirmPermitLimit);
        AddPerClientPolicy(options, Download, DownloadPermitLimit);

        // Kept apart from the download policy so page loads don't eat into the unlock and download budget,
        // but bounded so share tokens can't be guessed at will.
        AddPerClientPolicy(options, Metadata, MetadataPermitLimit);
    }

    /// <summary>
    /// Tells the client when the window resets, so it can wait instead of failing. The browser can only read
    /// the header because the CORS policy exposes it.
    /// </summary>
    public static ValueTask WriteRetryAfterAsync(OnRejectedContext context, CancellationToken cancellationToken)
    {
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            var seconds = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds));
            context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        }

        return ValueTask.CompletedTask;
    }

    private static void AddPerClientPolicy(RateLimiterOptions options, string policyName, int permitLimit) =>
        options.AddPolicy(policyName, context =>
            RateLimitPartition.GetFixedWindowLimiter(
                partitionKey: ResolveClientIp(context),
                factory: _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = permitLimit,
                    Window = Window
                }));

    // UseForwardedHeaders has already replaced RemoteIpAddress when the request came through a trusted proxy.
    // Never read X-Forwarded-For here: clients can set it to anything and get a fresh rate-limit partition.
    private static string ResolveClientIp(HttpContext context)
    {
        var address = context.Connection.RemoteIpAddress;
        if (address == null)
        {
            return "anonymous";
        }

        if (address.IsIPv4MappedToIPv6)
        {
            return address.MapToIPv4().ToString();
        }

        // One IPv6 host usually owns a whole /64, so partitioning per address would let it rotate through
        // addresses for unlimited attempts. Partition on the /64 prefix instead.
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            Array.Clear(bytes, 8, 8);
            return $"{new IPAddress(bytes)}/64";
        }

        return address.ToString();
    }
}
