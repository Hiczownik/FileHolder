using System.Globalization;
using FileHolder.Api.Validation;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Health;

/// <summary>
/// How full the global storage quota is (<see cref="StorageQuota"/>). Degraded from
/// <see cref="HealthThresholds.StorageQuotaWarningShare"/> of it, a warning before presign starts refusing uploads;
/// downloads and uploads already started are unaffected, so never Unhealthy. Healthy, with the bytes in use, when no
/// quota is set. Its data becomes the fileholder_storage_used_bytes and fileholder_storage_quota_bytes metrics.
/// </summary>
public sealed class StorageQuotaHealthCheck(
    AppDbContext dbContext,
    IOptions<UploadLimitsOptions> uploadLimits,
    ProbeCache<StorageUsage> cache) : IHealthCheck
{
    public const string UsedBytesKey = "usedBytes";
    public const string QuotaBytesKey = "quotaBytes";

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        StorageUsage usage;
        try
        {
            usage = await cache.GetAsync(ct => StorageUsageQuery.ReadAsync(dbContext, ct), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // As the purge backlog check: the database check reports the database itself.
            return HealthCheckResult.Degraded("Storage use can't be read.", ex);
        }

        var used = BundleRules.FormatSize(usage.BytesInUse);
        var data = new Dictionary<string, object> { [UsedBytesKey] = usage.BytesInUse };
        if (uploadLimits.Value.GlobalQuotaBytes is not { } quota)
        {
            return HealthCheckResult.Healthy($"No storage quota set; {used} in use.", data);
        }

        data[QuotaBytesKey] = quota;
        var share = (double)usage.BytesInUse / quota;
        var description = string.Create(CultureInfo.InvariantCulture,
            $"{used} of the {BundleRules.FormatSize(quota)} storage quota in use ({share:0%}).");
        return share >= HealthThresholds.StorageQuotaWarningShare
            ? HealthCheckResult.Degraded($"{description} New uploads are refused once it's full.", data: data)
            : HealthCheckResult.Healthy(description, data);
    }
}
