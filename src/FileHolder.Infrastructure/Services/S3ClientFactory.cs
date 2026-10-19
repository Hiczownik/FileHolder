using Amazon.S3;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Builds the S3 clients for MinIO. Each client talks to one base URL, over that URL's own scheme: the API's
/// connection to storage can stay plain HTTP inside the network while the presigned URLs handed to browsers
/// use HTTPS, or the other way round.
/// </summary>
public static class S3ClientFactory
{
    public static IAmazonS3 Create(string serviceUrl, string accessKey, string secretKey)
    {
        var config = new AmazonS3Config
        {
            ServiceURL = serviceUrl,
            ForcePathStyle = true,
            UseHttp = IsPlainHttp(serviceUrl),
            AuthenticationRegion = "us-east-1"
        };
        return new AmazonS3Client(accessKey, secretKey, config);
    }

    public static bool IsPlainHttp(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttp;

    public static bool IsHttpOrHttps(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
}
