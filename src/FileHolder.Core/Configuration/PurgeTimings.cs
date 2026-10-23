namespace FileHolder.Core.Configuration;

public static class PurgeTimings
{
    /// <summary>
    /// How often the purge worker deletes expired bundles' files and abandoned uploads. Anything due waits at most
    /// this long, which the storage safety net allows for (<see cref="StorageSafetyNet"/>).
    /// </summary>
    public static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(30);

    /// <summary>
    /// How long one run keeps taking batches from each of its queues (expired multipart uploads, abandoned uploads,
    /// expired bundles) at most. A run keeps going while its batches come back full and get something done, so a
    /// backlog is cleared at once rather than one batch per <see cref="CheckInterval"/>: one batch of 500 abandoned
    /// uploads per half hour could not keep up once more than 1,000 files an hour were uploaded (load scenario 1,
    /// tests/load). A batch of 500 takes under half a second, so this clears a few hundred thousand, and the three
    /// queues together stay well inside the interval.
    /// </summary>
    public static readonly TimeSpan MaxQueueTimePerRun = TimeSpan.FromMinutes(2);

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
