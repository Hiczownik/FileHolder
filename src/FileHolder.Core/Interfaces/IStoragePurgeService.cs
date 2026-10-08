namespace FileHolder.Core.Interfaces;

public interface IStoragePurgeService
{
    Task<int> PurgeExpiredFilesAsync(CancellationToken ct = default);
}