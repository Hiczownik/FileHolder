using System.ComponentModel.DataAnnotations;

namespace FileHolder.Core.Configuration;

/// <summary>
/// Limits on what one presign may approve. Upload URLs are signed for the declared sizes, so these also bound how
/// much an uploader can put into storage before confirm. A public demo runs with smaller values than these
/// defaults (docs/development.md, Configuration). The UI reads them from GET /api/v1/files/limits.
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

    /// <summary>
    /// The largest bundle an upload without an access code may have (#169). With <see cref="WithoutCodeMaxExpiryHours"/>
    /// it turns access codes on: uploads without a valid code get these smaller limits, uploads with one get
    /// <see cref="MaxBundleSizeBytes"/> and <see cref="MaxExpiryHours"/>. Unset (the default), every upload gets those.
    /// </summary>
    [Range(1, long.MaxValue)]
    public long? WithoutCodeMaxBundleSizeBytes { get; set; }

    /// <summary>The longest an upload without an access code may live. Set together with <see cref="WithoutCodeMaxBundleSizeBytes"/>.</summary>
    [Range(BundleLimits.MinExpiryHours, BundleLimits.MaxExpiryHours)]
    public int? WithoutCodeMaxExpiryHours { get; set; }

    /// <summary>Whether uploads without an access code get smaller limits (both WithoutCode settings are set).</summary>
    public bool AccessCodesEnabled => WithoutCodeMaxBundleSizeBytes.HasValue && WithoutCodeMaxExpiryHours.HasValue;

    /// <summary>
    /// The WithoutCode settings are both set or both unset, and no larger than the limits a code unlocks: a smaller
    /// tier that allowed more would make codes pointless.
    /// </summary>
    public bool WithoutCodeSettingsAreValid() =>
        WithoutCodeMaxBundleSizeBytes.HasValue == WithoutCodeMaxExpiryHours.HasValue
        && (!AccessCodesEnabled
            || (WithoutCodeMaxBundleSizeBytes <= MaxBundleSizeBytes && WithoutCodeMaxExpiryHours <= MaxExpiryHours));

    /// <summary>The limits for an upload without an access code; the same limits when codes are off.</summary>
    public UploadLimitsOptions WithoutCode() => AccessCodesEnabled
        ? new UploadLimitsOptions
        {
            MaxBundleSizeBytes = WithoutCodeMaxBundleSizeBytes!.Value,
            MaxExpiryHours = WithoutCodeMaxExpiryHours!.Value,
            GlobalQuotaBytes = GlobalQuotaBytes,
        }
        : this;
}
