using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using FileHolder.Core.Security;
using FileHolder.Tests.Unit.Properties;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Security;

/// <summary>
/// The server's file-name rules against tests/vectors/file-names.json, which the UI's fileNameVectors.test.ts
/// generates and checks too, so the two copies give the same answers. Every mismatch is listed, not just the first.
/// </summary>
public class FileNameVectorTests
{
    private static readonly Lazy<Vectors> Loaded = new(Load);

    [Fact]
    public void SanitizeFileName_GivesWhatTheVectorsSay()
    {
        var mismatches = Loaded.Value.Names
            .Select(vector => (Name: vector.Input.Value, Expected: vector.Sanitized, Actual: FileSecurityUtils.SanitizeFileName(vector.Input.Value)))
            .Where(result => result.Actual != result.Expected)
            .Select(result => $"{Generators.Show(result.Name)}: browser {Generators.Show(result.Expected)}, server {Generators.Show(result.Actual)}");

        mismatches.Should().BeEmpty();
    }

    [Fact]
    public void IsExtensionForbidden_GivesWhatTheVectorsSay()
    {
        var mismatches = Loaded.Value.Names
            .Where(vector => FileSecurityUtils.IsExtensionForbidden(vector.Input.Value) != vector.Forbidden)
            .Select(vector => $"{Generators.Show(vector.Input.Value)}: browser says forbidden = {vector.Forbidden}");

        mismatches.Should().BeEmpty();
    }

    [Fact]
    public void MakeFileNamesUnique_GivesWhatTheVectorsSay()
    {
        var mismatches = Loaded.Value.Lists
            .Select(vector => (vector.Names, Expected: vector.Unique, Actual: FileSecurityUtils.MakeFileNamesUnique(vector.Names)))
            .Where(result => !result.Actual.SequenceEqual(result.Expected))
            .Select(result => $"{Show(result.Names)}: browser {Show(result.Expected)}, server {Show(result.Actual)}");

        mismatches.Should().BeEmpty();
    }

    [Fact]
    public void Vectors_AreThere()
    {
        // An empty or misplaced file would make the checks above pass without checking anything.
        Loaded.Value.Names.Should().HaveCountGreaterThan(100);
        Loaded.Value.Lists.Should().HaveCountGreaterThan(100);
        Loaded.Value.Names.Should().Contain(vector => vector.Input.NameUtf16 != null, "names with half a character must be covered");
    }

    private static string Show(IEnumerable<string> names) => $"[{string.Join(", ", names.Select(Generators.Show))}]";

    private static Vectors Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors", "file-names.json");
        return JsonSerializer.Deserialize<Vectors>(File.ReadAllText(path), JsonOptions)
            ?? throw new InvalidOperationException($"{path} is empty.");
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private sealed record Vectors(IReadOnlyList<NameVector> Names, IReadOnlyList<ListVector> Lists);

    private sealed record NameVector(StoredName Input, string Sanitized, bool Forbidden);

    private sealed record ListVector(IReadOnlyList<string> Names, IReadOnlyList<string> Unique);

    /// <summary>
    /// A name as the file stores it: as a string, or, when it holds half a character (which System.Text.Json won't
    /// read from an escape), as its UTF-16 units in hex, "0061 D800".
    /// </summary>
    private sealed record StoredName(string? Name, string? NameUtf16)
    {
        [JsonIgnore]
        public string Value => Name ?? new string(NameUtf16!
            .Split(' ')
            .Select(unit => (char)ushort.Parse(unit, NumberStyles.HexNumber, CultureInfo.InvariantCulture))
            .ToArray());
    }
}
