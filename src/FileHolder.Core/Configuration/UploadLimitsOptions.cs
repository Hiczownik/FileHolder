using System.ComponentModel.DataAnnotations;

namespace FileHolder.Core.Configuration;

/// <summary>
/// Limits on what one presign may approve. Upload URLs are signed for the declared sizes, so these also bound how
/// much an uploader can put into storage before confirm. A public demo runs with smaller values than these
/// defaults (README, Configuration). The UI reads them from GET /api/v1/files/limits.
/// </summary>
public class UploadLimitsOptions
{
    public const string SectionName = "UploadLimits";

    /// <summary>
    /// Applies to encrypted bundles too, measured before encryption. Browsers encrypt and decrypt them a chunk at a
    /// time, so file size no longer depends on the recipient's memory.
    /// </summary>
    [Range(1, long.MaxValue)]
    public long MaxBundleSizeBytes { get; set; } = 5L * 1024 * 1024 * 1024; // 5 GB

    /// <summary>
    /// The longest a bundle may be set to live, up to <see cref="BundleLimits.MaxExpiryHours"/>. Lowering it also
    /// shortens the storage safety net (<see cref="StorageSafetyNet.LifecycleExpiryDaysForMaxExpiry"/>).
    /// </summary>
    [Range(BundleLimits.MinExpiryHours, BundleLimits.MaxExpiryHours)]
    public int MaxExpiryHours { get; set; } = BundleLimits.MaxExpiryHours;

    /// <summary>
    /// The most storage all bundles and pending uploads may take up together; presign refuses a bundle that would go
    /// past it (503, Retry-After). Unset, there is no quota. Counted from declared sizes, so a soft cap (StorageQuota).
    /// </summary>
    [Range(1, long.MaxValue)]
    public long? GlobalQuotaBytes { get; set; }
}
