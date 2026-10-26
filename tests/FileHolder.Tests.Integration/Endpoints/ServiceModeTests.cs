using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FileHolder.Api.Admin;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// Maintenance modes (#82): every mode against every endpoint, uploads already started finishing while uploads are
/// paused, the purge running while closed, and the admin endpoints that switch them. Tests in a class run one at a
/// time; each starts in Normal and switches through the admin endpoint, as the owner would.
/// </summary>
public class ServiceModeTests(ServiceModesFactory factory) : IClassFixture<ServiceModesFactory>, IAsyncLifetime
{
    private readonly HttpClient _client = factory.CreateClient();
    private readonly HttpClient _admin = factory.CreateAdminClient();

    public Task InitializeAsync() => SetModeAsync(ServiceMode.Normal);

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task SetModeAsync(ServiceMode mode, string? message = null, DateTime? until = null)
    {
        var response = await _admin.PutAsJsonAsync("/admin/mode", new SetServiceModeRequestDto(mode, "test", message, until));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>Every public endpoint, with a body that gets past binding, so only the mode decides a 503.</summary>
    public static TheoryData<string> Endpoints() => new(EndpointRequests.Keys);

    private static readonly Guid AnyId = Guid.NewGuid();

    private static readonly Dictionary<string, (HttpMethod Method, string Path, object? Body, ServiceCapability? Capability)> EndpointRequests = new()
    {
        ["limits"] = (HttpMethod.Get, "/api/v1/files/limits", null, null),
        ["status"] = (HttpMethod.Get, "/api/v1/status", null, null),
        ["presign"] = (HttpMethod.Post, "/api/v1/files/presign",
            new CreatePresignedUrlRequestDto("Mode", [new FileItemInputDto("a.pdf", "application/pdf", 1024)], 24, 5, null),
            ServiceCapability.StartUpload),
        ["presign-batch"] = (HttpMethod.Post, "/api/v1/files/multipart/presign-batch",
            new PresignPartBatchRequestDto("token", "uploads/key", "upload-id", 1, 1), ServiceCapability.ContinueUpload),
        ["complete"] = (HttpMethod.Post, "/api/v1/files/multipart/complete",
            new CompleteMultipartUploadRequestDto("token", "uploads/key", "upload-id", [new CompletedPartInputDto(1, "\"etag\"")]),
            ServiceCapability.ContinueUpload),
        ["abort"] = (HttpMethod.Post, "/api/v1/files/multipart/abort",
            new AbortMultipartUploadRequestDto("token", "uploads/key", "upload-id"), null),
        ["confirm"] = (HttpMethod.Post, "/api/v1/files/confirm",
            new ConfirmUploadRequestDto("token", "Mode", [new ConfirmedFileItemDto("uploads/key.pdf", "a.pdf", "application/pdf", 1024)], 24, 5, null),
            ServiceCapability.ContinueUpload),
        ["metadata"] = (HttpMethod.Get, "/api/v1/files/abcd1234", null, ServiceCapability.ViewBundle),
        ["unlock"] = (HttpMethod.Post, "/api/v1/files/abcd1234/unlock", new DownloadRequestDto("password"), ServiceCapability.ViewBundle),
        ["open-session"] = (HttpMethod.Post, "/api/v1/files/abcd1234/downloads", new DownloadRequestDto(null), ServiceCapability.StartDownload),
        ["file-link"] = (HttpMethod.Post, $"/api/v1/files/abcd1234/download/{AnyId}", new DownloadRequestDto(null, AnyId),
            ServiceCapability.ContinueDownload),
        ["zip-without-session"] = (HttpMethod.Post, "/api/v1/files/abcd1234/download-all", new DownloadRequestDto(null),
            ServiceCapability.StartDownload),
        ["zip-with-session"] = (HttpMethod.Post, "/api/v1/files/abcd1234/download-all", new DownloadRequestDto(null, AnyId),
            ServiceCapability.ContinueDownload),
        ["zip-get"] = (HttpMethod.Get, $"/api/v1/files/abcd1234/download-all?downloadSessionId={AnyId}", null,
            ServiceCapability.ContinueDownload),
    };

    private Task<HttpResponseMessage> SendAsync(string endpoint)
    {
        var (method, path, body, _) = EndpointRequests[endpoint];
        var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, body.GetType());
        }

