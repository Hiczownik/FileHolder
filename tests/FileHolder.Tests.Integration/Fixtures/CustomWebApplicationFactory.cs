using System.Collections.Concurrent;
using System.Text;
using System.Threading.RateLimiting;
using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Api.RateLimiting;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Workers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
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

    /// <summary>
    /// Most tests lift every rate limit so they can't trip over each other; the rate-limit tests keep the
    /// API's own policies (see <see cref="RealRateLimitsFactory"/>).
    /// </summary>
    protected virtual bool UseRealRateLimits => false;

    public void SeedS3Object(string storageKey, long sizeBytes)
    {
        S3ObjectRegistry[storageKey] = sizeBytes;
    }

    public async Task InitializeAsync()
    {
        await _postgresContainer.StartAsync();

        MockS3Client.GetPreSignedURL(Arg.Any<GetPreSignedUrlRequest>())
            .Returns(callInfo =>
            {
                var req = callInfo.ArgAt<GetPreSignedUrlRequest>(0);
                var url = "http://localhost:9000/fileholder-bucket/test_key?sig=dummy";
                return req.PartNumber > 0 ? $"{url}&partNumber={req.PartNumber}" : url;
            });

        MockS3Client.InitiateMultipartUploadAsync(Arg.Any<InitiateMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                // Lets a test fail one file's initiate partway through a presign.
                if (callInfo.ArgAt<InitiateMultipartUploadRequest>(0).Key.Contains("initiate_fail"))
                {
                    throw new AmazonS3Exception("Initiate failed.");
                }

                return new InitiateMultipartUploadResponse
                {
                    UploadId = "mock_upload_id_" + Guid.NewGuid().ToString("N")
                };
            });

        MockS3Client.CompleteMultipartUploadAsync(Arg.Any<CompleteMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(new CompleteMultipartUploadResponse { ETag = "\"mock_complete_etag\"" });

        MockS3Client.AbortMultipartUploadAsync(Arg.Any<AbortMultipartUploadRequest>(), Arg.Any<CancellationToken>())
            .Returns(new AbortMultipartUploadResponse());

        MockS3Client.DeleteObjectsAsync(Arg.Any<DeleteObjectsRequest>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                var req = callInfo.ArgAt<DeleteObjectsRequest>(0);
                return new DeleteObjectsResponse
                {
                    DeleteErrors = req.Objects
                        .Where(o => o.Key.Contains("delete_fail"))
                        .Select(o => new DeleteError { Key = o.Key, Code = "AccessDenied" })
                        .ToList()
                };
            });

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

        MockS3Client.CopyObjectAsync(Arg.Any<CopyObjectRequest>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                var req = callInfo.ArgAt<CopyObjectRequest>(0);
                if (S3ObjectRegistry.TryGetValue(req.SourceKey, out long sourceSize))
                {
                    // Simulates the uploader overwriting the object between confirm's checks and the copy.
                    S3ObjectRegistry[req.DestinationKey] = req.SourceKey.Contains("grows_during_copy") ? sourceSize + 1 : sourceSize;
                }

                return new CopyObjectResponse();
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

    /// <summary>Configuration settings for the test API, on top of its own (e.g. "RateLimits:ConfirmPermitLimit").</summary>
    protected virtual IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(Settings));

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

            var s3Descriptors = services
                .Where(d => d.ServiceType == typeof(IAmazonS3))
                .ToList();

            foreach (var descriptor in s3Descriptors)
            {
                services.Remove(descriptor);
            }

            services.AddKeyedSingleton<IAmazonS3>("InternalS3", MockS3Client);
            services.AddKeyedSingleton<IAmazonS3>("PresignS3", MockS3Client);

            var cleanupWorkerDescriptor = services.SingleOrDefault(d =>
                d.ImplementationType == typeof(FileCleanupWorker) ||
                (d.ServiceType == typeof(IHostedService) && d.ImplementationFactory?.Method.ReturnType == typeof(FileCleanupWorker)));

            if (cleanupWorkerDescriptor != null)
            {
                services.Remove(cleanupWorkerDescriptor);
            }

            if (!UseRealRateLimits)
            {
                var rateLimiterDescriptors = services
                    .Where(d => d.ServiceType == typeof(IConfigureOptions<RateLimiterOptions>))
                    .ToList();

                foreach (var descriptor in rateLimiterDescriptors)
                {
                    services.Remove(descriptor);
                }

                services.Configure<RateLimiterOptions>(options =>
                {
                    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

                    options.AddPolicy(RateLimitPolicies.UploadInitiate, _ => RateLimitPartition.GetNoLimiter("test"));
                    options.AddPolicy(RateLimitPolicies.MultipartPipeline, _ => RateLimitPartition.GetNoLimiter("test"));
                    options.AddPolicy(RateLimitPolicies.Confirm, _ => RateLimitPartition.GetNoLimiter("test"));
                    options.AddPolicy(RateLimitPolicies.Download, _ => RateLimitPartition.GetNoLimiter("test"));
                    options.AddPolicy(RateLimitPolicies.Metadata, _ => RateLimitPartition.GetNoLimiter("test"));
                });
            }

            var sp = services.BuildServiceProvider();
            using var scope = sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Database.Migrate();
        });
    }

    public new async Task DisposeAsync()
    {
        await _postgresContainer.DisposeAsync();
    }
}