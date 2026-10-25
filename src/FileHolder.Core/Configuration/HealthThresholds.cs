namespace FileHolder.Core.Configuration;

/// <summary>
/// When the readiness checks (/healthz/ready) call the purge Degraded, and how long their probes may take.
/// </summary>
public static class HealthThresholds
{
    /// <summary>
    /// A bundle that has been due for purge this long but still holds its files means the purge isn't keeping up,
    /// e.g. because deleting some of them keeps failing (#50). Several purge runs fit in this time.
    /// </summary>
    public static readonly TimeSpan PurgeOverdueAfter = TimeSpan.FromHours(2);

    /// <summary>No successful purge run for this long, two of its intervals, means the worker is stuck or failing.</summary>
    public static readonly TimeSpan PurgeWorkerStaleAfter = PurgeTimings.CheckInterval * 2;

    /// <summary>The purge backlog query and the pending-migrations check answer from a result at most this old.</summary>
    public static readonly TimeSpan ProbeCacheDuration = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The longest the database or storage check waits. Below the compose health check's own 5 s timeout, so a
    /// hanging dependency is reported as Unhealthy rather than as a probe that never answered.
    /// </summary>
    public static readonly TimeSpan DependencyProbeTimeout = TimeSpan.FromSeconds(2);

    /// <summary>The share of the global storage quota in use from which the quota check warns (Degraded).</summary>
    public const double StorageQuotaWarningShare = 0.8;
}
