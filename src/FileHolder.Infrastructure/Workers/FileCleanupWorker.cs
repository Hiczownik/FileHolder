using FileHolder.Core.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Workers;

public class FileCleanupWorker(IServiceProvider serviceProvider, ILogger<FileCleanupWorker> logger)
    : BackgroundService
{
    private readonly TimeSpan _checkInterval = TimeSpan.FromMinutes(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("File Cleanup Background Worker started. Interval: {Interval} mins.", _checkInterval.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = serviceProvider.CreateScope();
                var storageService = scope.ServiceProvider.GetRequiredService<IStoragePurgeService>();

                int purgedCount = await storageService.PurgeExpiredFilesAsync(stoppingToken);

                if (purgedCount > 0)
                {
                    logger.LogInformation("Successfully purged {Count} expired file records and storage blobs.",
                        purgedCount);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "An error occurred while executing the file cleanup background task.");
            }

            await Task.Delay(_checkInterval, stoppingToken);
        }
    }
}