using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>A clock tests set, for everything the app times with <see cref="IDateTimeProvider"/>.</summary>
public sealed class FakeClock : IDateTimeProvider
{
    private DateTime _utcNow = DateTime.UtcNow;

    public DateTime UtcNow => _utcNow;

    public void Advance(TimeSpan by) => _utcNow += by;
}

/// <summary>
/// The API with a <see cref="FakeClock"/>, for the health checks, which judge the purge by how long things have
/// waited. Its own fixture (and database), since its tests stop the database and leave bundles overdue on purpose.
/// </summary>
public class HealthChecksFactory : CustomWebApplicationFactory
{
    public FakeClock Clock { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IDateTimeProvider>();
            services.AddSingleton<IDateTimeProvider>(Clock);
        });
    }
}
