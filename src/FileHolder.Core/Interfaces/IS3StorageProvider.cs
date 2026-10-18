namespace FileHolder.Core.Interfaces;

public interface IS3StorageProvider
{
    string GeneratePresignedUploadUrl(string storageKey, DateTime expiresAt);
    string GeneratePresignedPartUploadUrl(string storageKey, string uploadId, int partNumber, DateTime expiresAt);
    string GeneratePresignedDownloadUrl(string storageKey, string fileName, string contentType, DateTime expiresAt);

    Task<string> InitiateMultipartUploadAsync(string storageKey, string contentType, CancellationToken ct = default);
    Task CompleteMultipartUploadAsync(string storageKey, string uploadId, IEnumerable<(int PartNumber, string ETag)> parts, CancellationToken ct = default);
    Task AbortMultipartUploadAsync(string storageKey, string uploadId, CancellationToken ct = default);

    Task<long?> GetObjectSizeAsync(string storageKey, CancellationToken ct = default);
    Task<Stream> OpenReadStreamAsync(string storageKey, CancellationToken ct = default);
    /// <summary>
    /// Deletes the given objects and returns the keys that could not be deleted.
    /// </summary>
    Task<IReadOnlySet<string>> DeleteObjectsAsync(IEnumerable<string> storageKeys, CancellationToken ct = default);
}