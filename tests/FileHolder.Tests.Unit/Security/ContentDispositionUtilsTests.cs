using FileHolder.Core.Security;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Security;

public class ContentDispositionUtilsTests
{
    [Fact]
    public void Attachment_KeepsAsciiNamesAsASingleFilename()
    {
        ContentDispositionUtils.Attachment("report-v1.2.pdf")
            .Should().Be("attachment; filename=\"report-v1.2.pdf\"");
    }

    [Fact]
    public void Attachment_AddsUtf8FilenameStar_AndAsciiFallback_ForPolishNames()
    {
        ContentDispositionUtils.Attachment("zażółć.txt")
            .Should().Be("attachment; filename=\"zazo_c.txt\"; filename*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87.txt");
    }

    [Fact]
    public void Attachment_ReplacesCharactersThatWouldBreakTheQuotedFallback()
    {
        ContentDispositionUtils.Attachment("a\"b\\c.txt")
            .Should().StartWith("attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b%5Cc.txt");
    }

    // Found by the property tests (#70): Normalize threw on half a character, which would have been a 500.
    [Fact]
    public void Attachment_OfANameWithHalfACharacter_ReplacesIt_InsteadOfThrowing()
    {
        ContentDispositionUtils.Attachment("a\uD800.txt").Should().Be("attachment; filename=\"a_.txt\"");
    }

    [Theory]
    [InlineData("Zdjęcia z wakacji.zip")]
    [InlineData("報告書.pdf")]
    [InlineData("😀 party.png")]
    [InlineData("line\r\nbreak.txt")]
    [InlineData("it's.txt")]
    [InlineData("it's zażółć.txt")]
    public void Attachment_IsAlwaysPrintableAscii(string fileName)
    {
        var value = ContentDispositionUtils.Attachment(fileName);

        value.Should().MatchRegex(@"^[\x20-\x7E]+$", "Kestrel and S3 reject non-ASCII or control characters in header values");

        const string starPrefix = "filename*=UTF-8''";
        var starIndex = value.IndexOf(starPrefix, StringComparison.Ordinal);
        if (starIndex >= 0)
        {
            // A raw apostrophe would end the charset/language section of filename*.
            value[(starIndex + starPrefix.Length)..].Should().NotContain("'");
        }
    }
}
