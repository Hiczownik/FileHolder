namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The test API with the rate-limit policies it runs with in production. Its own fixture, so the limits
/// these tests use up never affect the other tests.
/// </summary>
public class RealRateLimitsFactory : CustomWebApplicationFactory
{
    protected override bool UseRealRateLimits => true;
}
