using System.Net;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FileHolder.Tests.Integration.Endpoints;

public class HostingConfigurationTests(CustomWebApplicationFactory factory) : IClassFixture<CustomWebApplicationFactory>
{
    [Fact]
    public async Task Metrics_AreNotServedOnTheApiPort()
    {
        // The test server's connections arrive on port 0, standing in for the public API port.
        var response = await factory.CreateClient().GetAsync("/metrics");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Metrics_AreNotServedOnTheApiPort_EvenWhenTheHostHeaderNamesTheMetricsPort()
    {
        var client = factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/metrics");
        request.Headers.Host = "localhost:9464";

        (await client.SendAsync(request)).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Metrics_AreServedOnTheMetricsPort()
    {
        // Make the test server's port the metrics port, to show the endpoint is wired up at all.
        using var metricsFactory = factory.WithWebHostBuilder(builder => builder.UseSetting("Metrics:Port", "0"));

        var response = await metricsFactory.CreateClient().GetAsync("/metrics");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public void ForwardedHeaders_TrustTheConfiguredProxiesAndNetworks()
    {
        using var configuredFactory = factory.WithWebHostBuilder(builder => builder
            .UseSetting("ForwardedHeaders:KnownProxies:0", "172.30.250.10")
            .UseSetting("ForwardedHeaders:KnownNetworks:0", "10.0.1.0/24"));

        var options = configuredFactory.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;

        options.KnownProxies.Should().Contain(IPAddress.Parse("172.30.250.10"));
        options.KnownIPNetworks.Should().Contain(System.Net.IPNetwork.Parse("10.0.1.0/24"));
    }
}