        return _client.SendAsync(request);
    }

    [Theory]
    [MemberData(nameof(Endpoints))]
    public async Task EveryMode_RefusesExactlyWhatItsRulesSay(string endpoint)
    {
        var capability = EndpointRequests[endpoint].Capability;

        foreach (var mode in Enum.GetValues<ServiceMode>())
        {
            await SetModeAsync(mode);

            var response = await SendAsync(endpoint);

            bool allowed = capability is null || ServiceModeRules.Allows(mode, capability.Value);
            if (allowed)
            {
                response.StatusCode.Should().NotBe(HttpStatusCode.ServiceUnavailable, $"{mode} allows {endpoint}");
            }
            else
            {
                response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, $"{mode} refuses {endpoint}");
                var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
                problem.GetProperty("mode").GetString().Should().Be(mode.ToString());
                response.Headers.RetryAfter.Should().NotBeNull();
            }
        }
    }

    [Fact]
    public void TheModeRules_MatchTheTableInIssue82()
    {
        string Row(ServiceMode mode) => string.Join(" ", Enum.GetValues<ServiceCapability>()
            .Select(c => ServiceModeRules.Allows(mode, c) ? "y" : "n"));

        // StartUpload, ContinueUpload, ViewBundle, StartDownload, ContinueDownload
        Row(ServiceMode.Normal).Should().Be("y y y y y");
        Row(ServiceMode.UploadsPaused).Should().Be("n y y y y");
        Row(ServiceMode.ReadOnly).Should().Be("n n y n y");
        Row(ServiceMode.Closed).Should().Be("n n n n n");
    }

    [Fact]
    public async Task Status_ShowsTheModeTheMessageAndUntil_AndIsNeverCached()
    {
        var until = factory.Clock.UtcNow.AddHours(2);
        await SetModeAsync(ServiceMode.UploadsPaused, "Back at 14:00.", until);

        var response = await _client.GetAsync("/api/v1/status");

        response.Headers.CacheControl!.NoStore.Should().BeTrue();
        var body = await response.Content.ReadAsStringAsync();
        var status = JsonSerializer.Deserialize<ServiceStatusDto>(body);
        status!.Mode.Should().Be(ServiceMode.UploadsPaused);
        status.Message.Should().Be("Back at 14:00.");
        status.Until.Should().BeCloseTo(until, TimeSpan.FromMilliseconds(1));

        using var json = JsonDocument.Parse(body);
        json.RootElement.GetProperty("mode").GetString().Should().Be("UploadsPaused");
    }

    [Fact]
    public async Task Status_IsNormal_WithNoMessage_WhenNothingWasEverSet()
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().ServiceModeChanges.ExecuteDeleteAsync();
        // A fresh instance, so nothing is cached.
        var provider = ActivatorUtilities.CreateInstance<ServiceModeProvider>(factory.Services);

        (await provider.GetCurrentAsync()).Should().Be(ServiceStatusDto.Normal);
    }

    [Fact]
    public async Task ARefusal_CarriesTheOwnersMessage_AndRetryAfterUntilTheirUntil()
    {
        await SetModeAsync(ServiceMode.UploadsPaused, "Paused while we look into abuse reports.", factory.Clock.UtcNow.AddMinutes(30));

        var response = await SendAsync("presign");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        response.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromMinutes(30));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("title").GetString().Should().Be("Uploads Paused");
        problem.GetProperty("detail").GetString().Should().Be("Paused while we look into abuse reports.");
    }

    [Fact]
    public async Task ARefusal_WithoutUntil_AsksToRetryAfterTheDefault()
    {
        await SetModeAsync(ServiceMode.Closed);

        var response = await SendAsync("metadata");

        response.Headers.RetryAfter!.Delta.Should().Be(ServiceModeRules.DefaultRetryAfter);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("title").GetString().Should().Be("Temporarily Closed");
    }

    [Fact]
    public async Task AnUploadStartedBeforeThePause_StillFinishes()
    {
        var files = new List<FileItemInputDto> { new("report.pdf", "application/pdf", 2048) };
        var presignResponse = await _client.PostAsJsonAsync("/api/v1/files/presign",
            new CreatePresignedUrlRequestDto("In flight", files, 24, 5, null));
        presignResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var presign = (await presignResponse.Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!;
        factory.SeedS3Object(presign.Items[0].StorageKey, 2048);

        await SetModeAsync(ServiceMode.UploadsPaused);

        var confirm = await _client.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, "In flight",
            [new ConfirmedFileItemDto(presign.Items[0].StorageKey, "report.pdf", "application/pdf", 2048)], 24, 5, null));
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = await confirm.Content.ReadFromJsonAsync<string>();

        // Its link works too: downloads aren't paused.
        (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/downloads", new DownloadRequestDto(null)))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ADownloadStartedBeforeReadOnly_StillFinishes_ButNoNewOneStarts()
    {
        var files = new List<FileItemInputDto> { new("photo.jpg", "image/jpeg", 4096) };
        var presign = (await (await _client.PostAsJsonAsync("/api/v1/files/presign",
            new CreatePresignedUrlRequestDto("Session", files, 24, 5, null))).Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!;
        factory.SeedS3Object(presign.Items[0].StorageKey, 4096);
        var shareToken = await (await _client.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            presign.UploadToken, "Session",
            [new ConfirmedFileItemDto(presign.Items[0].StorageKey, "photo.jpg", "image/jpeg", 4096)], 24, 5, null)))
            .Content.ReadFromJsonAsync<string>();
        var session = await (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/downloads", new DownloadRequestDto(null)))
            .Content.ReadFromJsonAsync<DownloadSessionResponseDto>();
        Guid fileId;
        using (var scope = factory.Services.CreateScope())
        {
            fileId = await scope.ServiceProvider.GetRequiredService<AppDbContext>().SharedFiles
                .Where(f => f.FileGroup.ShareToken == shareToken).Select(f => f.Id).SingleAsync();
        }

        await SetModeAsync(ServiceMode.ReadOnly);

        (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download/{fileId}",
            new DownloadRequestDto(null, session!.DownloadSessionId))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await _client.GetAsync($"/api/v1/files/{shareToken}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/downloads", new DownloadRequestDto(null)))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task ThePurge_RunsWhileClosed()
    {
        var group = new FileGroup
        {
            ShareToken = Guid.NewGuid().ToString("N")[..8],
            ExpiresAt = factory.Clock.UtcNow - TimeSpan.FromHours(1),
            Files = [new SharedFile { OriginalFileName = "old.pdf", StorageKey = $"uploads/{Guid.NewGuid():N}.pdf", ContentType = "application/pdf", SizeBytes = 10 }],
        };
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.FileGroups.Add(group);
            await db.SaveChangesAsync();
        }

        await SetModeAsync(ServiceMode.Closed);

        using (var scope = factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<IStoragePurgeService>().PurgeExpiredFilesAsync();
            var purged = await scope.ServiceProvider.GetRequiredService<AppDbContext>().FileGroups
                .AsNoTracking().SingleAsync(g => g.Id == group.Id);
            purged.StoragePurgedAt.Should().NotBeNull();
        }
    }

    [Fact]
    public async Task EveryChange_IsLogged_WithItsReasonAndWho_NewestFirst()
    {
        await _admin.PutAsJsonAsync("/admin/mode", new SetServiceModeRequestDto(ServiceMode.ReadOnly, "abuse wave", ChangedBy: "owner"));
        await _admin.PutAsJsonAsync("/admin/mode", new SetServiceModeRequestDto(ServiceMode.Normal, "all clear", ChangedBy: "owner"));

        var response = await _admin.GetFromJsonAsync<AdminServiceModeResponseDto>("/admin/mode");

        response!.Current.Mode.Should().Be(ServiceMode.Normal);
        response.History.Take(2).Select(c => (c.Mode, c.Reason, c.ChangedBy)).Should().Equal(
            (ServiceMode.Normal, "all clear", "owner"),
            (ServiceMode.ReadOnly, "abuse wave", "owner"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task SetMode_RequiresAReason(string reason)
    {
        var response = await _admin.PutAsJsonAsync("/admin/mode", new SetServiceModeRequestDto(ServiceMode.Closed, reason));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _client.GetFromJsonAsync<ServiceStatusDto>("/api/v1/status"))!.Mode.Should().Be(ServiceMode.Normal);
    }

    [Fact]
    public async Task SetMode_RefusesAnUntilInThePast()
    {
        var response = await _admin.PutAsJsonAsync("/admin/mode",
            new SetServiceModeRequestDto(ServiceMode.Closed, "test", Until: factory.Clock.UtcNow.AddMinutes(-1)));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task SetMode_RefusesAnUnknownMode()
    {
        var response = await _admin.PutAsJsonAsync("/admin/mode", new { mode = "Sleeping", reason = "test" });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Bearer wrong-token")]
    [InlineData("Basic " + ServiceModesFactory.AdminToken)]
    [InlineData(ServiceModesFactory.AdminToken)]
    public async Task AdminEndpoints_Return401_WithoutTheRightBearerToken(string? authorization)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/admin/mode");
        if (authorization is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        }

        (await _client.SendAsync(request)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AdminEndpoints_DontExistOnThePublicPort()
    {
        // The token is right, but the connection didn't come in on the admin port.
        using var publicPort = WithSetting("Admin:Port", "9465");
        var client = publicPort.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", ServiceModesFactory.AdminToken);

        (await client.GetAsync("/admin/mode")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AdminEndpoints_AreOff_WithoutAToken()
    {
        using var noToken = WithSetting("Admin:Token", "");
        var client = noToken.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", "");

        (await client.GetAsync("/admin/mode")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public void Startup_RefusesAShortAdminToken()
    {
        using var weak = WithSetting("Admin:Token", "short");

        var start = () => weak.CreateClient();

        start.Should().Throw<OptionsValidationException>().WithMessage("*Admin:Token must be at least 32 characters*");
    }

    /// <summary>The fixture's settings are added last, so overriding one takes another configuration source.</summary>
    private WebApplicationFactory<Program> WithSetting(string key, string value) =>
        factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration(config =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { [key] = value })));

    [Fact]
    public void AdminOptions_DefaultToTheInternalAdminPort()
    {
        new AdminOptions().Port.Should().Be(9465);
    }
}
