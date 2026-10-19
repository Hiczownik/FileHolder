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
