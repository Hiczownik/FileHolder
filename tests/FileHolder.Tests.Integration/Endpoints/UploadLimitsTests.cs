using System.Diagnostics.Metrics;
using System.Net;
using System.Net.Http.Json;
using FileHolder.Api.Health;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Infrastructure.Data;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using static FileHolder.Tests.Integration.Fixtures.DemoLimitsFactory;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>The limits the API reports and enforces with its defaults: the app's full design.</summary>
public class DefaultUploadLimitsTests(CustomWebApplicationFactory factory) : IClassFixture<CustomWebApplicationFactory>
{
    [Fact]
    public async Task Limits_AreTheAppsDefaults()
    {
        var limits = await factory.CreateClient().GetFromJsonAsync<UploadLimitsResponseDto>("/api/v1/files/limits");

        limits.Should().Be(new UploadLimitsResponseDto(5L * 1024 * 1024 * 1024, 50, 1, 168, LongestExpiryHours: 168));
    }
}

/// <summary>
/// A public demo's limits (#148): reported to the UI, enforced by presign, and the global storage quota. Tests in a
/// class run one at a time, and each starts from an empty database, since the quota counts every bundle.
/// </summary>
public class DemoUploadLimitsTests(DemoLimitsFactory factory) : IClassFixture<DemoLimitsFactory>, IAsyncLifetime
{
    private readonly HttpClient _client = factory.CreateClient();

    public async Task InitializeAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.PendingUploads.ExecuteDeleteAsync();
        await db.SharedFiles.ExecuteDeleteAsync();
        await db.FileGroups.ExecuteDeleteAsync();
        // Past the health checks' cache, so they see this test's data.
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private Task<HttpResponseMessage> PresignAsync(long sizeBytes, int expireInHours = MaxExpiryHours) =>
        _client.PostAsJsonAsync("/api/v1/files/presign", new CreatePresignedUrlRequestDto(
            "Demo", [new FileItemInputDto("demo.pdf", "application/pdf", sizeBytes)], expireInHours, 10, Password: null));

    /// <summary>A bundle whose file still takes up <paramref name="sizeBytes"/> of storage (not purged yet).</summary>
    private async Task<Guid> SeedStoredBundleAsync(long sizeBytes)
    {
        var group = new FileGroup
        {
            ShareToken = Guid.NewGuid().ToString("N")[..8],
            ExpiresAt = factory.Clock.UtcNow.AddHours(12),
            CreatedAt = factory.Clock.UtcNow,
            MaxDownloads = 10,
            Files = new List<SharedFile>
            {
                new() { OriginalFileName = "stored.bin", StorageKey = $"files/{Guid.NewGuid():N}", ContentType = "application/octet-stream", SizeBytes = sizeBytes },
            },
        };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.FileGroups.Add(group);
        await db.SaveChangesAsync();
        return group.Id;
    }

    private async Task MarkPurgedAsync(Guid groupId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.FileGroups.Where(g => g.Id == groupId)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.StoragePurgedAt, factory.Clock.UtcNow));
    }

    private static async Task ShouldBeStorageFullAsync(HttpResponseMessage response)
    {
        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        response.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromMinutes(30), "space comes back with the purge's next run");
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Title.Should().Be("Storage Full");
        problem.Detail.Should().Contain("try again later");
    }

    [Fact]
    public async Task Limits_AreTheConfiguredOnes()
    {
        var limits = await _client.GetFromJsonAsync<UploadLimitsResponseDto>("/api/v1/files/limits");

        limits.Should().Be(new UploadLimitsResponseDto(MaxBundleSizeBytes, 50, 1, MaxExpiryHours, LongestExpiryHours: MaxExpiryHours));
    }

    [Fact]
    public async Task Presign_RefusesAnExpiryPastTheConfiguredMaximum()
    {
        var tooLong = await PresignAsync(MiB, MaxExpiryHours + 1);

        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await tooLong.Content.ReadAsStringAsync()).Should().Contain("between 1 hour and 24 hours (1 day)");
        (await PresignAsync(MiB, MaxExpiryHours)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Presign_RefusesABundlePastTheConfiguredSize()
    {
        var tooBig = await PresignAsync(MaxBundleSizeBytes + 1);

        tooBig.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await tooBig.Content.ReadAsStringAsync()).Should().Contain("cannot be larger than 250 MB");
        (await PresignAsync(MaxBundleSizeBytes)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Presign_RefusesWhatWouldGoPastTheQuota_CountsPendingUploads_AndAcceptsAgainOnceThePurgeFreesSpace()
    {
        var stored = await SeedStoredBundleAsync(900 * MiB);

        await ShouldBeStorageFullAsync(await PresignAsync(200 * MiB));

        // 900 + 100 = 1000 MiB, under the 1024 MiB quota.
        (await PresignAsync(100 * MiB)).StatusCode.Should().Be(HttpStatusCode.OK);

        // That presign's 100 MiB is held for it until it's confirmed or dropped, so 50 more no longer fit.
        await ShouldBeStorageFullAsync(await PresignAsync(50 * MiB));

        await MarkPurgedAsync(stored);
        (await PresignAsync(50 * MiB)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TheQuotaCheck_WarnsFrom80Percent_WithoutFailingReadiness()
    {
        await SeedStoredBundleAsync(700 * MiB);
        var below = await HealthProbe.GetAsync(_client, "/healthz/ready");

        await SeedStoredBundleAsync(150 * MiB);
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var above = await HealthProbe.GetAsync(_client, "/healthz/ready");

        below.CheckStatus(HealthCheckNames.StorageQuota).Should().Be("Healthy");
        below.CheckDescription(HealthCheckNames.StorageQuota).Should().Contain("of the 1 GB storage quota in use (68");
        above.StatusCode.Should().Be(HttpStatusCode.OK, "a filling quota doesn't stop downloads");
        above.CheckStatus(HealthCheckNames.StorageQuota).Should().Be("Degraded");
        above.CheckDescription(HealthCheckNames.StorageQuota).Should().Contain("(83").And.Contain("refused once it's full");
    }

    [Fact]
    public async Task Metrics_PublishTheStorageInUse_AndTheQuota()
    {
        var metrics = factory.Services.GetRequiredService<HealthMetrics>();
        var meterFactory = factory.Services.GetRequiredService<IMeterFactory>();
        var measured = new Dictionary<string, long>();
        using var listener = new MeterListener();
        // Only this host's meters: other test hosts in the process publish the same instruments.
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (ReferenceEquals(instrument.Meter.Scope, meterFactory)) l.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, _, _) => measured[instrument.Name] = value);
        listener.Start();

        await metrics.PublishAsync(new HealthReport(new Dictionary<string, HealthReportEntry>
        {
            [HealthCheckNames.StorageQuota] = new(HealthStatus.Healthy, null, TimeSpan.Zero, null, new Dictionary<string, object>
            {
                [StorageQuotaHealthCheck.UsedBytesKey] = 300 * MiB,
                [StorageQuotaHealthCheck.QuotaBytesKey] = GlobalQuotaBytes,
            }),
        }, TimeSpan.Zero), CancellationToken.None);
        listener.RecordObservableInstruments();

        measured.Should().Contain(HealthMetrics.StorageUsedInstrument, 300 * MiB)
            .And.Contain(HealthMetrics.StorageQuotaInstrument, GlobalQuotaBytes);
    }
}
