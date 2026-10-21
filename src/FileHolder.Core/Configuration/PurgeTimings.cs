namespace FileHolder.Core.Configuration;

public static class PurgeTimings
{
    /// <summary>
    /// How often the purge worker deletes expired bundles' files and abandoned uploads. Anything due waits at most
    /// this long, which the storage safety net allows for (<see cref="StorageSafetyNet"/>).
    /// </summary>
    public static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(30);
}
