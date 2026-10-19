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
    /// AES-GCM adds a 12-byte IV and a 16-byte tag to each encrypted file.
    /// </summary>
    public const long EncryptionOverheadBytes = 12 + 16;

    [Range(1, long.MaxValue)]
    public long MaxBundleSizeBytes { get; set; } = 5L * 1024 * 1024 * 1024; // 5 GB

    /// <summary>
    /// Caps each file of an encrypted bundle (before encryption). Browsers encrypt and decrypt a whole file in
    /// memory, so a recipient couldn't open much larger ones. Keep in sync with E2EE_MAX_SINGLE_FILE_BYTES in the UI.
    /// </summary>
    [Range(1, long.MaxValue)]
    public long MaxEncryptedFileSizeBytes { get; set; } = 1L * 1024 * 1024 * 1024; // 1 GB
}
