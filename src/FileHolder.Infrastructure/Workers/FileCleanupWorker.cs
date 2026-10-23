using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Workers;

public class FileCleanupWorker(IServiceProvider serviceProvider, PurgeWorkerStatus status, ILogger<FileCleanupWorker> logger)
    : BackgroundService
{
    private readonly TimeSpan _checkInterval = PurgeTimings.CheckInterval;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("File Cleanup Background Worker started. Interval: {Interval} mins.", _checkInterval.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            // Each run is a trace of its own, with the purge's steps, queries and storage calls inside.
            using (var activity = FileHolderTracing.StartRoot("purge.run"))
            {
                try
                {
                    using var scope = serviceProvider.CreateScope();
                    var storageService = scope.ServiceProvider.GetRequiredService<IStoragePurgeService>();

                    int purgedCount = await storageService.PurgeExpiredFilesAsync(stoppingToken);
                    activity?.SetTag("fileholder.purge.purged_group_count", purgedCount);

                    if (purgedCount > 0)
                    {
                        logger.LogInformation("Successfully purged {Count} expired file records and storage blobs.",
                            purgedCount);
                    }

                    status.RecordSuccess();
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    // Shutting down: not a failed run.
                    return;
                }
                catch (Exception ex)
                {
                    activity.RecordFailure(ex);
                    status.RecordFailure(ex);
                    logger.LogError(ex, "An error occurred while executing the file cleanup background task.");
                }
            }

            await Task.Delay(_checkInterval, stoppingToken);
        }
    }
}