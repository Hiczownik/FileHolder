using System.Globalization;
using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

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

    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Registers the rate limiter with the limits from the "RateLimits" section (<see cref="RateLimitOptions"/>),
    /// which default to the production limits. Invalid limits stop the API from starting.
    /// </summary>
    public static IServiceCollection AddFileHolderRateLimits(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<RateLimitOptions>()
            .Bind(configuration.GetSection(RateLimitOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddRateLimiter(_ => { });
        services.AddOptions<RateLimiterOptions>()
            .Configure<IOptions<RateLimitOptions>>((options, limits) => Configure(options, limits.Value));
        return services;
    }

    public static void Configure(RateLimiterOptions options, RateLimitOptions limits)
    {
        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        options.OnRejected = WriteRetryAfterAsync;

        AddPerClientPolicy(options, UploadInitiate, limits.UploadInitiatePermitLimit);
        AddPerClientPolicy(options, MultipartPipeline, limits.MultipartPipelinePermitLimit);
        AddPerClientPolicy(options, Confirm, limits.ConfirmPermitLimit);
        AddPerClientPolicy(options, Download, limits.DownloadPermitLimit);

        // Kept apart from the download policy so page loads don't eat into the unlock and download budget,
        // but bounded so share tokens can't be guessed at will.
        AddPerClientPolicy(options, Metadata, limits.MetadataPermitLimit);
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
