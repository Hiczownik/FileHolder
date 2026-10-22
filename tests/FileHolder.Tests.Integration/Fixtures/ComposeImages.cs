namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The container images docker-compose.yml runs, so the tests use exactly the pinned images the app runs with, and
/// an update to the compose file reaches them without a second edit.
/// </summary>
public static class ComposeImages
{
    public const string ComposeFileName = "docker-compose.yml";

    /// <summary>The folder holding FileHolder.sln and docker-compose.yml, found upwards from the test binaries.</summary>
    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    private static readonly Lazy<string[]> ComposeLines = new(() => File.ReadAllLines(Path.Combine(RepositoryRoot, ComposeFileName)));

    /// <summary>The PostgreSQL image of the <c>postgres</c> service.</summary>
    public static string Postgres => ImageOf("postgres");

    /// <summary>The Silo storage image of the <c>minio</c> service.</summary>
    public static string Silo => ImageOf("minio");

    /// <summary>
    /// The <c>image:</c> of a top-level service. Services sit two spaces in under <c>services:</c>, their settings
    /// deeper, so the service's block ends at the next line indented two spaces or less.
    /// </summary>
    public static string ImageOf(string service)
    {
        var lines = ComposeLines.Value;
        var start = Array.FindIndex(lines, line => line == $"  {service}:");
        if (start < 0)
        {
            throw new InvalidOperationException($"{ComposeFileName} has no service '{service}'.");
        }

        var image = lines
            .Skip(start + 1)
            .TakeWhile(line => line.Length == 0 || line.StartsWith("   ", StringComparison.Ordinal) || line.TrimStart().StartsWith('#'))
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.StartsWith("image:", StringComparison.Ordinal));

        return image?["image:".Length..].Trim()
            ?? throw new InvalidOperationException($"Service '{service}' in {ComposeFileName} has no image.");
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "FileHolder.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new InvalidOperationException($"FileHolder.sln not found above {AppContext.BaseDirectory}.");
    }
}
