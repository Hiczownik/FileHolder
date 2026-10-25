using System.Net;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.Health;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// The API's storage user (docker/silo/api-policy.json) may do everything the API does with the bucket, and nothing
/// else. Every storage call the API makes goes through <see cref="S3StorageProvider"/>, the health check or the
/// lifecycle initializer (StorageLifecycleTests, which also runs as this user), so a call the policy forgot fails
/// here rather than on a deployment.
/// </summary>
public sealed class StoragePolicyTests(SiloFixture silo) : IClassFixture<SiloFixture>, IDisposable
{
    private readonly HttpClient _http = new();

    public void Dispose() => _http.Dispose();

    private IOptions<StorageOptions> Options => Microsoft.Extensions.Options.Options.Create(new StorageOptions
    {
        ServiceUrl = silo.ServiceUrl,
        PublicBaseUrl = silo.ServiceUrl,
        AccessKey = SiloFixture.ApiAccessKey,
        SecretKey = "unused: the clients below are already signed in",
        BucketName = SiloFixture.BucketName
    });

    // The same client signs URLs and calls storage: the test reaches storage at one address.
    private S3StorageProvider Provider => new(silo.ApiClient, silo.ApiClient, Options);

    private static string NewKey(string name) => $"uploads/{Guid.NewGuid():N}_{name}";

    private static DateTime InFiveMinutes => DateTime.UtcNow.AddMinutes(5);

    private async Task<HttpResponseMessage> PutAsync(string url, byte[] body)
    {
        var response = await _http.PutAsync(url, new ByteArrayContent(body));
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return response;
    }

    [Fact]
    public async Task TheHealthCheck_ReachesTheBucket()
    {
        var result = await new StorageHealthCheck(silo.ApiClient, Options).CheckHealthAsync(new HealthCheckContext());

        result.Status.Should().Be(HealthStatus.Healthy, result.Exception?.Message);
    }

    [Fact]
    public async Task ASingleUpload_CanBeChecked_Downloaded_Copied_AndDeleted()
    {
        var provider = Provider;
        var key = NewKey("report.pdf");
        var copyKey = NewKey("report.pdf");
        var body = "a small file"u8.ToArray();

        await PutAsync(provider.GeneratePresignedUploadUrl(key, body.Length, InFiveMinutes), body);
        (await provider.GetObjectSizeAsync(key)).Should().Be(body.Length);

        var download = await _http.GetAsync(provider.GeneratePresignedDownloadUrl(key, "report.pdf", "application/pdf", InFiveMinutes));
        download.StatusCode.Should().Be(HttpStatusCode.OK);
        (await download.Content.ReadAsByteArrayAsync()).Should().Equal(body);

        await provider.CopyObjectAsync(key, copyKey);
        await using (var stream = await provider.OpenReadStreamAsync(copyKey))
        {
            using var copied = new MemoryStream();
            await stream.CopyToAsync(copied);
            copied.ToArray().Should().Equal(body);
        }

        (await provider.DeleteObjectsAsync([key, copyKey])).Should().BeEmpty();
        (await provider.GetObjectSizeAsync(key)).Should().BeNull();
        (await provider.GetObjectSizeAsync(copyKey)).Should().BeNull();
    }

    [Fact]
    public async Task AMultipartUpload_CanBeStarted_UploadedAndCompleted()
    {
        var provider = Provider;
        var key = NewKey("video.mp4");
        var body = "the only part, so it may be small"u8.ToArray();

        var uploadId = await provider.InitiateMultipartUploadAsync(key, "video/mp4");
        var part = await PutAsync(provider.GeneratePresignedPartUploadUrl(key, uploadId, 1, body.Length, InFiveMinutes), body);
        await provider.CompleteMultipartUploadAsync(key, uploadId, [(1, part.Headers.ETag!.Tag)]);

        (await provider.GetObjectSizeAsync(key)).Should().Be(body.Length);
    }

    [Fact]
    public async Task AMultipartUpload_CanBeAborted()
    {
        var provider = Provider;
        var key = NewKey("abandoned.zip");
        var uploadId = await provider.InitiateMultipartUploadAsync(key, "application/zip");

        await provider.AbortMultipartUploadAsync(key, uploadId);

        // The provider ignores storage errors on abort (the upload may already be finished), so ask storage itself.
        var open = await silo.Client.ListMultipartUploadsAsync(new ListMultipartUploadsRequest { BucketName = SiloFixture.BucketName, Prefix = key });
        (open.MultipartUploads ?? []).Should().BeEmpty();
    }

    [Fact]
    public async Task TheApiUser_CannotSeeOrUseAnotherBucket_NorMakeItsBucketPublic()
    {
        const string otherBucket = "not-fileholders-bucket";
        await silo.Client.PutBucketAsync(otherBucket);
        await silo.Client.PutObjectAsync(new PutObjectRequest { BucketName = otherBucket, Key = "theirs", ContentBody = "theirs" });

        var readElsewhere = () => silo.ApiClient.GetObjectAsync(otherBucket, "theirs");
        var writeElsewhere = () => silo.ApiClient.PutObjectAsync(new PutObjectRequest { BucketName = otherBucket, Key = "x", ContentBody = "x" });
        var makePublic = () => silo.ApiClient.PutBucketPolicyAsync(new PutBucketPolicyRequest
        {
            BucketName = SiloFixture.BucketName,
            Policy = $$"""{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{{SiloFixture.BucketName}}/*"]}]}"""
        });

        (await readElsewhere.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await writeElsewhere.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await makePublic.Should().ThrowAsync<AmazonS3Exception>()).Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Storage answers a bucket listing with only the buckets the user may use, rather than refusing it.
        var listed = await silo.ApiClient.ListBucketsAsync();
        (listed.Buckets ?? []).Select(bucket => bucket.BucketName).Should().NotContain(otherBucket);
    }
}
