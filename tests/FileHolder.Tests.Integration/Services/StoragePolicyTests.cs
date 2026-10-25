using System.Net;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// The API's storage user (docker/silo/api-policy.json) may do nothing beyond its bucket. That it may do everything
/// the API does there is checked by StorageConformanceTests, which runs as this user.
/// </summary>
public sealed class StoragePolicyTests(SiloFixture silo) : IClassFixture<SiloFixture>
{
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
