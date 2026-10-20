namespace FileHolder.Core.Configuration;

/// <summary>
/// Lifetimes that govern how long a recipient can keep fetching files after a download is counted,
/// and therefore how long storage objects must outlive the group's last download.
/// </summary>
public static class DownloadTimings
{
    /// <summary>
    /// How long one counted download (a download session) can keep requesting file URLs, though never past the
    /// group's own expiry. Long enough for a 5 GB bundle on a slow connection, and for retrying after a dropped
    /// connection without counting another download. Holding a session lets its holder fetch the files again
    /// meanwhile, so this is also the cap on that.
    /// </summary>
    public static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(6);

    /// <summary>
    /// Validity of a presigned GET URL handed out within a session.
    /// </summary>
    public static readonly TimeSpan PresignedUrlLifetime = TimeSpan.FromMinutes(5);

    /// <summary>
    /// How long storage outlives both the group closing and its last download session ending: a URL issued just
    /// before either stays valid for its own lifetime (plus a safety margin). The purge also checks the sessions
    /// themselves, so a download that runs for hours is never cut off part way.
    /// </summary>
    public static readonly TimeSpan StorageDeletionGracePeriod = PresignedUrlLifetime + TimeSpan.FromMinutes(5);

    /// <summary>
    /// Expired session rows are kept this long before the purge worker removes them.
    /// </summary>
    public static readonly TimeSpan ExpiredSessionRetention = TimeSpan.FromDays(1);
}
