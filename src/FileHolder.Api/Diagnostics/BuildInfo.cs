using System.Diagnostics.Metrics;
using System.Reflection;
using FileHolder.Infrastructure.Services;

namespace FileHolder.Api.Diagnostics;

/// <summary>
/// Which build of the API is running: the version from Directory.Build.props and the commit it was built from,
/// both read from the assembly's informational version ("0.9.0+abc1234…"). Shown in the health output,
/// GET /api/v1/status, the startup log and the trace service version, and exposed as
/// fileholder_build_info{version,commit} 1, so Grafana can mark deploys.
/// </summary>
public sealed class BuildInfo
{
    public const string BuildInfoInstrument = "fileholder.build.info";
    public const string UnknownCommit = "unknown";
    private const int ShortCommitLength = 7;

    public static BuildInfo Current { get; } = FromInformationalVersion(
        typeof(BuildInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);

    public string Version { get; }

    /// <summary>The commit's first 7 characters, or <see cref="UnknownCommit"/> for a build without one.</summary>
    public string Commit { get; }

    private BuildInfo(string version, string commit)
    {
        Version = version;
        Commit = commit;
    }

    /// <summary>"0.9.0+abc1234def…" → 0.9.0 and abc1234. A build without a commit (no git, no GIT_SHA) has none.</summary>
    public static BuildInfo FromInformationalVersion(string? informationalVersion)
    {
        if (string.IsNullOrWhiteSpace(informationalVersion))
        {
            return new BuildInfo("0.0.0", UnknownCommit);
        }

        var parts = informationalVersion.Split('+', 2);
        var revision = parts.Length == 2 ? parts[1].Trim() : string.Empty;
        var commit = revision.Length == 0 ? UnknownCommit : revision[..Math.Min(ShortCommitLength, revision.Length)];
        return new BuildInfo(parts[0].Trim(), commit);
    }

    public override string ToString() => $"{Version} ({Commit})";

    /// <summary>Registers fileholder_build_info: always 1, with the build in its labels.</summary>
    public static void AddMetric(IMeterFactory meterFactory, BuildInfo build)
    {
        var meter = meterFactory.Create(StorageLifecycleStatus.MeterName);
        meter.CreateObservableGauge(
            BuildInfoInstrument,
            () => new Measurement<int>(1,
                new KeyValuePair<string, object?>("version", build.Version),
                new KeyValuePair<string, object?>("commit", build.Commit)),
            description: "Always 1; the running build is in the version and commit labels.");
    }
}
