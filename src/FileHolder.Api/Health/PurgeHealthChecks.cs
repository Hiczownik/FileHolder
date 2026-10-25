using System.Globalization;
using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

// The checks on deleting what has expired. A lagging purge doesn't stop uploads or downloads, so these are Degraded
// at worst (still a 200): they show in the response and the metrics, but never fail readiness.
namespace FileHolder.Api.Health;

internal static class Ages
{
    /// <summary>"40 min" or "5 h", for descriptions.</summary>
    public static string Describe(TimeSpan age) => age < TimeSpan.FromHours(1)
        ? $"{Math.Max(0, (int)age.TotalMinutes)} min"
        : $"{(int)age.TotalHours} h";
}

/// <summary>
/// Storage has confirmed the lifecycle safety net's rule (#69), as recorded at start; no storage call per probe.
/// Healthy when the rule is managed outside the app, a deliberate setup the API can't check, with the values it
/// should have, so a reader can compare them with the provider's dashboard.
/// </summary>
public sealed class StorageLifecycleHealthCheck(StorageLifecycleStatus status, IOptions<StorageOptions> storageOptions) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var expected = storageOptions.Value.EffectiveLifecycleExpiryDays;
        if (storageOptions.Value.LifecycleRule == LifecycleRuleMode.External)
        {
            return Task.FromResult(HealthCheckResult.Healthy(
                $"Managed outside the app (Storage:LifecycleRule=External); expected: objects deleted after {expected} days, " +
                $"unfinished uploads aborted after {StorageSafetyNet.AbandonedUploadDays} days."));
        }

        var result = status.ConfirmedExpiryDays == expected
            ? HealthCheckResult.Healthy($"Storage deletes any object after {expected} days.")
            : HealthCheckResult.Degraded("Storage hasn't confirmed the lifecycle safety net yet.");
        return Task.FromResult(result);
    }
}

/// <summary>The purge worker has completed a run within <see cref="HealthThresholds.PurgeWorkerStaleAfter"/>.</summary>
public sealed class PurgeWorkerHealthCheck(PurgeWorkerStatus status) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var sinceSuccess = status.TimeSinceLastSuccess;
        var data = new Dictionary<string, object> { ["secondsSinceLastSuccess"] = (long)sinceSuccess.TotalSeconds };
        if (sinceSuccess > HealthThresholds.PurgeWorkerStaleAfter)
        {
            var lastFailure = status.LastFailure is null ? "" : $" Last failure: {status.LastFailure}.";
            var since = status.LastSuccessAt is null ? $"since start, {Ages.Describe(sinceSuccess)} ago" : $"for {Ages.Describe(sinceSuccess)}";
            return Task.FromResult(HealthCheckResult.Degraded($"No successful purge run {since}.{lastFailure}", data: data));
        }

        var description = status.LastSuccessAt is null
            ? "Waiting for the first purge run."
            : $"Last purge run succeeded {Ages.Describe(sinceSuccess)} ago.";
        return Task.FromResult(HealthCheckResult.Healthy(description, data));
    }
}

/// <summary>
/// No bundle has been due for purge longer than <see cref="HealthThresholds.PurgeOverdueAfter"/> while still holding
/// its files. Catches a purge that runs but can't delete some groups (#50), which the worker check can't see.
/// </summary>
public sealed class PurgeBacklogHealthCheck(
    AppDbContext dbContext,
    IDateTimeProvider dateTimeProvider,
    ProbeCache<PurgeBacklog> cache) : IHealthCheck
{
    public const string OverdueGroupsKey = "overdueGroups";

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        PurgeBacklog backlog;
        try
        {
            backlog = await cache.GetAsync(ct => PurgeBacklogQuery.ReadAsync(dbContext, dateTimeProvider, ct), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Caught here rather than left to the health check service, which would make this Unhealthy and put the
            // exception's message in the response. The database check reports the database itself.
            return HealthCheckResult.Degraded("The purge backlog can't be read.", ex);
        }

        var data = new Dictionary<string, object> { [OverdueGroupsKey] = backlog.OverdueGroups };
        if (backlog.OverdueGroups == 0)
        {
            return HealthCheckResult.Healthy("No bundle is overdue for purge.", data);
        }

        var count = backlog.OverdueGroups.ToString(CultureInfo.InvariantCulture);
        var oldest = backlog.OldestOverdueSince is { } since
            ? $", the oldest expired or closed {Ages.Describe(dateTimeProvider.UtcNow - since)} ago"
            : "";
        return HealthCheckResult.Degraded($"{count} bundle(s) overdue for purge{oldest}.", data: data);
    }
}
