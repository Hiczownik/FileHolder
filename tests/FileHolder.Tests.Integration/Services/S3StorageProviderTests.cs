using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using FluentAssertions;
using Microsoft.Extensions.Options;

namespace FileHolder.Tests.Integration.Services;

/// <summary>
/// Presigned URLs are computed locally by the real SDK, so no storage server is needed. Browsers refuse plain
/// HTTP requests from an HTTPS page, so the URLs must follow the scheme of the public storage address.
/// </summary>
public class S3StorageProviderTests
{
    private const string Bucket = "fileholder-bucket";
    private const string Key = "uploads/abc.pdf";

    private static S3StorageProvider CreateProvider(string serviceUrl, string publicBaseUrl)
    {
        var options = new StorageOptions
        {
            ServiceUrl = serviceUrl,
            PublicBaseUrl = publicBaseUrl,
            AccessKey = "test-access-key",
            SecretKey = "test-secret-key",
            BucketName = Bucket
        };

        return new S3StorageProvider(
            S3ClientFactory.Create(serviceUrl, options.AccessKey, options.SecretKey),
            S3ClientFactory.Create(publicBaseUrl, options.AccessKey, options.SecretKey),
            Options.Create(options));
    }

    private static IEnumerable<string> AllPresignedUrls(S3StorageProvider provider)
    {
        var expires = DateTime.UtcNow.AddMinutes(5);
        yield return provider.GeneratePresignedUploadUrl(Key, 1024, expires);
        yield return provider.GeneratePresignedPartUploadUrl(Key, "upload-id", 1, 1024, expires);
        yield return provider.GeneratePresignedDownloadUrl(Key, "abc.pdf", "application/pdf", expires);
    }

    [Theory]
    [InlineData("https://files.example.com", "https://files.example.com/fileholder-bucket/uploads/abc.pdf?")]
    [InlineData("https://files.example.com:8443", "https://files.example.com:8443/fileholder-bucket/uploads/abc.pdf?")]
    [InlineData("http://localhost:9000", "http://localhost:9000/fileholder-bucket/uploads/abc.pdf?")]
    public void PresignedUrls_UseThePublicAddress_AndItsScheme(string publicBaseUrl, string expectedPrefix)
    {
        var provider = CreateProvider("http://minio:9000", publicBaseUrl);

        AllPresignedUrls(provider).Should().AllSatisfy(url => url.Should().StartWith(expectedPrefix));
    }

    [Fact]
    public void PresignedUrls_DontDependOnTheInternalAddressScheme()
    {
        // HTTPS between the API and storage, plain HTTP for browsers (e.g. local development behind a proxy).
        var provider = CreateProvider("https://minio.internal", "http://localhost:9000");

        AllPresignedUrls(provider).Should().AllSatisfy(url => url.Should().StartWith("http://localhost:9000/"));
    }

    [Theory]
    [InlineData("http://minio:9000", true)]
    [InlineData("https://minio:9000", false)]
    [InlineData("HTTP://MINIO:9000", true)]
    [InlineData("not a url", false)]
    public void IsPlainHttp_ReadsTheScheme(string url, bool expected)
    {
        S3ClientFactory.IsPlainHttp(url).Should().Be(expected);
    }

    [Theory]
    [InlineData("http://minio:9000", true)]
    [InlineData("https://files.example.com", true)]
    [InlineData("ftp://files.example.com", false)]
    [InlineData("files.example.com", false)]
    public void IsHttpOrHttps_AcceptsOnlyWebAddresses(string url, bool expected)
    {
        S3ClientFactory.IsHttpOrHttps(url).Should().Be(expected);
    }
}
