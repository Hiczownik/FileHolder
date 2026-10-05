using System.Collections.Concurrent;
using System.Text;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Workers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
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

        MockS3Client.InitiateMultipartUploadAsync(Arg.Any<InitiateMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(callInfo => new InitiateMultipartUploadResponse
            {
                UploadId = "mock_upload_id_" + Guid.NewGuid().ToString("N")
            });

        MockS3Client.CompleteMultipartUploadAsync(Arg.Any<CompleteMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(new CompleteMultipartUploadResponse { ETag = "\"mock_complete_etag\"" });

        MockS3Client.AbortMultipartUploadAsync(Arg.Any<AbortMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(new AbortMultipartUploadResponse());

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

            // Remove background purge worker during integration testing
            var cleanupWorkerDescriptor = services.SingleOrDefault(d =>
                d.ImplementationType == typeof(FileCleanupWorker) ||
                (d.ServiceType == typeof(IHostedService) && d.ImplementationFactory?.Method.ReturnType == typeof(FileCleanupWorker)));

            if (cleanupWorkerDescriptor != null)
            {
                services.Remove(cleanupWorkerDescriptor);
            }

            // 1. Remove the existing RateLimiter configuration registered in Program.cs
            var rateLimiterDescriptors = services
                .Where(d => d.ServiceType == typeof(IConfigureOptions<RateLimiterOptions>))
                .ToList();

            foreach (var descriptor in rateLimiterDescriptors)
            {
                services.Remove(descriptor);
            }

            // 2. Register relaxed test policies (10,000 permits) cleanly without name collision
            services.Configure<RateLimiterOptions>(options =>
            {
                options.RejectionStatusCode = Microsoft.AspNetCore.Http.StatusCodes.Status429TooManyRequests;

                options.AddFixedWindowLimiter("UploadPolicy", policy =>
                {
                    policy.PermitLimit = 10_000;
                    policy.Window = TimeSpan.FromMinutes(1);
                });

                options.AddFixedWindowLimiter("DownloadPolicy", policy =>
                {
                    policy.PermitLimit = 10_000;
                    policy.Window = TimeSpan.FromMinutes(1);
                });
            });

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