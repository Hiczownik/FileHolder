using System.Diagnostics.Metrics;
using System.Net;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Health;
using FileHolder.Core.Configuration;
using FileHolder.Core.Entities;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>The probe's status code and JSON body.</summary>
public sealed record HealthProbe(HttpStatusCode StatusCode, string Body)
{
    private JsonElement Root => JsonDocument.Parse(Body).RootElement;

    public string Status => Root.GetProperty("status").GetString()!;

    public string CheckStatus(string check) => Root.GetProperty("checks").GetProperty(check).GetProperty("status").GetString()!;

    public string CheckDescription(string check) => Root.GetProperty("checks").GetProperty(check).GetProperty("description").GetString()!;

    public int CheckCount => Root.GetProperty("checks").EnumerateObject().Count();

    public static async Task<HealthProbe> GetAsync(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        return new HealthProbe(response.StatusCode, await response.Content.ReadAsStringAsync());
    }
}

public class HealthEndpointsTests(HealthChecksFactory factory) : IClassFixture<HealthChecksFactory>
{
    private static readonly string[] AllChecks =
    [
        HealthCheckNames.Database, HealthCheckNames.Storage, HealthCheckNames.StorageLifecycle,
        HealthCheckNames.PurgeWorker, HealthCheckNames.PurgeBacklog,
    ];

    /// <summary>
    /// Storage answering, the safety net confirmed, the purge worker just done. Moves the clock on first, past the
    /// probe cache, so each test sees its own state rather than an answer cached by the one before.
    /// </summary>
    private void EverythingWell()
    {
        factory.Clock.Advance(HealthThresholds.ProbeCacheDuration + TimeSpan.FromMinutes(1));
        factory.MockS3Client.HeadBucketAsync(Arg.Any<HeadBucketRequest>(), Arg.Any<CancellationToken>())
            .Returns(new HeadBucketResponse());
        var expectedDays = factory.Services.GetRequiredService<IOptions<StorageOptions>>().Value.EffectiveLifecycleExpiryDays;
        factory.Services.GetRequiredService<StorageLifecycleStatus>().Confirm(expectedDays);
        factory.Services.GetRequiredService<PurgeWorkerStatus>().RecordSuccess();
    }

    [Fact]
    public async Task Live_Is200_AndRunsNoChecks()
    {
        var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/live");

        probe.StatusCode.Should().Be(HttpStatusCode.OK);
        probe.Status.Should().Be("Healthy");
        probe.CheckCount.Should().Be(0);
    }

    [Fact]
    public async Task Ready_WithEverythingUp_IsHealthy_AndHealthzIsTheSame()
    {
        EverythingWell();
        var client = factory.CreateClient();

        var ready = await HealthProbe.GetAsync(client, "/healthz/ready");
        var alias = await HealthProbe.GetAsync(client, "/healthz");

        ready.StatusCode.Should().Be(HttpStatusCode.OK, ready.Body);
        ready.Status.Should().Be("Healthy");
        AllChecks.Should().AllSatisfy(check => ready.CheckStatus(check).Should().Be("Healthy", check));
        alias.StatusCode.Should().Be(HttpStatusCode.OK);
        alias.CheckCount.Should().Be(AllChecks.Length);
    }

    [Fact]
    public async Task Ready_WhenStorageCantBeReached_Is503()
    {
        EverythingWell();
        factory.MockS3Client.HeadBucketAsync(Arg.Any<HeadBucketRequest>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new HttpRequestException("Connection refused (minio:9000)"));
        try
        {
            var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/ready");

            probe.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
            probe.Status.Should().Be("Unhealthy");
            probe.CheckStatus(HealthCheckNames.Storage).Should().Be("Unhealthy");
            probe.CheckDescription(HealthCheckNames.Storage).Should().Be("Storage can't be reached.");
            probe.CheckStatus(HealthCheckNames.Database).Should().Be("Healthy");
            probe.Body.Should().NotContain("minio:9000", "exception messages stay out of the response");
        }
        finally
        {
            EverythingWell();
        }
    }

    [Fact]
    public async Task Ready_WhenTheBucketIsMissing_Is503()
    {
        EverythingWell();
        factory.MockS3Client.HeadBucketAsync(Arg.Any<HeadBucketRequest>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new AmazonS3Exception("Not Found") { StatusCode = HttpStatusCode.NotFound });
        try
        {
            var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/ready");

            probe.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
            probe.CheckStatus(HealthCheckNames.Storage).Should().Be("Unhealthy");
            probe.CheckDescription(HealthCheckNames.Storage).Should().Be("The bucket doesn't exist.");
        }
        finally
        {
            EverythingWell();
        }
    }

    [Fact]
    public async Task Ready_WithABundleExpiredThreeHoursAgoAndNotPurged_IsDegraded_WithoutNamingIt()
    {
        EverythingWell();
        var now = factory.Clock.UtcNow;
        var overdue = NewGroup("hc_secret", "Quarterly Secrets", "salaries-2026.xlsx", expiresAt: now.AddHours(-3));
        // Due for purge, but only for an hour: within the purge's allowance, so not counted.
        var recent = NewGroup("hc_recent", "Recent", "recent.txt", expiresAt: now.AddHours(-1));
        await SeedAsync(overdue, recent);
        try
        {
            var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/ready");

            probe.StatusCode.Should().Be(HttpStatusCode.OK, "a lagging purge doesn't stop uploads or downloads");
            probe.Status.Should().Be("Degraded");
            probe.CheckStatus(HealthCheckNames.PurgeBacklog).Should().Be("Degraded");
            probe.CheckDescription(HealthCheckNames.PurgeBacklog).Should().Be("1 bundle(s) overdue for purge, the oldest expired or closed 3 h ago.");
            probe.Body.Should().NotContainAny(
                overdue.ShareToken, overdue.Title, "salaries-2026.xlsx", overdue.Files.Single().StorageKey, overdue.Id.ToString());
        }
        finally
        {
            await MarkPurgedAsync(overdue.Id, recent.Id);
        }
    }

