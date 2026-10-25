using System.Diagnostics.Metrics;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Configuration;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using FileHolder.Api.Health;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// The storage safety net (#69): the lifecycle rule the API puts on the bucket, against real Silo storage. Put in place
/// as the API's own storage user, so its policy is shown to allow it; read back as the storage admin.
/// </summary>
public class StorageLifecycleTests(SiloFixture silo) : IClassFixture<SiloFixture>
{
    private static readonly TimeSpan ConfirmTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan RetryObservationTime = TimeSpan.FromMilliseconds(500);

    private static StorageLifecycleStatus NewStatus() =>
        new(new ServiceCollection().AddMetrics().BuildServiceProvider().GetRequiredService<IMeterFactory>());

    private static StorageLifecycleInitializer NewInitializer(
        IAmazonS3 client, StorageLifecycleStatus status, int? expiryDays = null, LifecycleRuleMode mode = LifecycleRuleMode.Apply) =>
        new(client,
            Options.Create(new StorageOptions { BucketName = SiloFixture.BucketName, LifecycleExpiryDays = expiryDays, LifecycleRule = mode }),
            status,
            NullLogger<StorageLifecycleInitializer>.Instance);

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + ConfirmTimeout;
        while (!condition() && DateTime.UtcNow < deadline)
        {
            await Task.Delay(PollInterval);
        }
    }

    [Fact]
    public async Task ApplyAsync_PutsTheExpiryRuleOnTheBucket_AsStorageReadsItBack()
    {
        var applied = await NewInitializer(silo.ApiClient, NewStatus()).ApplyAsync();

        applied.ExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
        var stored = await silo.Client.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = SiloFixture.BucketName });
        stored.Configuration.Rules.Should().ContainSingle(rule => rule.Id == StorageSafetyNet.LifecycleRuleId)
            .Which.Expiration.Days.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
    }

    [Fact]
    public async Task ApplyingTheRuleAgain_LeavesOneRule()
    {
        var initializer = NewInitializer(silo.ApiClient, NewStatus());

        await initializer.ApplyAsync();
        await initializer.ApplyAsync();

        var stored = await silo.Client.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = SiloFixture.BucketName });
        stored.Configuration.Rules.Should().ContainSingle();
    }

    [Fact]
    public async Task AtStartup_TheRuleIsConfirmed_AndTheMetricReportsItsDays()
    {
        var status = NewStatus();
        using var initializer = NewInitializer(silo.ApiClient, status);

        await initializer.StartAsync(CancellationToken.None);
        await WaitUntil(() => status.ConfirmedExpiryDays > 0);
        await initializer.StopAsync(CancellationToken.None);

        status.ConfirmedExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
        ObservedLifecycleDays().Should().Be(StorageSafetyNet.LifecycleExpiryDays);
    }

    [Fact]
    public async Task WithAnExternalRule_NoStorageCallIsMade_AndTheMetricReportsNothing()
    {
        // As with a Cloudflare R2 token limited to one bucket: every lifecycle call would be refused.
        var objectsOnly = Substitute.For<IAmazonS3>();
        var meterFactory = new ServiceCollection().AddMetrics().BuildServiceProvider().GetRequiredService<IMeterFactory>();
        var status = new StorageLifecycleStatus(meterFactory);
        using var initializer = NewInitializer(objectsOnly, status, mode: LifecycleRuleMode.External);

        await initializer.StartAsync(CancellationToken.None);
        await initializer.ExecuteTask!;

        objectsOnly.ReceivedCalls().Should().BeEmpty();
        status.IsExternal.Should().BeTrue();
        var measured = new List<int>();
        using var listener = new MeterListener();
        // Only this status's meter: other tests' statuses publish the same instrument.
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (ReferenceEquals(instrument.Meter.Scope, meterFactory)) l.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<int>((_, value, _, _) => measured.Add(value));
        listener.Start();
        listener.RecordObservableInstruments();
        measured.Should().BeEmpty("the API can't know the rule's days, so it claims none");
    }

    [Fact]
    public async Task WithAnExternalRule_TheHealthCheckIsHealthy_AndStatesWhatTheRuleShouldBe()
    {
        var options = Options.Create(new StorageOptions { BucketName = SiloFixture.BucketName, LifecycleRule = LifecycleRuleMode.External });
        options.Value.UseMaxExpiryHours(24);

        var result = await new StorageLifecycleHealthCheck(NewStatus(), options).CheckHealthAsync(new HealthCheckContext());

        result.Status.Should().Be(HealthStatus.Healthy);
        result.Description.Should().Be("Managed outside the app (Storage:LifecycleRule=External); expected: objects deleted after 4 days, unfinished uploads aborted after 2 days.");
    }

    [Fact]
    public async Task WhileStorageIsUnreachable_TheMetricStaysAt0_AndItKeepsTrying()
    {
        var unreachable = Substitute.For<IAmazonS3>();
        unreachable.PutLifecycleConfigurationAsync(Arg.Any<PutLifecycleConfigurationRequest>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new AmazonS3Exception("connection refused"));
        var status = NewStatus();
        using var initializer = NewInitializer(unreachable, status);

        await initializer.StartAsync(CancellationToken.None);
        await Task.Delay(RetryObservationTime);

        status.ConfirmedExpiryDays.Should().Be(0);
        initializer.ExecuteTask!.IsCompleted.Should().BeFalse();
        await initializer.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ARuleStorageKeptWithOtherDays_IsNotConfirmed()
    {
        var keepsOtherDays = Substitute.For<IAmazonS3>();
        keepsOtherDays.GetLifecycleConfigurationAsync(Arg.Any<GetLifecycleConfigurationRequest>(), Arg.Any<CancellationToken>())
            .Returns(new GetLifecycleConfigurationResponse
            {
                Configuration = new LifecycleConfiguration
                {
                    Rules = [new LifecycleRule { Id = StorageSafetyNet.LifecycleRuleId, Expiration = new LifecycleRuleExpiration { Days = 3 } }],
                },
            });
        var status = NewStatus();
        using var initializer = NewInitializer(keepsOtherDays, status);

        await initializer.StartAsync(CancellationToken.None);
        await Task.Delay(RetryObservationTime);

        status.ConfirmedExpiryDays.Should().Be(0);
        await initializer.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task AConfiguredLongerExpiry_IsTheOneApplied()
    {
        var longer = StorageSafetyNet.LifecycleExpiryDays + 5;

        var applied = await NewInitializer(silo.ApiClient, NewStatus(), longer).ApplyAsync();

        applied.ExpiryDays.Should().Be(longer);
    }

    /// <summary>The value the fileholder.storage.lifecycle_days gauge reports right now.</summary>
    private static int? ObservedLifecycleDays()
    {
        int? observed = null;
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == StorageLifecycleStatus.MeterName && instrument.Name == StorageLifecycleStatus.LifecycleDaysInstrument)
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<int>((_, value, _, _) => observed = value);
        listener.Start();
        listener.RecordObservableInstruments();
        return observed;
    }
}

