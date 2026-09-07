using System.Text.Json.Serialization;

namespace FileHolder.Core.Entities;

public class SharedFile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileGroupId { get; set; }
    [JsonIgnore]
    public FileGroup FileGroup { get; set; } = null!;
    public string OriginalFileName { get; set; } = string.Empty;
    public string StorageKey { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
}