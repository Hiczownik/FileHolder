namespace FileHolder.Core.Configuration;

/// <summary>
/// The storage-level backstop behind the purge worker: a bucket lifecycle rule that deletes any object older than
/// the app could ever keep one, so files are gone even if the purge is stuck, crashes or has a bug. Sized from the
/// app's own timings, so changing one moves the rule with it.
/// </summary>
public static class StorageSafetyNet
{
    /// <summary>The ID of the bucket lifecycle rule the API puts in place.</summary>
    public const string LifecycleRuleId = "fileholder-safety-net";

    /// <summary>Added on top of the oldest a legitimate object can get, so the rule never races the purge.</summary>
    public static readonly TimeSpan Margin = TimeSpan.FromDays(1);

    /// <summary>
    /// The oldest a legitimate object can get, counted from the start of its upload: the longest an upload may stay
    /// unconfirmed, then the longest a bundle may live (a download session never outlasts the bundle's expiry), then
    /// the grace the purge leaves for downloads still running, then the wait for the purge's next run.
    /// </summary>
    public static TimeSpan MaxObjectAge(TimeSpan pendingUploadLifetime, TimeSpan maxBundleLifetime, TimeSpan deletionGrace, TimeSpan purgeInterval) =>
        pendingUploadLifetime + maxBundleLifetime + deletionGrace + purgeInterval;

    /// <summary>The oldest an upload that was never confirmed can get before the purge deletes or aborts it.</summary>
    public static TimeSpan MaxUnconfirmedUploadAge(TimeSpan pendingUploadLifetime, TimeSpan pendingUploadPurgeGrace, TimeSpan purgeInterval) =>
        pendingUploadLifetime + pendingUploadPurgeGrace + purgeInterval;

    /// <summary>Lifecycle rules count whole days: the fewest days that still cover <paramref name="age"/> plus the margin.</summary>
    public static int LifecycleExpiryDaysFor(TimeSpan age) => (int)Math.Ceiling((age + Margin).TotalDays);

    /// <summary>The fewest whole days that cover an unconfirmed upload's lifetime.</summary>
    public static int AbandonedUploadDaysFor(TimeSpan age) => (int)Math.Ceiling(age.TotalDays);

    /// <summary>The oldest a legitimate object can get with today's timings, when bundles live at most <paramref name="maxExpiry"/>.</summary>
    public static TimeSpan MaxObjectAgeForMaxExpiry(TimeSpan maxExpiry) => MaxObjectAge(
        UploadTimings.PendingUploadLifetime,
        maxExpiry,
        DownloadTimings.StorageDeletionGracePeriod,
        PurgeTimings.CheckInterval);

    /// <summary>Days after which storage deletes any object, when bundles live at most <paramref name="maxExpiry"/>: 4 for 24 h.</summary>
    public static int LifecycleExpiryDaysForMaxExpiry(TimeSpan maxExpiry) => LifecycleExpiryDaysFor(MaxObjectAgeForMaxExpiry(maxExpiry));

    /// <summary>≈ 192 h 40 min with today's timings and the longest expiry allowed (7 days).</summary>
    public static TimeSpan CurrentMaxObjectAge => MaxObjectAgeForMaxExpiry(BundleLimits.MaxExpiry);

    /// <summary>≈ 25 h 30 min with today's timings.</summary>
    public static TimeSpan CurrentMaxUnconfirmedUploadAge => MaxUnconfirmedUploadAge(
        UploadTimings.PendingUploadLifetime,
        UploadTimings.PendingUploadPurgeGrace,
        PurgeTimings.CheckInterval);

    /// <summary>Days after which storage deletes any object: 10 with today's timings and the longest expiry allowed.</summary>
    public static int LifecycleExpiryDays => LifecycleExpiryDaysFor(CurrentMaxObjectAge);

    /// <summary>
    /// Days after which storage may abort an incomplete multipart upload: 2 with today's timings. Silo drops this
    /// part of a lifecycle rule, so there its own stale-upload clean-up (MINIO_API_STALE_UPLOADS_EXPIRY, set to
    /// 48 h in docker-compose.yml) does the job; it must also stay above <see cref="CurrentMaxUnconfirmedUploadAge"/>.
    /// </summary>
    public static int AbandonedUploadDays => AbandonedUploadDaysFor(CurrentMaxUnconfirmedUploadAge);
}
