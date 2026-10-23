using System.Text.Json;
using FileHolder.Core.Configuration;
using FileHolder.Tests.Unit.Properties;
using FluentAssertions;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Configuration;

/// <summary>
/// The server's check of a bundle's Argon2id settings, against tests/vectors/kdf-params.json, which the browser's
/// check reads too. Every mismatch is listed, not just the first.
/// </summary>
public class KeyDerivationParamsTests
{
    private static readonly Lazy<Vectors> Loaded = new(Load);

    [Fact]
    public void IsValid_GivesWhatTheVectorsSay()
    {
        var mismatches = Loaded.Value.Cases
            .Where(vector => KeyDerivationParams.IsValid(vector.Value) != vector.Valid)
            .Select(vector => $"{vector.Why}: expected valid = {vector.Valid} for {Generators.Show(vector.Value)}");

        mismatches.Should().BeEmpty();
    }

    [Fact]
    public void Vectors_AreThere()
    {
        // An empty or misplaced file would make the check above pass without checking anything.
        Loaded.Value.Cases.Should().HaveCountGreaterThan(40);
        Loaded.Value.Cases.Should().Contain(vector => vector.Valid).And.Contain(vector => !vector.Valid);
    }

    [Fact]
    public void IsValid_RefusesNull()
    {
        KeyDerivationParams.IsValid(null).Should().BeFalse();
    }

    [Fact]
    public void Format_WritesTheStartingSettingsAsTheBrowserDoes()
    {
        KeyDerivationParams.Format(65536, 3, 1).Should().Be("""{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1}""");
    }

    // Mostly around the limits, so both sides of each one are tried often; sometimes anything at all.
    private static Arbitrary<int> AroundArb(int min, int max, int margin) => Gen.Frequency(
        (4, Gen.Choose(min - margin, max + margin)),
        (1, Gen.Elements(min - 1, min, max, max + 1)),
        (1, Gen.Elements(int.MinValue, -1, 0, int.MaxValue))).ToArbitrary();

    private static readonly Arbitrary<int> MemoryArb =
        AroundArb(KeyDerivationParams.MinMemoryKib, KeyDerivationParams.MaxMemoryKib, 16 * 1024);
    private static readonly Arbitrary<int> IterationsArb =
        AroundArb(KeyDerivationParams.MinIterations, KeyDerivationParams.MaxIterations, 3);
    private static readonly Arbitrary<int> ParallelismArb =
        AroundArb(KeyDerivationParams.MinParallelism, KeyDerivationParams.MaxParallelism, 3);

    [FixedSeedProperty]
    public Property IsValid_AcceptsFormattedSettings_ExactlyWhenEveryOneIsWithinItsLimits() =>
        Prop.ForAll(MemoryArb, IterationsArb, ParallelismArb, (memoryKib, iterations, parallelism) =>
        {
            var withinLimits = memoryKib is >= KeyDerivationParams.MinMemoryKib and <= KeyDerivationParams.MaxMemoryKib
                               && iterations is >= KeyDerivationParams.MinIterations and <= KeyDerivationParams.MaxIterations
                               && parallelism is >= KeyDerivationParams.MinParallelism and <= KeyDerivationParams.MaxParallelism;

            return KeyDerivationParams.IsValid(KeyDerivationParams.Format(memoryKib, iterations, parallelism)) == withinLimits;
        });

    private static Vectors Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors", "kdf-params.json");
        return JsonSerializer.Deserialize<Vectors>(File.ReadAllText(path), JsonOptions)
            ?? throw new InvalidOperationException($"{path} is empty.");
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private sealed record Vectors(IReadOnlyList<Case> Cases);

    private sealed record Case(string Value, bool Valid, string Why);
}
