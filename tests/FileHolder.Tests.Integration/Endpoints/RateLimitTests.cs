using System.Net;
using System.Net.Http.Json;
using FileHolder.Api.RateLimiting;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// Runs against the production policies. Each policy has its own limiter, so each test uses up a different one;
/// a second test on the same policy would find it already used up.
/// </summary>
public class RateLimitTests(RealRateLimitsFactory factory) : IClassFixture<RealRateLimitsFactory>
{
    private const string AppOrigin = "http://localhost:5173";

    private readonly HttpClient _client = factory.CreateClient();

    // The body is never read: a request the limiter lets through fails validation with 400 instead.
    private Task<HttpResponseMessage> PostEmptyAsync(string path)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(new { }) };
        request.Headers.Add("Origin", AppOrigin);
        return _client.SendAsync(request);
    }

    private async Task<List<HttpStatusCode>> PostManyAsync(string path, int count)
    {
        var statuses = new List<HttpStatusCode>(count);
        for (int i = 0; i < count; i++)
        {
            statuses.Add((await PostEmptyAsync(path)).StatusCode);
        }

        return statuses;
    }

    [Fact]
    public async Task MultipartPipeline_LetsAWholeLargeBundleThrough_ThenAsksTheBrowserToWait()
    {
        const string path = "/api/v1/files/multipart/presign-batch";

        // 50 multipart files need a presign-batch and a complete each: 100 requests, which the old limit of
        // 100 a minute refused as soon as anything was retried.
        var statuses = await PostManyAsync(path, RateLimitOptions.DefaultMultipartPipelinePermitLimit);
        statuses.Should().NotContain(HttpStatusCode.TooManyRequests);

        var refused = await PostEmptyAsync(path);

        refused.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        var retryAfter = refused.Headers.RetryAfter!.Delta!.Value;
        retryAfter.Should().BeGreaterThan(TimeSpan.Zero).And.BeLessThanOrEqualTo(TimeSpan.FromMinutes(1));

        // Without this, the browser can't read Retry-After on a cross-origin response.
        refused.Headers.GetValues("Access-Control-Expose-Headers")
            .Should().Contain(value => value.Contains("Retry-After", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Confirm_IsRateLimited_LikePresign()
    {
        const string path = "/api/v1/files/confirm";

        var statuses = await PostManyAsync(path, RateLimitOptions.DefaultConfirmPermitLimit);
        statuses.Should().NotContain(HttpStatusCode.TooManyRequests);

        var refused = await PostEmptyAsync(path);

        refused.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        refused.Headers.RetryAfter.Should().NotBeNull();
    }
}
