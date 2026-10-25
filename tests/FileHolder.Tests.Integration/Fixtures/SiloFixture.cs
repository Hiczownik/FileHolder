using Amazon.S3;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using FileHolder.Infrastructure.Services;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// A real Silo storage server (the same image as docker-compose.yml), for what a mocked S3 can't tell: which
/// lifecycle rules storage actually keeps, and whether the API's storage user may do everything the API does.
/// Set up like minio-init in docker-compose.yml: the bucket, plus the API's own user limited by
/// docker/silo/api-policy.json.
/// </summary>
public class SiloFixture : IAsyncLifetime
{
    public const string BucketName = "fileholder-bucket";
    public const string ApiAccessKey = "fileholder-api";
    public const string PolicyFile = "docker/silo/api-policy.json";
    private const int S3Port = 9000;
    private const string RootUser = "test-admin";
    private const string ContainerPolicyPath = "/tmp/api-policy.json";

    private readonly string _rootPassword = Guid.NewGuid().ToString("N");
    private readonly string _apiSecretKey = Guid.NewGuid().ToString("N");
    private readonly IContainer _container;

    public SiloFixture()
    {
        _container = new ContainerBuilder(ComposeImages.Silo)
            .WithCommand("server", "/data")
            .WithEnvironment("MINIO_ROOT_USER", RootUser)
            .WithEnvironment("MINIO_ROOT_PASSWORD", _rootPassword)
            .WithPortBinding(S3Port, true)
            .WithWaitStrategy(Wait.ForUnixContainer().UntilHttpRequestIsSucceeded(request => request.ForPort(S3Port).ForPath("/minio/health/live")))
            .Build();
    }

    public string ServiceUrl { get; private set; } = null!;

    /// <summary>The storage admin, for setting up and reading back what a test checks.</summary>
    public IAmazonS3 Client { get; private set; } = null!;

    /// <summary>The API's own storage user, with only what docker/silo/api-policy.json allows.</summary>
    public IAmazonS3 ApiClient { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        ServiceUrl = $"http://{_container.Hostname}:{_container.GetMappedPublicPort(S3Port)}";
        Client = S3ClientFactory.Create(ServiceUrl, RootUser, _rootPassword);
        await Client.PutBucketAsync(BucketName);

        await _container.CopyAsync(await File.ReadAllBytesAsync(Path.Combine(ComposeImages.RepositoryRoot, PolicyFile)), ContainerPolicyPath);
        await McAsync("alias", "set", "local", $"http://localhost:{S3Port}", RootUser, _rootPassword);
        await McAsync("admin", "policy", "create", "local", ApiAccessKey, ContainerPolicyPath);
        await McAsync("admin", "user", "add", "local", ApiAccessKey, _apiSecretKey);
        await McAsync("admin", "policy", "attach", "local", ApiAccessKey, "--user", ApiAccessKey);
        ApiClient = S3ClientFactory.Create(ServiceUrl, ApiAccessKey, _apiSecretKey);
    }

    private async Task McAsync(params string[] args)
    {
        var result = await _container.ExecAsync(["mc", .. args]);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"mc {args[0]} {args[1]} failed: {result.Stdout}{result.Stderr}");
        }
    }

    public async Task DisposeAsync()
    {
        Client.Dispose();
        ApiClient?.Dispose();
        await _container.DisposeAsync();
    }
}
