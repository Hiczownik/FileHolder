namespace FileHolder.Core.Entities;

/// <summary>
/// A file that presign handed out an upload URL for and that no bundle has claimed yet.
/// Confirm only accepts files recorded here, takes their expected size from here, and deletes
/// the rows; anything still pending after <see cref="ExpiresAt"/> is removed by the purge worker.
/// While a confirm is working on them, it holds them through <see cref="ClaimId"/> until
/// <see cref="ClaimedUntil"/>, so a parallel confirm of the same upload is refused before doing any work.
/// </summary>
public class PendingUpload
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string UploadToken { get; set; } = string.Empty;
    public string StorageKey { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public bool IsEncrypted { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public Guid? ClaimId { get; set; }
    public DateTime? ClaimedUntil { get; set; }

    public bool IsActive(DateTime utcNow) => ExpiresAt > utcNow;
}
