namespace FileHolder.Core.Dtos;

public record BundleFileEntry(string OriginalFileName, string StorageKey);

public record AcquireLeaseResult(
    StreamZipStatus Status,
    string? LeaseToken = null,
    string? BundleTitle = null,
    Guid? FileGroupId = null,
    List<BundleFileEntry>? Files = null
);