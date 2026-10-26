using System.Diagnostics.Metrics;
using System.Net;
using System.Net.Http.Headers;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Health;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// Everything the API and the browser do with storage, against each storage service it may run on: Silo always,
/// Cloudflare R2 when a test bucket is configured (<see cref="R2Settings"/>). Signed in as the API is, with a key
/// limited to the bucket, so a call the key may not make, an SDK default the service rejects (checksums, region) or
/// a CORS rule the browser needs shows up here rather than on a deployment.
/// </summary>
public sealed class StorageConformanceTests(StorageTargetsFixture targets, ITestOutputHelper output)
    : IClassFixture<StorageTargetsFixture>, IDisposable
{
    // The page's origin: the local stack's by default, which the R2 test bucket's CORS policy allows (Silo allows any).
    // R2_BROWSER_ORIGIN checks another bucket's policy for its own site, e.g. production's for https://fileholder.app.
    private static readonly string BrowserOrigin =
        Environment.GetEnvironmentVariable("R2_BROWSER_ORIGIN") is { Length: > 0 } origin ? origin : "http://localhost:3000";
    // Storage refuses multipart parts below 5 MiB, except the last.
    private const int MinPartBytes = 5 * 1024 * 1024;

    private readonly HttpClient _http = new();

    public void Dispose() => _http.Dispose();

    private static IOptions<StorageOptions> OptionsFor(StorageTarget target) => Options.Create(new StorageOptions
    {
        ServiceUrl = target.ServiceUrl,
        PublicBaseUrl = target.ServiceUrl,
        AccessKey = "unused: the client is already signed in",
        SecretKey = "unused: the client is already signed in",
        BucketName = target.BucketName
    });

    // The same client signs URLs and calls storage: the test reaches storage at one address, as browsers would.
    private static S3StorageProvider ProviderFor(StorageTarget target) => new(target.ApiClient, target.ApiClient, OptionsFor(target));

    private static string NewKey(StorageTarget target, string name) => $"{target.KeyPrefix}{Guid.NewGuid():N}_{name}";

    private static DateTime InFiveMinutes => DateTime.UtcNow.AddMinutes(5);

    /// <summary>A PUT as the browser sends it (uploadApi.ts): the body, its Content-Type, and the page's Origin.</summary>
    private async Task<HttpResponseMessage> BrowserPutAsync(string url, byte[] body, string contentType)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, url) { Content = new ByteArrayContent(body) };
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        request.Headers.Add("Origin", BrowserOrigin);
        var response = await _http.SendAsync(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return response;
    }

    private void ReportQuery(string what, string url) =>
        output.WriteLine($"{what} query parameters: {string.Join(", ", new Uri(url).Query.TrimStart('?').Split('&').Select(p => p.Split('=')[0]))}");

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task TheHealthCheck_ReachesTheBucket(string name)
    {
        var target = targets[name];

        var result = await new StorageHealthCheck(target.ApiClient, OptionsFor(target)).CheckHealthAsync(new HealthCheckContext());

        result.Status.Should().Be(HealthStatus.Healthy, result.Exception?.Message);
    }

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task ASingleUpload_CanBeChecked_Downloaded_Copied_AndDeleted(string name)
    {
        var target = targets[name];
        var provider = ProviderFor(target);
        var key = NewKey(target, "report.pdf");
        var copyKey = NewKey(target, "report.pdf");
        var body = "a small file"u8.ToArray();

        var uploadUrl = provider.GeneratePresignedUploadUrl(key, body.Length, InFiveMinutes);
        ReportQuery("Presigned upload", uploadUrl);
        await BrowserPutAsync(uploadUrl, body, "application/pdf");
        (await provider.GetObjectSizeAsync(key)).Should().Be(body.Length);

        var download = await _http.GetAsync(provider.GeneratePresignedDownloadUrl(key, "report.pdf", "application/pdf", InFiveMinutes));
        download.StatusCode.Should().Be(HttpStatusCode.OK);
        download.Content.Headers.ContentDisposition!.DispositionType.Should().Be("attachment", "the response header override is honoured");
        (await download.Content.ReadAsByteArrayAsync()).Should().Equal(body);

        await provider.CopyObjectAsync(key, copyKey);
        await using (var stream = await provider.OpenReadStreamAsync(copyKey))
        {
            using var copied = new MemoryStream();
            await stream.CopyToAsync(copied);
            copied.ToArray().Should().Equal(body);
        }

        (await provider.DeleteObjectsAsync([key, copyKey])).Should().BeEmpty();
        (await provider.GetObjectSizeAsync(key)).Should().BeNull();
        (await provider.GetObjectSizeAsync(copyKey)).Should().BeNull();
    }

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task APresignedUpload_RefusesABodyOfAnotherSize(string name)
    {
        var target = targets[name];
        var url = ProviderFor(target).GeneratePresignedUploadUrl(NewKey(target, "sized.bin"), 10, InFiveMinutes);

        var request = new HttpRequestMessage(HttpMethod.Put, url) { Content = new ByteArrayContent(new byte[11]) };
        var response = await _http.SendAsync(request);

        // The signature covers content-length, so nobody can store more than presign approved.
        response.IsSuccessStatusCode.Should().BeFalse();
    }

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task AMultipartUpload_OfTwoParts_CanBeStarted_UploadedAndCompleted(string name)
    {
        var target = targets[name];
        var provider = ProviderFor(target);
        var key = NewKey(target, "video.mp4");
        var first = new byte[MinPartBytes];
        Random.Shared.NextBytes(first);
        var last = "the last part may be small"u8.ToArray();

        var uploadId = await provider.InitiateMultipartUploadAsync(key, "video/mp4");
        var firstUrl = provider.GeneratePresignedPartUploadUrl(key, uploadId, 1, first.Length, InFiveMinutes);
        ReportQuery("Presigned part", firstUrl);
        var firstPart = await BrowserPutAsync(firstUrl, first, "application/octet-stream");
        var lastPart = await BrowserPutAsync(provider.GeneratePresignedPartUploadUrl(key, uploadId, 2, last.Length, InFiveMinutes), last, "application/octet-stream");

        // The browser reads each part's ETag, so the response must expose it to the page (CORS).
        foreach (var part in new[] { firstPart, lastPart })
        {
            part.Headers.ETag.Should().NotBeNull();
            ExposedHeaders(part).Should().Contain(h => h == "*" || h.Equals("ETag", StringComparison.OrdinalIgnoreCase));
        }

        await provider.CompleteMultipartUploadAsync(key, uploadId, [(1, firstPart.Headers.ETag!.Tag), (2, lastPart.Headers.ETag!.Tag)]);

        (await provider.GetObjectSizeAsync(key)).Should().Be(first.Length + last.Length);
        (await provider.DeleteObjectsAsync([key])).Should().BeEmpty();
    }

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task AMultipartUpload_CanBeAborted(string name)
    {
        var target = targets[name];
        var provider = ProviderFor(target);
        var key = NewKey(target, "abandoned.zip");
        var uploadId = await provider.InitiateMultipartUploadAsync(key, "application/zip");

        await provider.AbortMultipartUploadAsync(key, uploadId);

        // The provider ignores storage errors on abort (the upload may already be finished), so check with storage that
        // the upload is gone: a part for it is refused. (The API's key may not list uploads, and needn't.)
        var part = new HttpRequestMessage(HttpMethod.Put, provider.GeneratePresignedPartUploadUrl(key, uploadId, 1, 4, InFiveMinutes))
        {
            Content = new ByteArrayContent("late"u8.ToArray())
        };
        (await _http.SendAsync(part)).StatusCode.Should().Be(HttpStatusCode.NotFound, "storage answers NoSuchUpload");
    }

    /// <summary>
    /// Where the API applies the safety net's rule itself, its key can put it and read it back. Where the rule is
    /// managed outside the app, the key is limited to objects: storage refuses it the bucket's settings (the rule,
    /// and CORS), so a leaked key can't reconfigure the bucket. If this fails there, the API was given too much.
    /// </summary>
    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task TheApisKey_ManagesTheBucketsSettings_OnlyWhereTheApiAppliesTheRule(string name)
    {
        var target = targets[name];
        var status = new StorageLifecycleStatus(new ServiceCollection().AddMetrics().BuildServiceProvider().GetRequiredService<IMeterFactory>());
        using var initializer = new StorageLifecycleInitializer(target.ApiClient, OptionsFor(target), status, NullLogger<StorageLifecycleInitializer>.Instance);

        if (target.LifecycleRule == LifecycleRuleMode.Apply)
        {
            var applied = await initializer.ApplyAsync();

            output.WriteLine($"{name} kept the rule with expiry {applied.ExpiryDays} days, abort-incomplete {applied.AbortIncompleteUploadDays?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "dropped"}.");
            applied.ExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
            return;
        }

        var putRule = () => initializer.ApplyAsync();
        var readRule = () => target.ApiClient.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = target.BucketName });
        var changeCors = () => target.ApiClient.PutCORSConfigurationAsync(new PutCORSConfigurationRequest
        {
            BucketName = target.BucketName,
            Configuration = new CORSConfiguration { Rules = [new CORSRule { AllowedOrigins = ["*"], AllowedMethods = ["GET"] }] }
        });

        (await putRule.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await readRule.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await changeCors.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Theory]
    [MemberData(nameof(StorageTargetsFixture.Names), MemberType = typeof(StorageTargetsFixture))]
    public async Task TheBrowsersPreflights_ForUploadsAndRangedDownloads_AreAllowed(string name)
    {
        var target = targets[name];
        var provider = ProviderFor(target);
        var key = NewKey(target, "preflight.bin");

        var put = await PreflightAsync(provider.GeneratePresignedUploadUrl(key, 10, InFiveMinutes), "PUT", "content-type");
        var get = await PreflightAsync(provider.GeneratePresignedDownloadUrl(key, "preflight.bin", "application/octet-stream", InFiveMinutes), "GET", "range,if-range");

        foreach (var (method, response) in new[] { ("PUT", put), ("GET", get) })
        {
            response.IsSuccessStatusCode.Should().BeTrue($"the {method} preflight is answered: {response.StatusCode}");
            response.Headers.GetValues("Access-Control-Allow-Origin").Should().ContainSingle()
                .Which.Should().BeOneOf(BrowserOrigin, "*");
        }
    }

    private async Task<HttpResponseMessage> PreflightAsync(string url, string method, string headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Options, url);
        request.Headers.Add("Origin", BrowserOrigin);
        request.Headers.Add("Access-Control-Request-Method", method);
        request.Headers.Add("Access-Control-Request-Headers", headers);
        return await _http.SendAsync(request);
    }

    private static IEnumerable<string> ExposedHeaders(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Access-Control-Expose-Headers", out var values)
            ? values.SelectMany(v => v.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            : [];
}
