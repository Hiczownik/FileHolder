using System.Collections.Concurrent;
using System.Text;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Workers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using NSubstitute;
using Testcontainers.PostgreSql;

namespace FileHolder.Tests.Integration.Fixtures;

public class CustomWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgresContainer = new PostgreSqlBuilder("postgres:17-alpine")
        .WithDatabase("test_fileholder_db")
        .WithUsername("test_user")
        .WithPassword("test_password")
        .Build();
    
    public IAmazonS3 MockS3Client { get; private set; } = Substitute.For<IAmazonS3>();
    
    public ConcurrentDictionary<string, long> S3ObjectRegistry { get; } = new();

    public void SeedS3Object(string storageKey, long sizeBytes)
    {
        S3ObjectRegistry[storageKey] = sizeBytes;
    }
    
    public async Task InitializeAsync()
    {
        await _postgresContainer.StartAsync();

        MockS3Client.GetPreSignedURL(Arg.Any<GetPreSignedUrlRequest>())
            .Returns("http://localhost:9000/fileholder-bucket/test_key?sig=dummy");

        MockS3Client.GetObjectMetadataAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                string storageKey = callInfo.ArgAt<string>(1);

                if (storageKey.Contains("non_existent"))
                {
                    var ex = new AmazonS3Exception("Key not found.");
                    ex.StatusCode = System.Net.HttpStatusCode.NotFound;
                    throw ex;
                }

                if (S3ObjectRegistry.TryGetValue(storageKey, out long registeredSize))
                {
                    return new GetObjectMetadataResponse { ContentLength = registeredSize };
                }
                
                return new GetObjectMetadataResponse { ContentLength = 38219032 };
            });

        MockS3Client.GetObjectAsync(Arg.Any<GetObjectRequest>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                var req = callInfo.ArgAt<GetObjectRequest>(0);
                byte[] content = Encoding.UTF8.GetBytes($"Mock binary payload content for {req.Key}");
                return new GetObjectResponse
                {
                    ResponseStream = new MemoryStream(content),
                    ContentLength = content.Length
                };
            });
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            var dbContextDescriptor =
                services.SingleOrDefault(d => d.ServiceType == typeof(DbContextOptions<AppDbContext>));
            if (dbContextDescriptor != null)
            {
                services.Remove(dbContextDescriptor);
            }

            services.AddDbContext<AppDbContext>(options =>
                options.UseNpgsql(_postgresContainer.GetConnectionString()));

            var s3Descriptor = services.SingleOrDefault(d => d.ServiceType == typeof(IAmazonS3));
            if (s3Descriptor != null)
            {
                services.Remove(s3Descriptor);
            }

            services.AddSingleton(MockS3Client);

            // Remove the background purge worker during integration testing
            var cleanupWorkerDescriptor = services.SingleOrDefault(d =>
                d.ImplementationType == typeof(FileCleanupWorker) ||
                (d.ServiceType == typeof(IHostedService) && d.ImplementationFactory?.Method.ReturnType == typeof(FileCleanupWorker)));

            if (cleanupWorkerDescriptor != null)
            {
                services.Remove(cleanupWorkerDescriptor);
            }

            var sp = services.BuildServiceProvider();
            using var scope = sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Database.EnsureCreated();
        });
    }

    public new async Task DisposeAsync()
    {
        await _postgresContainer.DisposeAsync();
    }
}