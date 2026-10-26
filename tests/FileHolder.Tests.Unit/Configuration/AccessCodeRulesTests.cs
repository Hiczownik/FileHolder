using FileHolder.Core.Configuration;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Configuration;

public class AccessCodeRulesTests
{
    private const string Crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    [Fact]
    public void ACode_IsTheLabelAndTwelveRandomCharactersInThreeGroups()
    {
        var code = AccessCodeRules.Generate("a01");

        code.Should().MatchRegex(@"^a01-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\z");
        code[4..].Replace("-", "").ToCharArray().Should().OnlyContain(c => Crockford.Contains(c), "Crockford's base32 leaves out I, L, O and U");
    }

    [Fact]
    public void Codes_AreRandom()
    {
        var codes = Enumerable.Range(0, 1000).Select(_ => AccessCodeRules.Generate("a01")).ToHashSet();

        codes.Should().HaveCount(1000);
    }

    [Theory]
    [InlineData("a01-7f3k-9q2m-x8pd")]
    [InlineData("  A01-7F3K-9Q2M-X8PD  ")]
    [InlineData("a01 - 7F3K - 9Q2M - X8PD")]
    public void ACodeRetypedWithAnotherCaseOrSpaces_HashesTheSame(string retyped)
    {
        AccessCodeRules.Hash(retyped).Should().Be(AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PD"));
    }

    [Fact]
    public void LettersThatLookLikeDigits_ReadAsTheDigits()
    {
        AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PO").Should().Be(AccessCodeRules.Hash("a01-7F3K-9Q2M-X8P0"));
        AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PI").Should().Be(AccessCodeRules.Hash("a01-7F3K-9Q2M-X8P1"));
        AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PL").Should().Be(AccessCodeRules.Hash("a01-7F3K-9Q2M-X8P1"));
    }

    [Fact]
    public void AnotherCode_HashesDifferently()
    {
        AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PD").Should().NotBe(AccessCodeRules.Hash("a01-7F3K-9Q2M-X8PE"));
    }

    [Theory]
    [InlineData("a01", true)]
    [InlineData("b7", true)]
    [InlineData("a", true)]
    [InlineData("A01", false)]
    [InlineData("01", false)]
    [InlineData("acme corp", false)]
    [InlineData("a-01", false)]
    [InlineData("a01\n", false)]
    [InlineData("abcdefghijklmnopqrstu", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Labels_AreShortNeutralNames(string? label, bool valid)
    {
        AccessCodeRules.IsValidLabel(label).Should().Be(valid);
    }

    [Theory]
    [InlineData(null, null, true)]
    [InlineData(10L * 1024 * 1024, 1, true)]
    [InlineData(10L * 1024 * 1024, null, false)]
    [InlineData(null, 1, false)]
    [InlineData(300L * 1024 * 1024, 1, false)]
    [InlineData(10L * 1024 * 1024, 48, false)]
    public void TheWithoutCodeSettings_AreBothOrNeither_AndNoLargerThanACodesLimits(long? maxBytes, int? maxHours, bool valid)
    {
        var options = new UploadLimitsOptions
        {
            MaxBundleSizeBytes = 250L * 1024 * 1024,
            MaxExpiryHours = 24,
            WithoutCodeMaxBundleSizeBytes = maxBytes,
            WithoutCodeMaxExpiryHours = maxHours,
        };

        options.WithoutCodeSettingsAreValid().Should().Be(valid);
    }

    [Fact]
    public void WithoutCode_GivesTheSmallerLimits_OrTheSameWhenCodesAreOff()
    {
        var on = new UploadLimitsOptions { MaxBundleSizeBytes = 100, MaxExpiryHours = 24, WithoutCodeMaxBundleSizeBytes = 10, WithoutCodeMaxExpiryHours = 1 };
        var off = new UploadLimitsOptions { MaxBundleSizeBytes = 100, MaxExpiryHours = 24 };

        on.AccessCodesEnabled.Should().BeTrue();
        on.WithoutCode().MaxBundleSizeBytes.Should().Be(10);
        on.WithoutCode().MaxExpiryHours.Should().Be(1);
        off.AccessCodesEnabled.Should().BeFalse();
        off.WithoutCode().Should().BeSameAs(off);
    }
}
