namespace FileHolder.Core.Entities;

/// <summary>
/// One counted download of a file group. Opening a session consumes one of the group's
/// MaxDownloads; while it is active the recipient can fetch any of the group's files
/// (individually or as a ZIP) without consuming more.
/// </summary>
public class DownloadSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileGroupId { get; set; }
    public FileGroup FileGroup { get; set; } = null!;
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }

    public bool IsActive(DateTime utcNow) => ExpiresAt > utcNow;
}
