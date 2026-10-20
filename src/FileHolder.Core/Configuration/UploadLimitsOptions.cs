using System.ComponentModel.DataAnnotations;

namespace FileHolder.Core.Configuration;

/// <summary>
/// Size limits on what one presign may approve. Upload URLs are signed for the declared sizes, so these
/// also bound how much an uploader can put into storage before confirm.
/// </summary>
public class UploadLimitsOptions
{
    public const string SectionName = "UploadLimits";

    /// <summary>
    /// Applies to encrypted bundles too, measured before encryption. Browsers encrypt and decrypt them a chunk at a
    /// time, so file size no longer depends on the recipient's memory. Keep in sync with STANDARD_MAX_TOTAL_BYTES
    /// in the UI.
    /// </summary>
    [Range(1, long.MaxValue)]
    public long MaxBundleSizeBytes { get; set; } = 5L * 1024 * 1024 * 1024; // 5 GB
}
