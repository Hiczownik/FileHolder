using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// One storage service the conformance tests run against, signed in as the API would be: with a key limited to
/// its bucket, through <see cref="S3ClientFactory"/>, the factory the API itself uses.
/// </summary>
/// <param name="LifecycleRule">
/// How the API runs on it: Apply where its key may manage the bucket's settings (Silo's policy allows the
/// lifecycle rule), External where it may only touch objects (an R2 token limited to one bucket).
/// </param>
public sealed record StorageTarget(string Name, string ServiceUrl, string BucketName, IAmazonS3 ApiClient, LifecycleRuleMode LifecycleRule)
{
    /// <summary>Every object a test run creates is under this prefix, so it can all be removed afterwards.</summary>
    public string KeyPrefix { get; } = $"conformance/{Guid.NewGuid():N}/";
}

/// <summary>
/// Cloudflare R2 credentials for a test bucket, from environment variables or, failing that, from
/// %USERPROFILE%\.fileholder\r2-test.env (KEY=value lines), which is outside the repository so keys never get
/// committed. Without them the R2 runs are simply not part of the test run.
/// </summary>
public sealed record R2Settings(string AccountId, string AccessKeyId, string SecretAccessKey, string Bucket, string? Jurisdiction)
{
    public static readonly string SettingsFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".fileholder", "r2-test.env");

    private static readonly Lazy<R2Settings?> Loaded = new(Load);

    public static R2Settings? Current => Loaded.Value;

    /// <summary>
    /// An EU (or other) jurisdiction bucket has its own address; a bucket's jurisdiction can't be changed later.
    /// </summary>
    public string ServiceUrl => string.IsNullOrEmpty(Jurisdiction)
        ? $"https://{AccountId}.r2.cloudflarestorage.com"
        : $"https://{AccountId}.{Jurisdiction}.r2.cloudflarestorage.com";

    private static R2Settings? Load()
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(SettingsFile))
        {
            foreach (var line in File.ReadAllLines(SettingsFile))
            {
                var separator = line.IndexOf('=', StringComparison.Ordinal);
                if (separator > 0 && !line.TrimStart().StartsWith('#'))
                {
                    values[line[..separator].Trim()] = line[(separator + 1)..].Trim();
                }
            }
        }

        string? Get(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } fromEnvironment
            ? fromEnvironment
            : values.GetValueOrDefault(name);

        var accountId = Get("R2_ACCOUNT_ID");
        var accessKeyId = Get("R2_ACCESS_KEY_ID");
        var secretAccessKey = Get("R2_SECRET_ACCESS_KEY");
        var bucket = Get("R2_BUCKET");
        return string.IsNullOrEmpty(accountId) || string.IsNullOrEmpty(accessKeyId) || string.IsNullOrEmpty(secretAccessKey) || string.IsNullOrEmpty(bucket)
            ? null
            : new R2Settings(accountId, accessKeyId, secretAccessKey, bucket, Get("R2_JURISDICTION"));
    }
}

/// <summary>
/// The storage services to check: Silo, always (a container like <see cref="SiloFixture"/>), and Cloudflare R2 when
/// <see cref="R2Settings"/> are present. Removes what the run uploaded when it's done.
/// </summary>
public sealed class StorageTargetsFixture : IAsyncLifetime
{
    public const string Silo = "Silo";
    public const string R2 = "R2";

    private readonly SiloFixture _silo = new();
    private readonly Dictionary<string, StorageTarget> _targets = [];

    /// <summary>The names to run each conformance test for: R2 only when its settings are present.</summary>
    public static TheoryData<string> Names => R2Settings.Current is null ? new TheoryData<string> { Silo } : new TheoryData<string> { Silo, R2 };

    public StorageTarget this[string name] => _targets[name];

    public async Task InitializeAsync()
    {
        await _silo.InitializeAsync();
        _targets[Silo] = new StorageTarget(Silo, _silo.ServiceUrl, SiloFixture.BucketName, _silo.ApiClient, LifecycleRuleMode.Apply);

        if (R2Settings.Current is { } r2)
        {
            _targets[R2] = new StorageTarget(R2, r2.ServiceUrl, r2.Bucket,
                S3ClientFactory.Create(r2.ServiceUrl, r2.AccessKeyId, r2.SecretAccessKey), LifecycleRuleMode.External);
        }
    }

    public async Task DisposeAsync()
    {
        if (_targets.TryGetValue(R2, out var r2))
        {
            await RemoveRunObjectsAsync(r2);
            r2.ApiClient.Dispose();
        }

        await _silo.DisposeAsync();
    }

    /// <summary>Objects and unfinished multipart uploads under the run's prefix, so a test bucket doesn't fill up.</summary>
    private static async Task RemoveRunObjectsAsync(StorageTarget target)
    {
        try
        {
            var uploads = await target.ApiClient.ListMultipartUploadsAsync(new ListMultipartUploadsRequest { BucketName = target.BucketName, Prefix = target.KeyPrefix });
            foreach (var upload in uploads.MultipartUploads ?? [])
            {
                await target.ApiClient.AbortMultipartUploadAsync(target.BucketName, upload.Key, upload.UploadId);
            }

            var objects = await target.ApiClient.ListObjectsV2Async(new ListObjectsV2Request { BucketName = target.BucketName, Prefix = target.KeyPrefix });
            foreach (var item in objects.S3Objects ?? [])
            {
                await target.ApiClient.DeleteObjectAsync(target.BucketName, item.Key);
            }
        }
        catch (AmazonS3Exception)
        {
            // Best effort: a token that can't list leaves the run's few small objects for the bucket's own clean-up.
        }
    }
}
