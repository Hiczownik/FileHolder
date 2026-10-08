using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FileHolder.Infrastructure.Services;

public class S3StorageProvider(
    [FromKeyedServices("InternalS3")] IAmazonS3 internalClient,
    [FromKeyedServices("PresignS3")] IAmazonS3 presignClient,
    IOptions<StorageOptions> options)
    : IS3StorageProvider
{
    private readonly IAmazonS3 _internalClient = internalClient;
    private readonly IAmazonS3 _presignClient = presignClient;
    private readonly StorageOptions _options = options.Value;

    public string GeneratePresignedUploadUrl(string storageKey, DateTime expiresAt)
    {
        var request = new GetPreSignedUrlRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey,
            Verb = HttpVerb.PUT,
            Expires = expiresAt,
            Protocol = Protocol.HTTP
        };

        return _presignClient.GetPreSignedURL(request);
    }

    public string GeneratePresignedPartUploadUrl(string storageKey, string uploadId, int partNumber, DateTime expiresAt)
    {
        var request = new GetPreSignedUrlRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey,
            Verb = HttpVerb.PUT,
            UploadId = uploadId,
            PartNumber = partNumber,
            Expires = expiresAt,
            Protocol = Protocol.HTTP
        };

        return _presignClient.GetPreSignedURL(request);
    }

    public string GeneratePresignedDownloadUrl(string storageKey, string fileName, string contentType, DateTime expiresAt)
    {
        var request = new GetPreSignedUrlRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey,
            Verb = HttpVerb.GET,
            Expires = expiresAt,
            Protocol = Protocol.HTTP,
            ResponseHeaderOverrides = new ResponseHeaderOverrides
            {
                ContentDisposition = $"attachment; filename=\"{fileName}\"",
                ContentType = contentType
            }
        };

        return _presignClient.GetPreSignedURL(request);
    }

    public async Task<string> InitiateMultipartUploadAsync(string storageKey, string contentType, CancellationToken ct = default)
    {
        var response = await _internalClient.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey,
            ContentType = contentType
        }, ct);

        return response.UploadId;
    }

    public async Task CompleteMultipartUploadAsync(string storageKey, string uploadId, IEnumerable<(int PartNumber, string ETag)> parts,
        CancellationToken ct = default)
    {
        var partETags = parts
            .OrderBy(p => p.PartNumber)
            .Select(p => new PartETag { PartNumber = p.PartNumber, ETag = p.ETag.Trim('\"') })
            .ToList();

        var completeRequest = new CompleteMultipartUploadRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey,
            UploadId = uploadId,
            PartETags = partETags
        };

        await _internalClient.CompleteMultipartUploadAsync(completeRequest, ct);
    }

    public async Task AbortMultipartUploadAsync(string storageKey, string uploadId, CancellationToken ct = default)
    {
        try
        {
            await _internalClient.AbortMultipartUploadAsync(new AbortMultipartUploadRequest
            {
                BucketName = _options.BucketName,
                Key = storageKey,
                UploadId = uploadId
            }, ct);
        }
        catch (AmazonS3Exception)
        {
            // Ignored: Multipart upload may have already been aborted or completed
        }
    }

    public async Task<long?> GetObjectSizeAsync(string storageKey, CancellationToken ct = default)
    {
        try
        {
            var metadata = await _internalClient.GetObjectMetadataAsync(_options.BucketName, storageKey, ct);
            return metadata.ContentLength;
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<Stream> OpenReadStreamAsync(string storageKey, CancellationToken ct = default)
    {
        var request = new GetObjectRequest
        {
            BucketName = _options.BucketName,
            Key = storageKey
        };

        var response = await _internalClient.GetObjectAsync(request, ct);
        return response.ResponseStream;
    }

    public async Task DeleteObjectsAsync(IEnumerable<string> storageKeys, CancellationToken ct = default)
    {
        var keysList = storageKeys
            .Where(k => !string.IsNullOrWhiteSpace(k))
            .Select(k => new KeyVersion { Key = k })
            .ToList();

        if (keysList.Count == 0) return;

        var deleteRequest = new DeleteObjectsRequest
        {
            BucketName = _options.BucketName,
            Objects = keysList
        };

        try
        {
            await _internalClient.DeleteObjectsAsync(deleteRequest, ct);
        }
        catch (AmazonS3Exception)
        {
            // Ignored: S3 objects may already be deleted or non-existent
        }
    }
}