namespace FileHolder.Core.Configuration;

public static class PurgeTimings
{
    /// <summary>
    /// How often the purge worker deletes expired bundles' files and abandoned uploads. Anything due waits at most
    /// this long, which the storage safety net allows for (<see cref="StorageSafetyNet"/>).
    /// </summary>
    public static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(30);

    /// <summary>
    /// How long a purged bundle's tombstone (its row with every detail cleared) is kept, so its link still says
    /// "expired" rather than "not found". After that the row is deleted.
    /// </summary>
    public static readonly TimeSpan PurgedGroupRetention = TimeSpan.FromDays(7);

    /// <summary>
    /// Completed or aborted multipart sessions are never read again; their rows are deleted this long after.
    /// </summary>
    public static readonly TimeSpan FinishedUploadSessionRetention = TimeSpan.FromDays(1);
}
