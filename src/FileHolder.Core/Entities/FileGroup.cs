using FileHolder.Core.Security;

namespace FileHolder.Core.Entities;

public class FileGroup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ShareToken { get; set; } = string.Empty;
    /// <summary>The title of a plain bundle. Encrypted bundles never have one; see <see cref="EncryptedTitle"/>.</summary>
    public string? Title { get; set; }
    public string? PasswordHash { get; set; }
    public int? MaxDownloads { get; set; }
    public int DownloadCount { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public DateTime? StoragePurgedAt { get; set; }
    public bool IsEncrypted { get; set; }
    public string? EncryptedManifest { get; set; }
    public string? KeyEnvelope { get; set; }
    public string? KeySalt { get; set; }

    /// <summary>
    /// An encrypted bundle's title, encrypted in the browser with the bundle's master key like the manifest, so
    /// the server (and anyone with the link but not the passkey) never sees it. Only returned once unlocked.
    /// </summary>
    public string? EncryptedTitle { get; set; }

    /// <summary>
    /// How an encrypted bundle is unlocked. Null for plain bundles, and for encrypted bundles from before link keys,
    /// which the browser no longer opens.
    /// </summary>
    public KeyMode? KeyMode { get; set; }

    /// <summary>
    /// The Argon2id settings the uploader's browser stretched the passkey with (see
    /// <see cref="Configuration.KeyDerivationParams"/>). Only for <see cref="Entities.KeyMode.LinkKeyAndPasskey"/>
    /// bundles; stored per bundle so new uploads can use stronger settings without breaking older bundles.
    /// </summary>
    public string? KdfParams { get; set; }

    /// <summary>
    /// Wrong passwords since the last correct one. Past a few free attempts, each further one
    /// sets <see cref="PasswordLockedUntil"/>, during which every password is refused.
    /// </summary>
    public int FailedPasswordAttempts { get; set; }
    public DateTime? PasswordLockedUntil { get; set; }

    public ICollection<SharedFile> Files { get; set; } = new List<SharedFile>();

    /// <summary>
    /// Calculates the total size of all files in the group.
    /// </summary>
    public long TotalSizeBytes => Files.Sum(f => f.SizeBytes);

    /// <summary>
    /// Closes the group to further access. Storage objects are removed separately by the purge worker,
    /// which tracks completion via <see cref="StoragePurgedAt"/>.
    /// </summary>
    public void MarkDeleted(DateTime utcNow)
    {
        if (IsDeleted) return;
        IsDeleted = true;
        DeletedAt = utcNow;
    }

    /// <summary>
    /// Indicates whether a password is required to access this group.
    /// </summary>
    public bool RequiresPassword => !string.IsNullOrEmpty(PasswordHash);

    /// <summary>
    /// Indicates whether the group has expired based on time, download limits, or deletion status.
    /// </summary>
    public bool IsExpired(DateTime utcNow)
    {
        if (IsDeleted) return true;
        if (ExpiresAt.HasValue && ExpiresAt.Value <= utcNow) return true;
        if (MaxDownloads.HasValue && DownloadCount >= MaxDownloads.Value) return true;
        return false;
    }

    /// <summary>
    /// Verifies whether the provided password matches the stored BCrypt hash.
    /// </summary>
    public bool VerifyPassword(string? rawPassword)
    {
        if (!RequiresPassword) return true;
        if (string.IsNullOrEmpty(rawPassword)) return false;
        return CryptoUtils.VerifyPassword(rawPassword, PasswordHash);
    }

    /// <summary>
    /// Calculates the remaining allowed downloads for this group.
    /// </summary>
    public int? RemainingDownloads =>
        MaxDownloads.HasValue ? Math.Max(0, MaxDownloads.Value - DownloadCount) : null;
}