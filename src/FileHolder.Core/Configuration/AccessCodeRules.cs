using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace FileHolder.Core.Configuration;

/// <summary>
/// What access codes look like and how they're checked (#169). A code is a label and 12 random characters in groups
/// of four, "a01-7F3K-9Q2M-X8PD": about 10^18 possibilities, so guessing one is hopeless even past the per-client rate
/// limit. Crockford's base32 alphabet leaves out I, L, O and U, so a code read aloud or retyped doesn't get mixed up.
/// </summary>
public static partial class AccessCodeRules
{
    /// <summary>How long a new code works unless it's given another expiry or none.</summary>
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromDays(30);

    public const int RandomLength = 12;
    private const int GroupLength = 4;
    private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// <summary>The longest code anyone could have; longer input is refused before hashing.</summary>
    public const int MaxCodeLength = 64;

    /// <summary>The same message for an unknown, expired or revoked code, so a refusal says nothing about which.</summary>
    public const string InvalidCodeMessage = "This access code isn't valid or has expired. You can still upload with the smaller limits.";

    // A neutral label: lowercase letters and digits, 1 to 20, starting with a letter. "a01" and "b7" match; "A01",
    // "01", "acme corp" and "a-01" don't.
    [GeneratedRegex(@"^[a-z][a-z0-9]{0,19}\z")]
    private static partial Regex LabelRegex();

    public static bool IsValidLabel(string? label) => label is not null && LabelRegex().IsMatch(label);

    /// <summary>A new code for <paramref name="label"/>: "a01-7F3K-9Q2M-X8PD".</summary>
    public static string Generate(string label)
    {
        var random = RandomNumberGenerator.GetString(Alphabet, RandomLength);
        var groups = Enumerable.Range(0, RandomLength / GroupLength).Select(i => random.Substring(i * GroupLength, GroupLength));
        return $"{label}-{string.Join('-', groups)}";
    }

    /// <summary>
    /// The form a code is compared in: no spaces, upper case, and the letters Crockford's base32 reads as digits
    /// (O as 0, I and L as 1), so a code retyped from a printed application still matches.
    /// </summary>
    public static string Normalize(string code)
    {
        var builder = new StringBuilder(code.Length);
        foreach (var c in code.Trim().ToUpperInvariant())
        {
            if (char.IsWhiteSpace(c)) continue;
            builder.Append(c switch { 'O' => '0', 'I' or 'L' => '1', _ => c });
        }

        return builder.ToString();
    }

    /// <summary>
    /// What's stored and looked up: SHA-256 of the normalized code, as base64. A fast hash suits a random 60-bit
    /// secret (as with kAuth): without the code there's nothing to guess from, and a code only unlocks upload limits.
    /// </summary>
    public static string Hash(string code) =>
        Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(code))));
}
