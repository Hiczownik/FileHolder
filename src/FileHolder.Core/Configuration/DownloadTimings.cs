namespace FileHolder.Core.Configuration;

/// <summary>
/// Lifetimes that govern how long a recipient can keep fetching files after a download is counted,
/// and therefore how long storage objects must outlive the group's last download.
/// </summary>
public static class DownloadTimings
{
    /// <summary>
    /// How long one counted download (a download session) can keep requesting file URLs.
    /// </summary>
    public static readonly TimeSpan SessionLifetime = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Validity of a presigned GET URL handed out within a session.
    /// </summary>
    public static readonly TimeSpan PresignedUrlLifetime = TimeSpan.FromMinutes(5);

    /// <summary>
    /// The last URL can be issued just before a session ends and stays valid for its own lifetime,
    /// so storage must not be purged before both have elapsed (plus a safety margin).
    /// </summary>
    public static readonly TimeSpan StorageDeletionGracePeriod =
        SessionLifetime + PresignedUrlLifetime + TimeSpan.FromMinutes(5);

    /// <summary>
    /// Expired session rows are kept this long before the purge worker removes them.
    /// </summary>
    public static readonly TimeSpan ExpiredSessionRetention = TimeSpan.FromDays(1);
}
