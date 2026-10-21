using FileHolder.Core.Security;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Security;

public class FileSecurityUtilsTests
{
    [Theory]
    [InlineData("evil.exe")]
    [InlineData("EVIL.EXE")]
    [InlineData("evil.exe ")]
    [InlineData("evil.e x e")]
    [InlineData("evil.e\tx\te")]
    [InlineData("evil.e#xe")]
    [InlineData("installer.hta")]
    [InlineData("shortcut.lnk")]
    [InlineData("app.jar")]
    public void IsExtensionForbidden_RejectsNamesThatAreStoredWithAForbiddenExtension(string fileName)
    {
        FileSecurityUtils.IsExtensionForbidden(fileName).Should().BeTrue();
    }

    [Theory]
    [InlineData("report.pdf")]
    [InlineData("archive.tar.gz")]
    [InlineData("exe.pdf")]
    [InlineData("notes")]
    [InlineData("zażółć.txt")]
    public void IsExtensionForbidden_AllowsOrdinaryNames(string fileName)
    {
        FileSecurityUtils.IsExtensionForbidden(fileName).Should().BeFalse();
    }

    [Fact]
    public void SanitizeFileName_OfABypassAttempt_YieldsTheExtensionTheCheckSees()
    {
        // The check and the stored name must agree, or the check can be sidestepped.
        FileSecurityUtils.SanitizeFileName("evil.exe ").Should().Be("evil.exe");
    }

    [Theory]
    [InlineData(".", "unnamed_file")]
    [InlineData("..", "unnamed_file")]
    [InlineData("...", "unnamed_file")]
    [InlineData("....", "unnamed_file")]
    [InlineData(".env", "unnamed_file.env")]
    [InlineData("report.pdf", "report.pdf")]
    public void SanitizeFileName_FallsBackForNamesMadeOnlyOfDots(string fileName, string expected)
    {
        FileSecurityUtils.SanitizeFileName(fileName).Should().Be(expected);
    }

    public static TheoryData<string> AwkwardNames() => new()
    {
        "",
        "   ",
        ".",
        "..",
        "...",
        "." + new string('a', 254),
        new string('a', 255),
        new string('a', 200) + "." + new string('b', 54),
        new string('.', 255),
        "a." + new string('b', 252),
        new string(' ', 100) + "." + new string('c', 100),
    };

    [Theory]
    [MemberData(nameof(AwkwardNames))]
    public void SanitizeFileName_AlwaysFitsTheFileNameColumn_AndIsNeverEmptyOrDotsOnly(string fileName)
    {
        var sanitized = FileSecurityUtils.SanitizeFileName(fileName);

        sanitized.Should().NotBeNullOrWhiteSpace();
        sanitized.Length.Should().BeLessThanOrEqualTo(255);
        sanitized.Should().NotMatchRegex(@"^\.+$");
    }

    [Fact]
    public void SanitizeFileName_OfANameThatIsOnlyALongExtension_CapsTheExtension()
    {
        FileSecurityUtils.SanitizeFileName("." + new string('a', 254))
            .Should().Be("unnamed_file." + new string('a', 63));
    }

    // Found by the property tests (#70). Windows drops trailing dots and spaces on saving, so a stored "evil.bat."
    // would land on disk as "evil.bat"; the UI already stripped them first.
    [Theory]
    [InlineData("evil.bat..", "evil.bat")]
    [InlineData("invoice.exe. .", "invoice.exe")]
    [InlineData("霔⃟.ǎ.LNk..", "霔⃟.ǎ.LNk")]
    public void SanitizeFileName_DropsTrailingDotsAndSpaces_SoTheBlockedExtensionIsSeen(string fileName, string expected)
    {
        FileSecurityUtils.SanitizeFileName(fileName).Should().Be(expected);
        FileSecurityUtils.IsExtensionForbidden(fileName).Should().BeTrue();
    }

