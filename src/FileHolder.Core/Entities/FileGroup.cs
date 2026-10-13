using FileHolder.Core.Security;

namespace FileHolder.Core.Entities;

public class FileGroup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ShareToken { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? PasswordHash { get; set; }
    public int? MaxDownloads { get; set; }
    public int DownloadCount { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }

    public bool IsEncrypted { get; set; }
    public string? EncryptedManifest { get; set; }

    public ICollection<SharedFile> Files { get; set; } = new List<SharedFile>();

    /// <summary>
    /// Calculates the total size of all files in the group.
    /// </summary>
    public long TotalSizeBytes => Files.Sum(f => f.SizeBytes);

    /// <summary>
    /// Determines if there is remaining capacity based strictly on DownloadCount.
    /// </summary>
    public bool HasDownloadCapacity(DateTime utcNow)
    {
        if (IsDeleted) return false;
        if (ExpiresAt.HasValue && ExpiresAt.Value <= utcNow) return false;
        if (!MaxDownloads.HasValue) return true;

        return DownloadCount < MaxDownloads.Value;
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