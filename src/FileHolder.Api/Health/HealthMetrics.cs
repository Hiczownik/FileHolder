using System.Diagnostics.Metrics;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace FileHolder.Api.Health;

/// <summary>
/// Publishes the health checks as metrics on the metrics port, from the report the health check service produces
/// every 30 s: fileholder_health_status{check} (0 Unhealthy, 1 Degraded, 2 Healthy), fileholder_purge_overdue_groups,
/// fileholder_purge_last_success_age_seconds, and fileholder_storage_used_bytes and fileholder_storage_quota_bytes
/// (the latter only with a quota set). A stuck purge (#50) or a filling quota then shows up in Prometheus, not just here.
/// </summary>
public sealed class HealthMetrics : IHealthCheckPublisher
{
    public const string StatusInstrument = "fileholder.health.status";
    public const string OverdueGroupsInstrument = "fileholder.purge.overdue_groups";
    public const string LastSuccessAgeInstrument = "fileholder.purge.last_success_age_seconds";
    public const string StorageUsedInstrument = "fileholder.storage.used_bytes";
    public const string StorageQuotaInstrument = "fileholder.storage.quota_bytes";

    private HealthReport? _latest;

    public HealthMetrics(IMeterFactory meterFactory, PurgeWorkerStatus purgeWorkerStatus)
    {
        var meter = meterFactory.Create(StorageLifecycleStatus.MeterName);
        meter.CreateObservableGauge(
            StatusInstrument,
            () => Statuses(Volatile.Read(ref _latest)),
            description: "Each readiness check's status: 0 Unhealthy, 1 Degraded, 2 Healthy.");
        meter.CreateObservableGauge(
            OverdueGroupsInstrument,
            () => OverdueGroups(Volatile.Read(ref _latest)),
            description: "Bundles due for purge for over 2 hours that still hold their files.");
        meter.CreateObservableGauge(
            LastSuccessAgeInstrument,
            () => (long)purgeWorkerStatus.TimeSinceLastSuccess.TotalSeconds,
            unit: "s",
            description: "Seconds since the purge worker last completed a run (since start, before its first).");
        meter.CreateObservableGauge(
            StorageUsedInstrument,
            () => StorageQuotaData(Volatile.Read(ref _latest), StorageQuotaHealthCheck.UsedBytesKey),
            unit: "By",
            description: "Storage the bundles and pending uploads take up, from their declared sizes.");
        meter.CreateObservableGauge(
            StorageQuotaInstrument,
            () => StorageQuotaData(Volatile.Read(ref _latest), StorageQuotaHealthCheck.QuotaBytesKey),
            unit: "By",
            description: "The global storage quota (UploadLimits:GlobalQuotaBytes), when one is set.");
    }

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        Volatile.Write(ref _latest, report);
        return Task.CompletedTask;
    }

    private static IEnumerable<Measurement<int>> Statuses(HealthReport? report) =>
        report is null
            ? []
            : report.Entries.Select(entry =>
                new Measurement<int>(ToNumber(entry.Value.Status), new KeyValuePair<string, object?>("check", entry.Key)));

    private static int ToNumber(HealthStatus status) => status switch
    {
        HealthStatus.Healthy => 2,
        HealthStatus.Degraded => 1,
        _ => 0,
    };

    /// <summary>None until the first report (or without a quota), rather than a 0 that would claim to be known.</summary>
    private static IEnumerable<Measurement<long>> StorageQuotaData(HealthReport? report, string key) =>
        report is not null
        && report.Entries.TryGetValue(HealthCheckNames.StorageQuota, out var entry)
        && entry.Data.TryGetValue(key, out var value)
        && value is long bytes
            ? [new Measurement<long>(bytes)]
            : [];

    /// <summary>None until the first report, rather than a 0 that would claim the backlog is known to be empty.</summary>
    private static IEnumerable<Measurement<int>> OverdueGroups(HealthReport? report) =>
        report is not null
        && report.Entries.TryGetValue(HealthCheckNames.PurgeBacklog, out var entry)
        && entry.Data.TryGetValue(PurgeBacklogHealthCheck.OverdueGroupsKey, out var value)
        && value is int count
            ? [new Measurement<int>(count)]
            : [];
}
