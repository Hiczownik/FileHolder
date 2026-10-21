using FileHolder.Core.Security;
using FileHolder.Tests.Unit.Properties;
using FluentAssertions;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Security;

/// <summary>Share tokens: the right length, only allowed characters, and no character favoured.</summary>
public class ShortTokenTests
{
    private const string Alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    [FixedSeedProperty]
    public Property GenerateShortToken_HasTheRequestedLength_AndOnlyAllowedCharacters() =>
        Prop.ForAll(Gen.Choose(0, 64).ToArbitrary(), length =>
        {
            var token = CryptoUtils.GenerateShortToken(length);
            return (token.Length == length && token.All(Alphabet.Contains)).Label($"length {length}: \"{token}\"");
        });

    [Fact]
    public void GenerateShortToken_FavoursNoCharacter()
    {
        // 800,000 characters over 62 symbols: about 12,900 each. RandomNumberGenerator can't be seeded, so instead of a
        // fixed seed the threshold is generous: for 61 degrees of freedom, chi-squared exceeds 130 by chance only about
        // once in a million runs, while a bias like "% 62" on random bytes (#48's kind of bug) gives about 5,000.
        const int Tokens = 100_000;
        const int TokenLength = 8;
        const double Threshold = 130;

        var counts = new int[Alphabet.Length];
        for (int i = 0; i < Tokens; i++)
        {
            foreach (var c in CryptoUtils.GenerateShortToken(TokenLength))
            {
                counts[Alphabet.IndexOf(c)]++;
            }
        }

        double expected = (double)Tokens * TokenLength / Alphabet.Length;
        double chiSquared = counts.Sum(observed => (observed - expected) * (observed - expected) / expected);

        chiSquared.Should().BeLessThan(Threshold);
    }
}
