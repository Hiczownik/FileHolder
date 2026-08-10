using Amazon.S3;
using Amazon.S3.Model;
using FileHolder.Infrastructure.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
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

    public async Task InitializeAsync()
    {
        await _postgresContainer.StartAsync();

        MockS3Client.GetPreSignedURL(Arg.Any<GetPreSignedUrlRequest>())
            .Returns("http://localhost:9000/fileholder-bucket/test_key?sig=dummy");

        MockS3Client.GetObjectMetadataAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(new GetObjectMetadataResponse { ContentLength = 1024 });
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