namespace FileHolder.Core.Entities;

/// <summary>
/// A code that unlocks the full upload limits (#169), one per job application, under a neutral label (a01, a02, …)
/// whose meaning the owner keeps elsewhere. Only its hash is stored. Records how much it was used, but no bundle
/// records which code it came with, so nothing ties a bundle to a code once it's gone.
/// </summary>
public class AccessCode
{
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>A neutral label, unique: a01, a02, … (<see cref="Configuration.AccessCodeRules"/>).</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>SHA-256 of the normalized code (<see cref="Configuration.AccessCodeRules.Hash"/>); the code itself is shown once.</summary>
    public string CodeHash { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; }

    /// <summary>When it stops working; null for never.</summary>
    public DateTime? ExpiresAt { get; set; }

    public DateTime? RevokedAt { get; set; }

    public int BundleCount { get; set; }
    public long BytesUploaded { get; set; }
    public DateTime? FirstUsedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }

    public bool IsValid(DateTime utcNow) => RevokedAt is null && (ExpiresAt is null || ExpiresAt > utcNow);
}
