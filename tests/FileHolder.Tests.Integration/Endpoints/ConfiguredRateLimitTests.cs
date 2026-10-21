using System.Net;
using System.Net.Http.Json;
using FileHolder.Api.RateLimiting;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>A limit set in configuration is the one the API enforces.</summary>
public class ConfiguredRateLimitTests(ConfiguredRateLimitsFactory factory) : IClassFixture<ConfiguredRateLimitsFactory>
{
    [Fact]
    public async Task Confirm_IsLimitedToTheConfiguredNumberOfRequests()
    {
        var client = factory.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (int i = 0; i <= ConfiguredRateLimitsFactory.ConfiguredConfirmPermitLimit; i++)
        {
            // The body is never read: a request the limiter lets through fails validation with 400 instead.
            statuses.Add((await client.PostAsJsonAsync("/api/v1/files/confirm", new { })).StatusCode);
        }

        statuses.Take(ConfiguredRateLimitsFactory.ConfiguredConfirmPermitLimit).Should().NotContain(HttpStatusCode.TooManyRequests);
        statuses.Last().Should().Be(HttpStatusCode.TooManyRequests);
    }
}

/// <summary>How the "RateLimits" section is read, without starting the API.</summary>
public class RateLimitOptionsTests
{
    private static RateLimitOptions Resolve(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection().AddFileHolderRateLimits(configuration);
        return services.BuildServiceProvider().GetRequiredService<IOptions<RateLimitOptions>>().Value;
    }

    [Fact]
    public void WithoutConfiguration_TheProductionLimitsApply()
    {
        var limits = Resolve([]);

        limits.Should().BeEquivalentTo(new
        {
            UploadInitiatePermitLimit = 10,
            MultipartPipelinePermitLimit = 300,
            ConfirmPermitLimit = 10,
            DownloadPermitLimit = 30,
            MetadataPermitLimit = 60,
        });
    }

    [Fact]
    public void ConfiguredLimits_ReplaceTheDefaults()
    {
        var limits = Resolve(new() { ["RateLimits:UploadInitiatePermitLimit"] = "500", ["RateLimits:DownloadPermitLimit"] = "1000" });

        limits.UploadInitiatePermitLimit.Should().Be(500);
        limits.DownloadPermitLimit.Should().Be(1000);
        limits.ConfirmPermitLimit.Should().Be(RateLimitOptions.DefaultConfirmPermitLimit);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-5")]
    [InlineData("100001")]
    public void LimitsOutsideTheAllowedRange_AreRefused(string value)
    {
        var resolve = () => Resolve(new() { ["RateLimits:ConfirmPermitLimit"] = value });

        resolve.Should().Throw<OptionsValidationException>().WithMessage("*ConfirmPermitLimit*");
    }
}
