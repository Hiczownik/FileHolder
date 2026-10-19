namespace FileHolder.Core.Interfaces;

public interface IS3StorageProvider
{
    /// <summary>
    /// The URL is signed for exactly <paramref name="contentLength"/> bytes: storage refuses any other body size.
    /// </summary>
    string GeneratePresignedUploadUrl(string storageKey, long contentLength, DateTime expiresAt);
    /// <summary>
    /// The URL is signed for exactly <paramref name="contentLength"/> bytes: storage refuses any other body size.
    /// </summary>
    string GeneratePresignedPartUploadUrl(string storageKey, string uploadId, int partNumber, long contentLength, DateTime expiresAt);
    string GeneratePresignedDownloadUrl(string storageKey, string fileName, string contentType, DateTime expiresAt);

    Task<string> InitiateMultipartUploadAsync(string storageKey, string contentType, CancellationToken ct = default);
    Task CompleteMultipartUploadAsync(string storageKey, string uploadId, IEnumerable<(int PartNumber, string ETag)> parts, CancellationToken ct = default);
    Task AbortMultipartUploadAsync(string storageKey, string uploadId, CancellationToken ct = default);

    Task<long?> GetObjectSizeAsync(string storageKey, CancellationToken ct = default);
    /// <summary>
    /// Copies an object within the bucket, server side.
    /// </summary>
    Task CopyObjectAsync(string sourceKey, string destinationKey, CancellationToken ct = default);
    Task<Stream> OpenReadStreamAsync(string storageKey, CancellationToken ct = default);
    /// <summary>
    /// Deletes the given objects and returns the keys that could not be deleted.
    /// </summary>
    Task<IReadOnlySet<string>> DeleteObjectsAsync(IEnumerable<string> storageKeys, CancellationToken ct = default);
}