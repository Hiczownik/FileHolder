using System.Diagnostics;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Telemetry;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.Options;
using OpenTelemetry;
using OpenTelemetry.Trace;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// The AWS SDK sends its requests through HttpClient, so the API's storage calls show up as HttpClient spans, with
/// the object key in the URL. Checked against real storage, since the endpoint tests mock the SDK away.
/// </summary>
public sealed class StorageTracingTests(SiloFixture silo) : IClassFixture<SiloFixture>, IDisposable
{
    private const string FileName = "tracing_holiday_photo.jpg";

    private readonly ActivitySource _source = new("FileHolder.Tests.Integration.StorageTracing");
    private readonly List<Activity> _spans = [];
    private TracerProvider? _tracerProvider;

    public void Dispose()
    {
        _tracerProvider?.Dispose();
        _source.Dispose();
    }

    [Fact]
    public async Task StorageCalls_AreTraced_WithTheKeysGuidButNoFileNameOrSignature()
    {
        // The same instrumentation, sampler and redaction as the API (TracingRegistration).
        _tracerProvider = Sdk.CreateTracerProviderBuilder()
            .SetSampler(new ParentBasedSampler(new RequestRootSampler(1.0)))
            .AddSource(_source.Name)
            .AddHttpClientInstrumentation()
            .AddProcessor(new TraceRedactionProcessor(Options.Create(new TracingOptions())))
            .AddInMemoryExporter(_spans)
            .Build();

        var guid = Guid.NewGuid().ToString("N");
        var key = $"uploads/{guid}_{FileName}";
        ActivityTraceId traceId;

        using (var parent = _source.StartActivity("upload and download"))
        {
            traceId = parent!.TraceId;
            await silo.Client.PutObjectAsync(new PutObjectRequest
            {
                BucketName = SiloFixture.BucketName, Key = key, ContentBody = "photo"
            });
            await silo.Client.GetObjectMetadataAsync(SiloFixture.BucketName, key);

            // A presigned URL fetched over HttpClient: its signature is in the query string.
            var url = await silo.Client.GetPreSignedURLAsync(new GetPreSignedUrlRequest
            {
                BucketName = SiloFixture.BucketName, Key = key, Expires = DateTime.UtcNow.AddMinutes(5),
                Protocol = Protocol.HTTP
            });
            using var http = new HttpClient();
            (await http.GetAsync(url)).EnsureSuccessStatusCode();
        }

        _tracerProvider.ForceFlush();
        var storageSpans = _spans.Where(s => s.TraceId == traceId && s.Kind == ActivityKind.Client).ToList();

        storageSpans.Should().HaveCountGreaterThanOrEqualTo(3, "each storage request is an HttpClient span");
        storageSpans.Select(s => s.GetTagItem("url.full") as string).Should()
            .OnlyContain(u => u!.EndsWith($"/uploads/{guid}_[name]"));
        foreach (var span in storageSpans)
        {
            foreach (var tag in span.TagObjects)
            {
                var value = Convert.ToString(tag.Value, System.Globalization.CultureInfo.InvariantCulture) ?? "";
                value.Should().NotContainEquivalentOf("holiday").And.NotContainEquivalentOf("X-Amz-Signature");
            }
        }
    }
}
