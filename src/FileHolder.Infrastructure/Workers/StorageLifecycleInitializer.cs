using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FileHolder.Infrastructure.Workers;

/// <summary>The safety net's rule as storage kept it, read back after it was put in place.</summary>
public sealed record AppliedLifecycleRule(int? ExpiryDays, int? AbortIncompleteUploadDays);

/// <summary>
/// Puts the storage safety net in place at startup: a bucket lifecycle rule that deletes any object older than the
/// app could ever keep one (<see cref="StorageSafetyNet"/>). The purge worker stays the main mechanism; this only
/// catches what it misses. Runs in the background and retries until storage answers, so startup never waits on it.
/// With <see cref="LifecycleRuleMode.External"/> it makes no storage call and only logs the rule's expected values.
/// </summary>
public sealed class StorageLifecycleInitializer(
    [FromKeyedServices("InternalS3")] IAmazonS3 s3Client,
    IOptions<StorageOptions> options,
    StorageLifecycleStatus status,
    ILogger<StorageLifecycleInitializer> logger)
    : BackgroundService
{
    private static readonly TimeSpan FirstRetryDelay = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaxRetryDelay = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var expectedDays = options.Value.EffectiveLifecycleExpiryDays;
        if (options.Value.LifecycleRule == LifecycleRuleMode.External)
        {
            status.MarkExternal();
            logger.LogInformation(
                "Storage lifecycle rule is managed outside the app (Storage:LifecycleRule=External). It should delete " +
                "objects after {Days} days and abort incomplete multipart uploads after {AbortDays} days.",
                expectedDays, StorageSafetyNet.AbandonedUploadDays);
            return;
        }

        var delay = FirstRetryDelay;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var applied = await ApplyAsync(stoppingToken);
                if (applied.ExpiryDays == expectedDays)
                {
                    status.Confirm(expectedDays);
                    logger.LogInformation(
                        "Storage lifecycle safety net in place on {Bucket}: objects are deleted after {Days} days.",
                        options.Value.BucketName, expectedDays);
                    LogAbortIncompleteOutcome(applied);
                    return;
                }

                logger.LogError(
                    "Storage kept the lifecycle rule with {ActualDays} expiry days instead of {ExpectedDays}; retrying in {Delay}.",
                    applied.ExpiryDays?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "no", expectedDays, delay);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Could not put the storage lifecycle safety net in place yet; retrying in {Delay}.", delay);
            }

            await Task.Delay(delay, stoppingToken);
            delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, MaxRetryDelay.Ticks));
        }
    }

    /// <summary>
    /// Replaces the bucket's lifecycle configuration with the safety net's rule, then reads back what storage kept.
    /// Applying it again changes nothing. The bucket holds only this app's objects, so no other rule is lost.
    /// </summary>
    public async Task<AppliedLifecycleRule> ApplyAsync(CancellationToken ct = default)
    {
        var bucket = options.Value.BucketName;
        await s3Client.PutLifecycleConfigurationAsync(new PutLifecycleConfigurationRequest
        {
            BucketName = bucket,
            Configuration = new LifecycleConfiguration
            {
                Rules =
                [
                    new LifecycleRule
                    {
                        Id = StorageSafetyNet.LifecycleRuleId,
                        Status = LifecycleRuleStatus.Enabled,
                        Filter = new LifecycleFilter { Prefix = string.Empty },
                        Expiration = new LifecycleRuleExpiration { Days = options.Value.EffectiveLifecycleExpiryDays },
                        // Honoured by AWS S3; Silo drops it and relies on its stale-upload clean-up instead.
                        AbortIncompleteMultipartUpload = new LifecycleRuleAbortIncompleteMultipartUpload
                        {
                            DaysAfterInitiation = StorageSafetyNet.AbandonedUploadDays,
                        },
                    },
                ],
            },
        }, ct);

        var response = await s3Client.GetLifecycleConfigurationAsync(new GetLifecycleConfigurationRequest { BucketName = bucket }, ct);
        var rule = response?.Configuration?.Rules?.FirstOrDefault(r => r.Id == StorageSafetyNet.LifecycleRuleId);
        return new AppliedLifecycleRule(rule?.Expiration?.Days, rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation);
    }

    private void LogAbortIncompleteOutcome(AppliedLifecycleRule applied)
    {
        if (applied.AbortIncompleteUploadDays is { } days)
        {
            logger.LogInformation("Storage also aborts incomplete multipart uploads after {Days} days.", days);
            return;
        }

        logger.LogInformation(
            "Storage kept no abort-incomplete-uploads part of the rule (Silo drops it). Abandoned multipart uploads rely " +
            "on the storage server's stale-upload clean-up, which must stay above {Hours} hours (MINIO_API_STALE_UPLOADS_EXPIRY).",
            Math.Ceiling(StorageSafetyNet.CurrentMaxUnconfirmedUploadAge.TotalHours));
    }
}
