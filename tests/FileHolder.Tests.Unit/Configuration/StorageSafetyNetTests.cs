using FileHolder.Core.Configuration;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Configuration;

public class StorageSafetyNetTests
{
    [Fact]
    public void MaxObjectAge_FromTodaysTimings_IsAbout192Hours40Minutes()
    {
        // 24 h unconfirmed + 168 h bundle + 10 min grace for running downloads + 30 min until the purge runs.
        StorageSafetyNet.CurrentMaxObjectAge.Should().Be(TimeSpan.FromHours(192) + TimeSpan.FromMinutes(40));
    }

    [Fact]
    public void LifecycleExpiryDays_FromTodaysTimings_Is10()
    {
        StorageSafetyNet.LifecycleExpiryDays.Should().Be(10);
    }

    [Fact]
    public void LifecycleExpiry_AlwaysLeavesAtLeastTheMarginAboveTheOldestLegitimateObject()
    {
        TimeSpan.FromDays(StorageSafetyNet.LifecycleExpiryDays)
            .Should().BeGreaterThanOrEqualTo(StorageSafetyNet.CurrentMaxObjectAge + StorageSafetyNet.Margin);
    }

    [Fact]
    public void ALongerMaximumBundleLifetime_RaisesTheRule()
    {
        // Two weeks instead of one.
        var age = StorageSafetyNet.MaxObjectAge(
            UploadTimings.PendingUploadLifetime,
            TimeSpan.FromHours(336),
            DownloadTimings.StorageDeletionGracePeriod,
            PurgeTimings.CheckInterval);

        StorageSafetyNet.LifecycleExpiryDaysFor(age).Should().Be(17);
    }

    [Fact]
    public void ADemoWithBundlesOfAtMost24Hours_KeepsObjectsAtMost4Days()
    {
        // 24 h unconfirmed + 24 h bundle + 10 min + 30 min = 48 h 40 min, plus the 24 h margin: just over 3 days.
        StorageSafetyNet.LifecycleExpiryDaysForMaxExpiry(TimeSpan.FromHours(24)).Should().Be(4);
    }

    [Fact]
    public void TheLongestExpiryAllowed_GivesTodaysRule()
    {
        StorageSafetyNet.LifecycleExpiryDaysForMaxExpiry(BundleLimits.MaxExpiry).Should().Be(StorageSafetyNet.LifecycleExpiryDays);
    }

    [Fact]
    public void EveryAllowedMaximumExpiry_LeavesTheMarginAboveTheOldestLegitimateObject()
    {
        for (var hours = BundleLimits.MinExpiryHours; hours <= BundleLimits.MaxExpiryHours; hours++)
        {
            var maxExpiry = TimeSpan.FromHours(hours);
            TimeSpan.FromDays(StorageSafetyNet.LifecycleExpiryDaysForMaxExpiry(maxExpiry))
                .Should().BeGreaterThanOrEqualTo(StorageSafetyNet.MaxObjectAgeForMaxExpiry(maxExpiry) + StorageSafetyNet.Margin, $"for {hours} h");
        }
    }

    // Age plus the 24 h margin, rounded up to whole days.
    [Theory]
    [InlineData(0, 1)]   // 24 h: exactly one day
    [InlineData(1, 2)]   // 25 h: into a second day
    [InlineData(24, 2)]  // 48 h: exactly two days, not rounded past them
    [InlineData(25, 3)]  // 49 h: into a third day
    public void LifecycleExpiryDays_RoundUpToWholeDays(int ageHours, int expectedDays)
    {
        StorageSafetyNet.LifecycleExpiryDaysFor(TimeSpan.FromHours(ageHours)).Should().Be(expectedDays);
    }

    [Fact]
    public void AbandonedUploads_AreKeptLongerThanAnyUploadThatCanStillBeConfirmed()
    {
        // 24 h to confirm + 1 h before the purge deletes + 30 min until it runs.
        StorageSafetyNet.CurrentMaxUnconfirmedUploadAge.Should().Be(TimeSpan.FromHours(25.5));
        StorageSafetyNet.AbandonedUploadDays.Should().Be(2);
        TimeSpan.FromDays(StorageSafetyNet.AbandonedUploadDays).Should().BeGreaterThan(StorageSafetyNet.CurrentMaxUnconfirmedUploadAge);
    }

    [Fact]
    public void TheStorageServersStaleUploadExpiry_InCompose_CoversUnconfirmedUploads()
    {
        // docker-compose.yml sets MINIO_API_STALE_UPLOADS_EXPIRY to 48h: Silo ignores the lifecycle rule's abort
        // part, so this is what removes abandoned multipart uploads there. It must not cut off a legitimate one.
        TimeSpan.FromHours(48).Should().BeGreaterThan(StorageSafetyNet.CurrentMaxUnconfirmedUploadAge);
    }

    [Fact]
    public void BundleLimits_MaxExpiryMatchesItsHours()
    {
        BundleLimits.MaxExpiry.Should().Be(TimeSpan.FromHours(BundleLimits.MaxExpiryHours));
    }
}
