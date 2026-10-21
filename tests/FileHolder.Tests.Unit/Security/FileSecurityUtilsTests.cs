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