    [Fact]
    public void SanitizeFileName_DropsTrailingDotsLeftWhenCharactersAreRemoved()
    {
        // The control character goes from the extension, which would leave "Ŋॐ.".
        FileSecurityUtils.SanitizeFileName("Ŋॐ.\u001C").Should().Be("Ŋॐ");
    }

    [Fact]
    public void SanitizeFileName_IsStableWhenRemovingCharactersMovesTheExtension()
    {
        // One pass gives "._", whose own extension is the whole name; the result must not change when sanitized again.
        var sanitized = FileSecurityUtils.SanitizeFileName(". . $");

        sanitized.Should().Be("unnamed_file._");
        FileSecurityUtils.SanitizeFileName(sanitized).Should().Be(sanitized);
    }

    [Theory]
    [InlineData(@"C:\Users\me\evil.bat", "evil.bat")]
    [InlineData(@"..\..\Startup\x.bat", "x.bat")]
    [InlineData("../../Startup/x.bat", "x.bat")]
    public void SanitizeFileName_KeepsOnlyTheLastPathSegment_OnAnyOperatingSystem(string fileName, string expected)
    {
        // The server runs on Linux, where .NET's Path only splits on "/": "\" used to stay in the name as "_".
        FileSecurityUtils.SanitizeFileName(fileName).Should().Be(expected);
    }

    [Theory]
    [InlineData("a\u20DF.txt", "a\u20DF.txt")]       // an enclosing mark stays, as in the UI (\p{M})
    [InlineData("हिंदी.txt", "हिंदी.txt")]             // spacing vowel signs (Mc) stay
    public void SanitizeFileName_KeepsEveryKindOfMark_LikeTheUi(string fileName, string expected)
    {
        FileSecurityUtils.SanitizeFileName(fileName).Should().Be(expected);
    }

    // Facts, not InlineData: xUnit's theory data serialization can break surrogate pairs apart.
    [Fact]
    public void SanitizeFileName_ReplacesAnEmojiWithOneUnderscore_AsItIsOneCharacter()
    {
        FileSecurityUtils.SanitizeFileName("a\U0001F600b.txt").Should().Be("a_b.txt");
    }

    [Fact]
    public void SanitizeFileName_ReplacesHalfACharacter()
    {
        FileSecurityUtils.SanitizeFileName("a\uD800b.txt").Should().Be("a_b.txt");
    }

    [Fact]
    public void SanitizeFileName_NeverCutsACharacterInHalf()
    {
        // A letter outside the BMP (two UTF-16 units) straddling the 190-unit body limit is dropped whole.
        var body = new string('a', 189) + "\U00020000" + "bbb";

        FileSecurityUtils.SanitizeFileName(body + ".txt").Should().Be(new string('a', 189) + ".txt");
    }

    [Fact]
    public void MakeFileNamesUnique_ShortensAMaximumLengthNameToFitItsCopyNumber()
    {
        var longest = new string('a', 190) + "." + new string('b', 63);

        var unique = FileSecurityUtils.MakeFileNamesUnique([longest, longest.ToUpperInvariant()]);

        unique[1].Should().HaveLength(255).And.EndWith(" (2)." + new string('B', 63));
    }

    [Fact]
    public void MakeFileNamesUnique_NumbersDuplicatesIgnoringCase_AndLeavesUniqueNamesAlone()
    {
        FileSecurityUtils.MakeFileNamesUnique(["a.txt", "A.txt", "a.txt", "b.txt", "notes"])
            .Should().Equal("a.txt", "A (2).txt", "a (3).txt", "b.txt", "notes");
    }

    [Fact]
    public void MakeFileNamesUnique_SkipsACopyNumberAnotherFileAlreadyUses()
    {
        FileSecurityUtils.MakeFileNamesUnique(["a.txt", "a (2).txt", "a.txt"])
            .Should().Equal("a.txt", "a (2).txt", "a (3).txt");
    }
}
