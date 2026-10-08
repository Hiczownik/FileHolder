namespace FileHolder.Core.Entities;

public enum LeaseStatus
{
    Active,
    Completed,
    Expired
}

public class DownloadLease
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileGroupId { get; set; }
    public FileGroup FileGroup { get; set; } = null!;

    public string LeaseToken { get; set; } = string.Empty;
    public LeaseStatus Status { get; set; } = LeaseStatus.Active;
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }

    public bool IsActive(DateTime utcNow) =>
        Status == LeaseStatus.Active && ExpiresAt > utcNow;
}