using FileHolder.Api.Diagnostics;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Diagnostics;

public class BuildInfoTests
{
    [Fact]
    public void AGitBuild_HasItsVersionAndShortCommit()
    {
        var build = BuildInfo.FromInformationalVersion("0.9.0+cbab80e26d5af1afc8738b6b934ac5ecf1267117");

        build.Version.Should().Be("0.9.0");
        build.Commit.Should().Be("cbab80e");
        build.ToString().Should().Be("0.9.0 (cbab80e)");
    }

    [Fact]
    public void ADockerBuild_KeepsAShortGitSha()
    {
        BuildInfo.FromInformationalVersion("0.9.0+abc12").Commit.Should().Be("abc12");
    }

    [Theory]
    [InlineData("0.9.0")]
    [InlineData("0.9.0+")]
    [InlineData("0.9.0+  ")]
    public void ABuildWithoutACommit_SaysSo(string informationalVersion)
    {
        var build = BuildInfo.FromInformationalVersion(informationalVersion);

        build.Version.Should().Be("0.9.0");
        build.Commit.Should().Be(BuildInfo.UnknownCommit);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void NoVersionAtAll_IsZero(string? informationalVersion)
    {
        BuildInfo.FromInformationalVersion(informationalVersion).Version.Should().Be("0.0.0");
    }

    [Fact]
    public void TheRunningApi_HasTheVersionFromDirectoryBuildProps()
    {
        // Built from git in tests, so the commit is known too.
        BuildInfo.Current.Version.Should().MatchRegex(@"^\d+\.\d+\.\d+");
        BuildInfo.Current.Commit.Should().NotBe(BuildInfo.UnknownCommit);
    }
}
