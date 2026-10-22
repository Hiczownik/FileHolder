using Amazon.S3;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using FileHolder.Infrastructure.Services;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// A real Silo storage server (the same image as docker-compose.yml), for what a mocked S3 can't tell: which
/// lifecycle rules storage actually keeps.
/// </summary>
public class SiloFixture : IAsyncLifetime
{
    public const string BucketName = "fileholder-bucket";
    private const int S3Port = 9000;
    private const string RootUser = "minioadmin";
    private const string RootPassword = "minioadmin";

    private readonly IContainer _container = new ContainerBuilder(ComposeImages.Silo)
        .WithCommand("server", "/data")
        .WithEnvironment("MINIO_ROOT_USER", RootUser)
        .WithEnvironment("MINIO_ROOT_PASSWORD", RootPassword)
        .WithPortBinding(S3Port, true)
        .WithWaitStrategy(Wait.ForUnixContainer().UntilHttpRequestIsSucceeded(request => request.ForPort(S3Port).ForPath("/minio/health/live")))
        .Build();

    public IAmazonS3 Client { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        var serviceUrl = $"http://{_container.Hostname}:{_container.GetMappedPublicPort(S3Port)}";
        Client = S3ClientFactory.Create(serviceUrl, RootUser, RootPassword);
        await Client.PutBucketAsync(BucketName);
    }

    public async Task DisposeAsync()
    {
        Client.Dispose();
        await _container.DisposeAsync();
    }
}
