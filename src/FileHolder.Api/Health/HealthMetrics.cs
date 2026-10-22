using System.Diagnostics.Metrics;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace FileHolder.Api.Health;

/// <summary>
/// Publishes the health checks as metrics on the metrics port, from the report the health check service produces
/// every 30 s: fileholder_health_status{check} (0 Unhealthy, 1 Degraded, 2 Healthy), fileholder_purge_overdue_groups
/// and fileholder_purge_last_success_age_seconds. A stuck purge (#50) then shows up in Prometheus, not just here.
/// </summary>
public sealed class HealthMetrics : IHealthCheckPublisher
{
    public const string StatusInstrument = "fileholder.health.status";
    public const string OverdueGroupsInstrument = "fileholder.purge.overdue_groups";
    public const string LastSuccessAgeInstrument = "fileholder.purge.last_success_age_seconds";

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

    /// <summary>None until the first report, rather than a 0 that would claim the backlog is known to be empty.</summary>
    private static IEnumerable<Measurement<int>> OverdueGroups(HealthReport? report) =>
        report is not null
        && report.Entries.TryGetValue(HealthCheckNames.PurgeBacklog, out var entry)
        && entry.Data.TryGetValue(PurgeBacklogHealthCheck.OverdueGroupsKey, out var value)
        && value is int count
            ? [new Measurement<int>(count)]
            : [];
}
