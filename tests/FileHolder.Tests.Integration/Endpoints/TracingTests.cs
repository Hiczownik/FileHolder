using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Diagnostics;
using FileHolder.Infrastructure.Services;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// What a trace of a whole upload and download contains, read from the exporter's side. Share tokens, passwords,
/// kAuth, key material, file names and titles must never be in it.
/// Every request carries this test's own traceparent, and only that trace is read: the exporter also sees requests
/// to the other test classes' API instances running alongside.
/// </summary>
[Collection(TracingCollectionDefinition.Name)]
public class TracingTests : IClassFixture<TracingFactory>
{
    private const string FileName = "tracing_secret_report.pdf";
    private const string Title = "Tracing Secret Title";
    private const string Password = "TracingPassword123!";
    private const string WrongPassword = "WrongTracingGuess!";

    private const string EncryptedFileName = "tracing_secret_blob.enc";
    // A kAuth is 32 bytes as 43 base64url characters.
    private const string KAuth = "kAuth_tracing_secret_456_0123456789abcdefgh";
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

    /// <param name="fileCount">Files after the first are named like it, so the leak checks cover them too.</param>
    private async Task<(string ShareToken, Guid FileId, string UploadToken)> UploadPlainBundleAsync(int fileCount = 1)
    {
        var files = Enumerable.Range(0, fileCount)
            .Select(i => new FileItemInputDto(i == 0 ? FileName : $"{i}_{FileName}", "application/pdf", 1024))
            .ToList();
        var presign = await (await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/presign",
                new CreatePresignedUrlRequestDto(Title, files, 24, 10, Password))))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        foreach (var item in presign!.Items)
        {
            _factory.SeedS3Object(item.StorageKey, 1024);
        }

        var confirm = await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, Title,
            presign.Items.Select((item, i) => new ConfirmedFileItemDto(item.StorageKey, files[i].FileName, "application/pdf", 1024)).ToList(),
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

    private static Activity Request(Activity[] spans, string route) =>
        spans.Single(s => s.Kind == ActivityKind.Server && s.GetTagItem("http.route") as string == route);

    private static Activity[] Children(Activity[] spans, Activity parent, string? name = null) =>
        spans.Where(s => s.ParentSpanId == parent.SpanId && (name == null || s.OperationName == name))
            .OrderBy(s => s.StartTimeUtc)
            .ToArray();

    [Fact]
    public async Task Confirm_IsBrokenIntoItsSteps_InOrder()
    {
        await UploadPlainBundleAsync(fileCount: 3);

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        var confirm = Request(spans, "/api/v1/files/confirm");

        Children(spans, confirm).Where(s => s.Source.Name == "FileHolder").Select(s => s.OperationName).Should().Equal(
            "confirm.claim", "confirm.check_sizes", "confirm.hash_password",
            "confirm.copy_single_part_files", "confirm.persist", "confirm.cache_write");
        Children(spans, confirm).Should().Contain(s => s.Source.Name == "Npgsql", "loading the pending uploads is a query");

        var checkSizes = Children(spans, confirm, "confirm.check_sizes").Single();
        checkSizes.GetTagItem("fileholder.file_count").Should().Be(3);
        Children(spans, checkSizes, "storage.get_object_size").Should().HaveCount(3)
            .And.OnlyContain(s => (bool)s.GetTagItem("fileholder.storage.found")!)
            .And.OnlyContain(s => ((string)s.GetTagItem("fileholder.storage.key")!).EndsWith("_[name]"));

        // Small files are copied, and each copy's size is checked again.
        var copies = Children(spans, confirm, "confirm.copy_single_part_files").Single();
        copies.GetTagItem("fileholder.copied_file_count").Should().Be(3);
        Children(spans, copies, "storage.copy_object").Should().HaveCount(3)
            .And.OnlyContain(s => ((string)s.GetTagItem("fileholder.storage.destination_key")!).StartsWith("files/"));
        Children(spans, copies, "storage.get_object_size").Should().HaveCount(3);

        Children(spans, confirm, "confirm.hash_password").Single()
            .GetTagItem("fileholder.password_kind").Should().Be("password");
        Children(spans, confirm, "confirm.persist").Single().Status.Should().Be(ActivityStatusCode.Unset);
    }

    [Fact]
    public async Task ARefusedConfirm_MarksTheFailingStep_WithTheExceptionTypeOnly()
    {
        var files = new List<FileItemInputDto> { new(FileName, "application/pdf", 1024) };
        var presign = await (await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/presign",
                new CreatePresignedUrlRequestDto(Title, files, 24, 10, Password))))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        // Stored at a different size than presign approved.
        _factory.SeedS3Object(presign!.Items[0].StorageKey, 999);

        (await SendAsync(c => c.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, Title,
            [new ConfirmedFileItemDto(presign.Items[0].StorageKey, FileName, "application/pdf", 1024)],
            24, 10, Password)))).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        var checkSizes = Children(spans, Request(spans, "/api/v1/files/confirm"), "confirm.check_sizes").Single();

        checkSizes.Status.Should().Be(ActivityStatusCode.Error);
        checkSizes.StatusDescription.Should().BeNull("an exception message can name a file");
        checkSizes.GetTagItem("error.type").Should().Be("FileHolder.Core.Exceptions.InvalidRequestException");
        checkSizes.Events.Should().BeEmpty();
    }

    [Fact]
    public async Task PasswordChecks_RecordTheLockoutDecision_NotTheAttempt()
    {
        var (shareToken, _, _) = await UploadPlainBundleAsync();

        // The upload's own unlock attempts (one wrong, one right) reset the count, so these start from zero.
        for (var i = 0; i < PasswordLockout.FreeAttempts + 2; i++)
        {
            await SendAsync(c => c.PostAsJsonAsync($"/api/v1/files/{shareToken}/unlock", new DownloadRequestDto(WrongPassword)));
        }

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);
        var decisions = spans
            .Where(s => s.OperationName == "password.check")
            .OrderBy(s => s.StartTimeUtc)
            .Select(s => s.GetTagItem("fileholder.password.decision") as string)
            .ToList();

        decisions.Should().Equal(
            [
                PasswordAttemptGuard.Decisions.FreeAttemptUsed, PasswordAttemptGuard.Decisions.Correct,
                .. Enumerable.Repeat(PasswordAttemptGuard.Decisions.FreeAttemptUsed, PasswordLockout.FreeAttempts),
                PasswordAttemptGuard.Decisions.LockoutApplied, PasswordAttemptGuard.Decisions.RefusedLockedOut
            ]);
        spans.Where(s => s.OperationName == "password.check")
            .Count(s => Children(spans, s, "password.verify").Length == 1)
            .Should().Be(PasswordLockout.FreeAttempts + 3, "a locked-out guess is refused before bcrypt runs");
    }

    [Fact]
    public async Task ADownload_RecordsItsSessionAndEachZipEntry_ByIndex()
    {
        var (shareToken, fileId, _) = await UploadPlainBundleAsync(fileCount: 2);
        await DownloadAsync(shareToken, fileId, Password);

        var spans = await _factory.WaitForRequestSpansAsync(_traceId, _requests);

        var open = Children(spans, Request(spans, "/api/v1/files/{shareToken}/downloads"), "download_session.open").Single();
        open.GetTagItem("fileholder.outcome").Should().Be("Success");
        Children(spans, open, "password.check").Should().ContainSingle();
        Children(spans, open, "download_session.consume_download").Single()
            .GetTagItem("fileholder.download_consumed").Should().Be(true);

        var zip = Children(spans, Request(spans, "/api/v1/files/{shareToken}/download-all"), "bundle_zip.stream").Single();
        zip.GetTagItem("fileholder.file_count").Should().Be(2);
        var entries = Children(spans, zip, "bundle_zip.entry");
        entries.Select(e => e.GetTagItem("fileholder.zip.entry_index")).Should().Equal(0, 1);
        entries.Should().OnlyContain(e => Children(spans, e, "storage.open_read_stream").Length == 1);
    }

    [Fact]
    public async Task APurgeRun_IsATraceOfItsOwn_WithItsSteps()
    {
        var storageKey = $"uploads/{Guid.NewGuid():N}_tracing_secret_purged.pdf";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.FileGroups.Add(new FileGroup
            {
                ShareToken = "trace_" + Guid.NewGuid().ToString("N")[..8],
                Title = Title,
                ExpiresAt = DateTime.UtcNow.AddHours(-2),
                Files = [new SharedFile { OriginalFileName = FileName, StorageKey = storageKey, ContentType = "application/pdf", SizeBytes = 1024 }]
            });
            await db.SaveChangesAsync();
        }

        ActivityTraceId runTraceId;
        using (var scope = _factory.Services.CreateScope())
        {
            // What FileCleanupWorker does each run.
            using var run = FileHolderTracing.StartRoot("purge.run");
            runTraceId = run!.TraceId;
            await scope.ServiceProvider.GetRequiredService<IStoragePurgeService>().PurgeExpiredFilesAsync();
        }

        var spans = _factory.Spans.Snapshot().Where(s => s.TraceId == runTraceId).ToArray();
        var root = spans.Single(s => s.OperationName == "purge.run");
        root.ParentSpanId.Should().Be(default(ActivitySpanId));

        Children(spans, root).Where(s => s.Source.Name == "FileHolder").Select(s => s.OperationName).Should().Equal(
            "purge.abort_expired_uploads", "purge.abandoned_uploads", "purge.expired_groups", "purge.tombstones");
        var groups = Children(spans, root, "purge.expired_groups").Single();
        ((int)groups.GetTagItem("fileholder.purge.found_group_count")!).Should().BeGreaterThanOrEqualTo(1);
        groups.GetTagItem("fileholder.purge.failed_object_count").Should().Be(0);
        Children(spans, groups, "storage.delete_objects").Should().ContainSingle();

        string.Join("\n", spans.Select(Render)).Should().NotContainEquivalentOf("tracing_secret");
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
