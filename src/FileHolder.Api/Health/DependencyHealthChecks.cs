using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Health;

/// <summary>
/// Postgres answers, and every migration is applied (the API applies them at start, so a pending one means this
/// build expects a schema the database doesn't have). Unhealthy otherwise: no upload or download works without it.
/// </summary>
public sealed class DatabaseHealthCheck(AppDbContext dbContext, ProbeCache<int> pendingMigrations) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(HealthThresholds.DependencyProbeTimeout);
        try
        {
            if (!await dbContext.Database.CanConnectAsync(timeout.Token))
            {
                return HealthCheckResult.Unhealthy("The database can't be reached.");
            }

            var pending = await pendingMigrations.GetAsync(
                async ct => (await dbContext.Database.GetPendingMigrationsAsync(ct)).Count(), timeout.Token);
            return pending == 0
                ? HealthCheckResult.Healthy("Connected; every migration is applied.")
                : HealthCheckResult.Unhealthy($"{pending} database migration(s) not applied.");
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            return HealthCheckResult.Unhealthy($"The database didn't answer within {HealthThresholds.DependencyProbeTimeout.TotalSeconds:0} s.", ex);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return HealthCheckResult.Unhealthy("The database can't be reached.", ex);
        }
    }
}

/// <summary>
/// The API's own storage client can reach the bucket (HeadBucket). Unhealthy otherwise: uploads, downloads and the
/// purge all go through it.
/// </summary>
public sealed class StorageHealthCheck(
    [FromKeyedServices("InternalS3")] IAmazonS3 s3Client,
    IOptions<StorageOptions> storageOptions) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(HealthThresholds.DependencyProbeTimeout);
        try
        {
            await s3Client.HeadBucketAsync(new HeadBucketRequest { BucketName = storageOptions.Value.BucketName }, timeout.Token);
            return HealthCheckResult.Healthy("The bucket is reachable.");
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return HealthCheckResult.Unhealthy("The bucket doesn't exist.", ex);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            return HealthCheckResult.Unhealthy($"Storage didn't answer within {HealthThresholds.DependencyProbeTimeout.TotalSeconds:0} s.", ex);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return HealthCheckResult.Unhealthy("Storage can't be reached.", ex);
        }
    }
}