    [Fact]
    public async Task Ready_WithNoSuccessfulPurgeRunFor61Minutes_IsDegraded()
    {
        EverythingWell();
        factory.Clock.Advance(TimeSpan.FromMinutes(61));

        var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/ready");

        probe.StatusCode.Should().Be(HttpStatusCode.OK);
        probe.Status.Should().Be("Degraded");
        probe.CheckStatus(HealthCheckNames.PurgeWorker).Should().Be("Degraded");
        probe.CheckDescription(HealthCheckNames.PurgeWorker).Should().Be("No successful purge run for 1 h.");
    }

    [Fact]
    public async Task Ready_BeforeStorageConfirmsTheSafetyNet_IsDegraded()
    {
        EverythingWell();
        factory.Services.GetRequiredService<StorageLifecycleStatus>().Confirm(0);
        try
        {
            var probe = await HealthProbe.GetAsync(factory.CreateClient(), "/healthz/ready");

            probe.StatusCode.Should().Be(HttpStatusCode.OK);
            probe.CheckStatus(HealthCheckNames.StorageLifecycle).Should().Be("Degraded");
        }
        finally
        {
            EverythingWell();
        }
    }

    [Fact]
    public async Task Metrics_PublishEachCheckAndTheOverdueCount()
    {
        _ = factory.CreateClient();
        var metrics = factory.Services.GetRequiredService<HealthMetrics>();
        var meterFactory = factory.Services.GetRequiredService<IMeterFactory>();
        var statuses = new Dictionary<string, int>();
        var overdueGroups = new List<int>();

        using var listener = new MeterListener();
        // Only this host's meters: other test hosts in the process publish the same instruments.
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (ReferenceEquals(instrument.Meter.Scope, meterFactory)) l.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<int>((instrument, value, tags, _) =>
        {
            if (instrument.Name == HealthMetrics.StatusInstrument)
            {
                statuses[(string)tags.ToArray().Single(t => t.Key == "check").Value!] = value;
            }
            else if (instrument.Name == HealthMetrics.OverdueGroupsInstrument)
            {
                overdueGroups.Add(value);
            }
        });
        listener.Start();

        await metrics.PublishAsync(new HealthReport(new Dictionary<string, HealthReportEntry>
        {
            [HealthCheckNames.Database] = new(HealthStatus.Healthy, null, TimeSpan.Zero, null, null),
            [HealthCheckNames.Storage] = new(HealthStatus.Unhealthy, null, TimeSpan.Zero, null, null),
            [HealthCheckNames.PurgeBacklog] = new(HealthStatus.Degraded, null, TimeSpan.Zero, null,
                new Dictionary<string, object> { [PurgeBacklogHealthCheck.OverdueGroupsKey] = 3 }),
        }, TimeSpan.Zero), CancellationToken.None);
        listener.RecordObservableInstruments();

        statuses.Should().BeEquivalentTo(new Dictionary<string, int>
        {
            [HealthCheckNames.Database] = 2,
            [HealthCheckNames.Storage] = 0,
            [HealthCheckNames.PurgeBacklog] = 1,
        });
        overdueGroups.Should().Equal(3);
    }

    private static FileGroup NewGroup(string shareToken, string title, string fileName, DateTime expiresAt) => new()
    {
        ShareToken = shareToken + "_" + Guid.NewGuid().ToString("N")[..8],
        Title = title,
        ExpiresAt = expiresAt,
        CreatedAt = expiresAt.AddHours(-24),
        MaxDownloads = 10,
        Files = new List<SharedFile>
        {
            new() { OriginalFileName = fileName, StorageKey = $"files/{Guid.NewGuid():N}", ContentType = "application/octet-stream", SizeBytes = 10 },
        },
    };

    private async Task SeedAsync(params FileGroup[] groups)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.FileGroups.AddRange(groups);
        await db.SaveChangesAsync();
    }

    /// <summary>Takes the test's bundles out of the backlog again, so later tests start with none overdue.</summary>
    private async Task MarkPurgedAsync(params Guid[] ids)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var group in db.FileGroups.Where(g => ids.Contains(g.Id)))
        {
            group.StoragePurgedAt = factory.Clock.UtcNow;
        }

        await db.SaveChangesAsync();
    }
}

/// <summary>Its own fixture: stopping the database can't be undone for the rest of a fixture's tests.</summary>
public class HealthWithDatabaseDownTests(HealthChecksFactory factory) : IClassFixture<HealthChecksFactory>
{
    [Fact]
    public async Task Ready_WhenTheDatabaseIsDown_Is503_WhileLiveStays200()
    {
        var client = factory.CreateClient();
        factory.MockS3Client.HeadBucketAsync(Arg.Any<HeadBucketRequest>(), Arg.Any<CancellationToken>())
            .Returns(new HeadBucketResponse());
        await factory.StopDatabaseAsync();

        var ready = await HealthProbe.GetAsync(client, "/healthz/ready");
        var live = await HealthProbe.GetAsync(client, "/healthz/live");

        ready.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, ready.Body);
        ready.CheckStatus(HealthCheckNames.Database).Should().Be("Unhealthy");
        ready.CheckStatus(HealthCheckNames.Storage).Should().Be("Healthy");
        // Reported once, by the database check; the purge backlog only says it can't tell.
        ready.CheckStatus(HealthCheckNames.PurgeBacklog).Should().Be("Degraded");
        ready.Body.Should().NotContain("Npgsql").And.NotContain("Host=");
        live.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
