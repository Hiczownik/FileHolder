using System.Diagnostics.Metrics;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Configuration;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace FileHolder.Tests.Integration.Services;

/// <summary>The storage safety net (#69): the lifecycle rule the API puts on the bucket, against real Silo storage.</summary>
public class StorageLifecycleTests(SiloFixture silo) : IClassFixture<SiloFixture>
{
    private static readonly TimeSpan ConfirmTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan RetryObservationTime = TimeSpan.FromMilliseconds(500);

    private static StorageLifecycleStatus NewStatus() =>
        new(new ServiceCollection().AddMetrics().BuildServiceProvider().GetRequiredService<IMeterFactory>());

    private static StorageLifecycleInitializer NewInitializer(IAmazonS3 client, StorageLifecycleStatus status, int? expiryDays = null) =>
        new(client,
            Options.Create(new StorageOptions { BucketName = SiloFixture.BucketName, LifecycleExpiryDays = expiryDays }),
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
        var applied = await NewInitializer(silo.Client, NewStatus()).ApplyAsync();

        applied.ExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
        var stored = await silo.Client.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = SiloFixture.BucketName });
        stored.Configuration.Rules.Should().ContainSingle(rule => rule.Id == StorageSafetyNet.LifecycleRuleId)
            .Which.Expiration.Days.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
    }

    [Fact]
    public async Task ApplyingTheRuleAgain_LeavesOneRule()
    {
        var initializer = NewInitializer(silo.Client, NewStatus());

        await initializer.ApplyAsync();
        await initializer.ApplyAsync();

        var stored = await silo.Client.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = SiloFixture.BucketName });
        stored.Configuration.Rules.Should().ContainSingle();
    }

    [Fact]
    public async Task AtStartup_TheRuleIsConfirmed_AndTheMetricReportsItsDays()
    {
        var status = NewStatus();
        using var initializer = NewInitializer(silo.Client, status);

        await initializer.StartAsync(CancellationToken.None);
        await WaitUntil(() => status.ConfirmedExpiryDays > 0);
        await initializer.StopAsync(CancellationToken.None);

        status.ConfirmedExpiryDays.Should().Be(StorageSafetyNet.LifecycleExpiryDays);
        ObservedLifecycleDays().Should().Be(StorageSafetyNet.LifecycleExpiryDays);
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

        var applied = await NewInitializer(silo.Client, NewStatus(), longer).ApplyAsync();

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
    private static StorageOptions Resolve(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection().AddFileHolderStorageOptions(configuration);
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
    public void AnExpiryShorterThanBundlesCanLive_IsRefused()
    {
        var shorter = (StorageSafetyNet.LifecycleExpiryDays - 1).ToString(System.Globalization.CultureInfo.InvariantCulture);

        var resolve = () => Resolve(new() { ["Storage:LifecycleExpiryDays"] = shorter });

        resolve.Should().Throw<OptionsValidationException>().WithMessage("*Storage:LifecycleExpiryDays*still live*");
    }
}
