namespace FileHolder.Core.Entities;

public class SharedFile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ShareToken { get; set; } = string.Empty;
    public string OriginalFileName { get; set; } = string.Empty;
    public string StorageKey { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? PasswordHash { get; set; }
    public int? MaxDownloads { get; set; }
    public int DownloadCount { get; set; } = 0;
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; } = false;
}