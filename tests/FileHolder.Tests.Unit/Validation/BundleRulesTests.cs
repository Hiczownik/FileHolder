using FileHolder.Api.Validation;
using FileHolder.Core.Configuration;
using FluentAssertions;
using FluentValidation;

namespace FileHolder.Tests.Unit.Validation;

public class BundleRulesTests
{
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
