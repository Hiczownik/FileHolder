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

    /// <summary>
    /// Validity of a single-file presigned PUT URL. Confirm serves a copy of such a file and leaves the
    /// uploaded original to the purge, which deletes it <see cref="PendingUploadPurgeGrace"/> after confirm.
    /// This must stay shorter than that grace, or the uploader could re-upload the original after the
    /// purge and leave an object nothing tracks.
    /// </summary>
    public static readonly TimeSpan SinglePutUrlLifetime = TimeSpan.FromMinutes(15);
}
