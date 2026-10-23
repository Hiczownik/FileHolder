using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// What a trace of a whole upload and download contains, read from the exporter's side. Share tokens, passwords,
/// kAuth, key material, file names and titles must never be in it.
/// Every request carries this test's own traceparent, and only that trace is read: the exporter also sees requests
/// to the other test classes' API instances running alongside.
/// </summary>
public class TracingTests : IClassFixture<TracingFactory>
{
    private const string FileName = "tracing_secret_report.pdf";
    private const string Title = "Tracing Secret Title";
    private const string Password = "TracingPassword123!";
    private const string WrongPassword = "WrongTracingGuess!";

    private const string EncryptedFileName = "tracing_secret_blob.enc";
    private const string KAuth = "k_auth_tracing_secret_456";
    private const string KeyEnvelope = "tracing_secret_key_envelope";
    private const string Manifest = "tracing_secret_manifest";

    private readonly TracingFactory _factory;
    private readonly ActivityTraceId _traceId = ActivityTraceId.CreateRandom();
    private readonly HttpClient _client;
    private int _requests;

    public TracingTests(TracingFactory factory)
    {
        _factory = factory;
        _client = factory.CreateDefaultClient(new TraceParentHandler(_traceId));
    }

    /// <summary>Sends every request as part of one trace, as a browser propagating its own would.</summary>
    private sealed class TraceParentHandler(ActivityTraceId traceId) : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            request.Headers.Add("traceparent", $"00-{traceId}-{ActivitySpanId.CreateRandom()}-01");
            return base.SendAsync(request, cancellationToken);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(Func<HttpClient, Task<HttpResponseMessage>> request)
    {
        _requests++;
        return await request(_client);
    }

    private async Task<(string ShareToken, Guid FileId, string UploadToken)> UploadPlainBundleAsync()
    {
        var files = new List<FileItemInputDto> { new(FileName, "application/pdf", 1024) };
        var presign = await (await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/presign",
                new CreatePresignedUrlRequestDto(Title, files, 24, 10, Password))))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        _factory.SeedS3Object(presign!.Items[0].StorageKey, 1024);

        var confirm = await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, Title,
            [new ConfirmedFileItemDto(presign.Items[0].StorageKey, FileName, "application/pdf", 1024)],
            24, 10, Password)));
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = (await confirm.Content.ReadFromJsonAsync<string>())!;

        (await SendAsync(c => c.GetAsync($"/api/v1/files/{shareToken}"))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/unlock", new DownloadRequestDto(WrongPassword))))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var unlocked = await (await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/unlock", new DownloadRequestDto(Password))))
            .Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();

        return (shareToken, unlocked!.Files[0].Id, presign.UploadToken);
    }

    private async Task DownloadAsync(string shareToken, Guid fileId, string? password)
    {
        var session = await (await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/downloads", new DownloadRequestDto(password))))
            .Content.ReadFromJsonAsync<DownloadSessionResponseDto>();
        var sessionId = session!.DownloadSessionId;

        (await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/download/{fileId}", new DownloadRequestDto(null, sessionId))))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await SendAsync(c => c.GetAsync($"/api/v1/files/{shareToken}/download-all?downloadSessionId={sessionId}")))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task<string> UploadEncryptedBundleAsync()
    {
        var files = new List<FileItemInputDto> { new(EncryptedFileName, "application/octet-stream", 1024) };
        var presign = await (await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/presign",
                new CreatePresignedUrlRequestDto(null, files, 24, 10, KAuth, IsEncrypted: true))))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        _factory.SeedS3Object(presign!.Items[0].StorageKey, 1024);

        var confirm = await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, null,
            [new ConfirmedFileItemDto(presign.Items[0].StorageKey, EncryptedFileName, "application/octet-stream", 1024)],
            24, 10, KAuth, IsEncrypted: true)
        {
            EncryptedManifest = Manifest,
            KeyEnvelope = KeyEnvelope,
            KeySalt = "salt_base64",
            KeyMode = KeyMode.LinkKeyAndPasskey,
            KdfParams = KeyDerivationParams.Format(65536, 3, 1)
        }));
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = (await confirm.Content.ReadFromJsonAsync<string>())!;

        (await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/unlock", new DownloadRequestDto(KAuth))))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        return shareToken;
    }

    /// <summary>Everything about a span an exporter sends: its names, status, tags, events and links.</summary>
    private static string Render(Activity span)
    {
        var text = new StringBuilder()
            .AppendLine(span.DisplayName).AppendLine(span.OperationName).AppendLine(span.StatusDescription);
        foreach (var tag in span.TagObjects)
        {
            text.Append(tag.Key).Append('=').AppendLine(Convert.ToString(tag.Value, System.Globalization.CultureInfo.InvariantCulture));
        }

        foreach (var spanEvent in span.Events)
        {
            text.AppendLine(spanEvent.Name);
            foreach (var tag in spanEvent.Tags)
            {
                text.Append(tag.Key).Append('=').AppendLine(Convert.ToString(tag.Value, System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        foreach (var baggage in span.Baggage)
        {
            text.Append(baggage.Key).Append('=').AppendLine(baggage.Value);
        }

        return text.ToString();
    }

    [Fact]
    public async Task AWholeUploadAndDownload_IsTraced_WithoutTokensPasswordsKeysOrFileNames()
    {
        var (shareToken, fileId, uploadToken) = await UploadPlainBundleAsync();
        await DownloadAsync(shareToken, fileId, Password);
        var encryptedShareToken = await UploadEncryptedBundleAsync();

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        var exported = string.Join("\n---\n", spans.Select(Render));

        string[] secrets =
        [
            shareToken, encryptedShareToken, uploadToken, Password, WrongPassword, KAuth, KeyEnvelope, Manifest,
            FileName, EncryptedFileName, Title, "tracing_secret", "X-Amz-Signature", "downloadSessionId"
        ];
        foreach (var secret in secrets)
        {
            exported.Should().NotContainEquivalentOf(secret);
        }

        spans.Should().NotContain(s => s.GetTagItem("client.address") != null, "client addresses are off by default");
        spans.Where(s => s.Kind == ActivityKind.Server).Should().HaveCount(_requests)
            .And.OnlyContain(s => (s.GetTagItem("url.path") as string)!.StartsWith("/api/v1/files/"));
        spans.Select(s => s.GetTagItem("url.path")).Should().Contain("/api/v1/files/{shareToken}/unlock");
    }

    [Fact]
    public async Task Confirm_IncludesItsDatabaseQueries()
    {
        await UploadPlainBundleAsync();

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        var confirm = spans.Single(s => s.Kind == ActivityKind.Server && s.GetTagItem("http.route") as string == "/api/v1/files/confirm");
        var queries = spans.Where(s => s.ParentSpanId == confirm.SpanId && s.Source.Name == "Npgsql").ToList();

        queries.Should().NotBeEmpty();
        queries.Should().OnlyContain(q => q.Kind == ActivityKind.Client);
    }

    [Fact]
    public async Task HealthEndpoints_AreNotTraced()
    {
        (await _client.GetAsync("/healthz/live")).StatusCode.Should().Be(HttpStatusCode.OK);
        await _client.GetAsync("/healthz/ready");
        (await SendAsync(c => c.GetAsync("/api/v1/files/no-such-bundle"))).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // The 404 is traced, and was requested last, so the health checks' spans would already be here.
        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        spans.Where(s => s.Kind == ActivityKind.Server).Should().ContainSingle()
            .Which.GetTagItem("http.route").Should().Be("/api/v1/files/{shareToken}");
    }
}