/// <summary>How the "Storage" section's lifecycle setting is checked, without starting the API.</summary>
public class StorageLifecycleOptionsTests
{
    // Required, with no default, so every resolve needs them; the values don't matter here.
    private static readonly Dictionary<string, string?> Credentials = new()
    {
        ["Storage:AccessKey"] = "test-access-key",
        ["Storage:SecretKey"] = "test-secret-key",
    };

    private static StorageOptions Resolve(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(Credentials).AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection()
            .Configure<UploadLimitsOptions>(configuration.GetSection(UploadLimitsOptions.SectionName))
            .AddFileHolderStorageOptions(configuration);
        return services.BuildServiceProvider().GetRequiredService<IOptions<StorageOptions>>().Value;
    }

    [Fact]
    public void Unset_UsesTheExpiryCalculatedFromTheAppsTimings()
    {
        Resolve([]).EffectiveLifecycleExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
    }

    [Fact]
    public void ALongerExpiry_IsAccepted()
    {
        var longer = (StorageSafetyNet.LifecycleExpiryDays + 20).ToString(System.Globalization.CultureInfo.InvariantCulture);

        Resolve(new() { ["Storage:LifecycleExpiryDays"] = longer }).EffectiveLifecycleExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays + 20);
    }

    [Fact]
    public void AShorterMaximumBundleLifetime_ShortensTheCalculatedExpiry()
    {
        Resolve(new() { ["UploadLimits:MaxExpiryHours"] = "24" }).EffectiveLifecycleExpiryDays.Should().Be(4);
    }

    [Fact]
    public void WithAShorterMaximumBundleLifetime_ASettingAboveTheNewCalculation_IsAccepted()
    {
        // 5 days would be refused under the default 7-day maximum (10 days), but bundles of at most 24 h need only 4.
        Resolve(new() { ["UploadLimits:MaxExpiryHours"] = "24", ["Storage:LifecycleExpiryDays"] = "5" })
            .EffectiveLifecycleExpiryDays.Should().Be(5);
    }

    [Fact]
    public void WithAShorterMaximumBundleLifetime_ASettingBelowTheNewCalculation_IsRefused()
    {
        var resolve = () => Resolve(new() { ["UploadLimits:MaxExpiryHours"] = "24", ["Storage:LifecycleExpiryDays"] = "3" });

        resolve.Should().Throw<OptionsValidationException>().WithMessage("*Storage:LifecycleExpiryDays is below 4*still live*");
    }

    [Theory]
    [InlineData(null, LifecycleRuleMode.Apply)]
    [InlineData("External", LifecycleRuleMode.External)]
    [InlineData("apply", LifecycleRuleMode.Apply)]
    public void TheLifecycleRuleMode_IsApplyUnlessSetOtherwise(string? setting, LifecycleRuleMode expected)
    {
        var settings = setting is null ? new Dictionary<string, string?>() : new() { ["Storage:LifecycleRule"] = setting };

        Resolve(settings).LifecycleRule.Should().Be(expected);
    }

    [Fact]
    public void AnUnknownLifecycleRuleMode_IsRefused()
    {
        var resolve = () => Resolve(new() { ["Storage:LifecycleRule"] = "Sometimes" });

        resolve.Should().Throw<InvalidOperationException>().WithMessage("*Storage:LifecycleRule*");
    }

    [Fact]
    public void AnExpiryShorterThanBundlesCanLive_IsRefused()
    {
        var shorter = (StorageSafetyNet.LifecycleExpiryDays - 1).ToString(System.Globalization.CultureInfo.InvariantCulture);

        var resolve = () => Resolve(new() { ["Storage:LifecycleExpiryDays"] = shorter });

        resolve.Should().Throw<OptionsValidationException>().WithMessage("*Storage:LifecycleExpiryDays*still live*");
    }
}
