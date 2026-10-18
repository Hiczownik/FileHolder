namespace FileHolder.Core.Configuration;

/// <summary>
/// Lifetimes that govern how long an uploader has between presign and confirm.
/// </summary>
public static class UploadTimings
{
    /// <summary>
    /// How long presigned uploads may stay unconfirmed. Multipart sessions share this lifetime,
    /// since a large upload can take hours.
    /// </summary>
    public static readonly TimeSpan PendingUploadLifetime = TimeSpan.FromHours(24);

    /// <summary>
    /// Confirm rejects expired pending uploads, while the purge waits this much longer before deleting
    /// their objects, so a confirm that passed the expiry check can never race the purge.
    /// </summary>
    public static readonly TimeSpan PendingUploadPurgeGrace = TimeSpan.FromHours(1);
}
