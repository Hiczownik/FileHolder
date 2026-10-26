using FileHolder.Api.Validation;
using FileHolder.Core.Configuration;
using FluentAssertions;
using FluentValidation;

namespace FileHolder.Tests.Unit.Validation;

public class BundleRulesTests
{
    public sealed record Field(string? Value);

    private sealed class FieldValidator : AbstractValidator<Field>
    {
        public FieldValidator(string rule)
        {
            switch (rule)
            {
                case "content type": RuleFor(x => x.Value!).MustBeValidContentType(); break;
                case "key material": RuleFor(x => x.Value).MustBeKeyMaterial("Key salt", 64); break;
                default: RuleFor(x => x.Value).MustBeAuthKey(); break;
            }
        }
    }

    // .NET's $ also matches just before a final newline, so a pattern ending in $ let "application/pdf\n" through, and
    // the content type is echoed back as a response header. The patterns end with \z instead. Found by the FsCheck
    // property ContentType_AcceptedValues_AreValidContentTypeHeaders on a random seed.
    [Theory]
    [InlineData("content type", "application/pdf")]
    [InlineData("key material", "q3-_Zx0")]
    [InlineData("auth key", "q3-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void AValueTheRuleAccepts_IsRefused_WithATrailingNewline(string rule, string accepted)
    {
        var validator = new FieldValidator(rule);

        validator.Validate(new Field(accepted)).IsValid.Should().BeTrue();
        validator.Validate(new Field(accepted + "\n")).IsValid.Should().BeFalse();
        validator.Validate(new Field(accepted + "\r\n")).IsValid.Should().BeFalse();
    }

    public sealed record Sizes(List<long> Files);

    private sealed class SizeValidator : AbstractValidator<Sizes>
    {
        public SizeValidator(long maxBundleSizeBytes, bool encrypted)
        {
            var limits = new UploadLimitsOptions { MaxBundleSizeBytes = maxBundleSizeBytes };
            if (encrypted)
            {
                RuleFor(x => x.Files).MustFitEncryptedBundleSizeLimit(size => size, limits);
            }
            else
            {
                RuleFor(x => x.Files).MustFitBundleSizeLimit(size => size, limits);
            }
        }
    }

    public sealed record Expiry(int? Hours);

    private sealed class ExpiryValidator : AbstractValidator<Expiry>
    {
        public ExpiryValidator(int maxExpiryHours) =>
            RuleFor(x => x.Hours).MustBeValidExpiry(new UploadLimitsOptions { MaxExpiryHours = maxExpiryHours });
    }

    [Theory]
    [InlineData(24, 24, true)]
    [InlineData(24, 25, false)]
    [InlineData(168, 168, true)]
    [InlineData(168, 169, false)]
    [InlineData(24, 0, false)]
    public void Expiry_IsCheckedAgainstTheConfiguredMaximum(int maxExpiryHours, int hours, bool valid)
    {
        new ExpiryValidator(maxExpiryHours).Validate(new Expiry(hours)).IsValid.Should().Be(valid);
    }

    [Theory]
    [InlineData(168, "Expiration time must be between 1 hour and 168 hours (7 days).")]
    [InlineData(24, "Expiration time must be between 1 hour and 24 hours (1 day).")]
    [InlineData(36, "Expiration time must be between 1 hour and 36 hours (1.5 days).")]
    [InlineData(12, "Expiration time must be between 1 hour and 12 hours.")]
    [InlineData(1, "Expiration time must be between 1 hour and 1 hour.")]
    public void Expiry_ExplainsTheConfiguredMaximum(int maxExpiryHours, string message)
    {
        new ExpiryValidator(maxExpiryHours).Validate(new Expiry(maxExpiryHours + 1)).Errors.Should().ContainSingle()
            .Which.ErrorMessage.Should().Be(message);
    }

    [Theory]
    [InlineData(5L * 1024 * 1024 * 1024, "5 GB")]
    [InlineData(250L * 1024 * 1024, "250 MB")]
    [InlineData(1536L * 1024 * 1024, "1.5 GB")]
    [InlineData(1024, "1 KB")]
    [InlineData(10, "10 Bytes")]
    public void FormatSize_UsesTheLargestFittingUnit_LikeTheUi(long bytes, string expected)
    {
        BundleRules.FormatSize(bytes).Should().Be(expected);
    }

    // Found by the property tests (#70): with a configured limit near long.MaxValue, files that each fit added up past
    // it, and the checked sum threw an OverflowException (a 500) instead of rejecting the bundle.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SizeLimit_RefusesFilesThatTogetherOverflowALong_InsteadOfThrowing(bool encrypted)
    {
        var bundle = new Sizes([long.MaxValue - 10, long.MaxValue - 10]);

        new SizeValidator(long.MaxValue, encrypted).Validate(bundle).IsValid.Should().BeFalse();
    }
}
