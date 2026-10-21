namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The production rate-limit policies, with the confirm limit set through configuration, as a deployment or a test
/// stack would set it. Its own fixture, so the limit it uses up never affects other tests.
/// </summary>
public class ConfiguredRateLimitsFactory : RealRateLimitsFactory
{
    public const int ConfiguredConfirmPermitLimit = 3;

    protected override IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>
    {
        ["RateLimits:ConfirmPermitLimit"] = ConfiguredConfirmPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture),
    };
}
