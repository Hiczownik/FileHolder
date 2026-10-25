using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace FileHolder.Api.Health;

public static class HealthCheckNames
{
    public const string Database = "database";
    public const string Storage = "storage";
    public const string StorageLifecycle = "storage_lifecycle";
    public const string PurgeWorker = "purge_worker";
    public const string PurgeBacklog = "purge_backlog";
    public const string StorageQuota = "storage_quota";
}

public static class HealthCheckRegistration
{
    /// <summary>
    /// The readiness checks behind /healthz/ready (see HealthEndpoints), and their metrics. Database and storage
    /// problems are Unhealthy (503); purge problems and a nearly full storage quota only Degraded (200), since uploads
    /// and downloads still work.
    /// </summary>
    public static IServiceCollection AddFileHolderHealthChecks(this IServiceCollection services)
    {
        services.AddSingleton<PurgeWorkerStatus>();
        services.AddSingleton<ProbeCache<int>>();
        services.AddSingleton<ProbeCache<PurgeBacklog>>();
        services.AddSingleton<ProbeCache<StorageUsage>>();
        services.AddSingleton<HealthMetrics>();
        services.AddSingleton<IHealthCheckPublisher>(sp => sp.GetRequiredService<HealthMetrics>());

        services.AddHealthChecks()
            .AddCheck<DatabaseHealthCheck>(HealthCheckNames.Database)
            .AddCheck<StorageHealthCheck>(HealthCheckNames.Storage)
            .AddCheck<StorageLifecycleHealthCheck>(HealthCheckNames.StorageLifecycle)
            .AddCheck<PurgeWorkerHealthCheck>(HealthCheckNames.PurgeWorker)
            .AddCheck<PurgeBacklogHealthCheck>(HealthCheckNames.PurgeBacklog)
            .AddCheck<StorageQuotaHealthCheck>(HealthCheckNames.StorageQuota);
        return services;
    }
}
