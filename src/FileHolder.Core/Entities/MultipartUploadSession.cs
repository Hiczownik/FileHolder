namespace FileHolder.Core.Entities;

public class MultipartUploadSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string UploadToken { get; set; } = string.Empty;
    public string UploadId { get; set; } = string.Empty;
    public string StorageKey { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long TotalSizeBytes { get; set; }
    public long PartSizeBytes { get; set; }
    public int TotalParts { get; set; }
    public bool IsCompleted { get; set; }
    public bool IsAborted { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}