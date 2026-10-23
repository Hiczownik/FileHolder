using System.Globalization;
using System.Text.Json;

namespace FileHolder.Core.Configuration;

/// <summary>
/// How the browser stretched a bundle's passkey: Argon2id settings, stored with the bundle as
/// <c>{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1}</c> (<c>m</c> in KiB). The uploader chooses them, and a
/// recipient's browser runs them, so they are bounded: a hostile bundle must not be able to ask for gigabytes of
/// memory or hours of work. The browser checks the same limits before deriving anything (#78), against the same
/// cases in tests/vectors/kdf-params.json.
/// </summary>
public static class KeyDerivationParams
{
    public const int MaxLength = 256;

    public const string Argon2id = "argon2id";

    /// <summary>Argon2 version 1.3 (0x13), the only one RFC 9106 specifies.</summary>
    public const int Argon2Version = 19;

    public const int MinMemoryKib = 16 * 1024;
    public const int MaxMemoryKib = 256 * 1024;
    public const int MinIterations = 1;
    public const int MaxIterations = 10;
    public const int MinParallelism = 1;
    public const int MaxParallelism = 4;

    private static readonly string[] Keys = ["alg", "v", "m", "t", "p"];

    /// <summary>
    /// Whether <paramref name="value"/> is supported settings, written exactly as <see cref="Format"/> writes them.
    /// Only that one spelling is accepted (no spaces, other key orders, duplicate keys or "3.0"), so the server and
    /// the browser can't read the same text differently.
    /// </summary>
    public static bool IsValid(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxLength) return false;

        try
        {
            using var document = JsonDocument.Parse(value);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            if (!Keys.All(key => root.TryGetProperty(key, out _))) return false;

            if (root.GetProperty("alg").ValueKind != JsonValueKind.String || root.GetProperty("alg").GetString() != Argon2id) return false;
            if (!TryGetInt(root, "v", out var version) || version != Argon2Version) return false;
            if (!TryGetInt(root, "m", out var memoryKib) || memoryKib is < MinMemoryKib or > MaxMemoryKib) return false;
            if (!TryGetInt(root, "t", out var iterations) || iterations is < MinIterations or > MaxIterations) return false;
            if (!TryGetInt(root, "p", out var parallelism) || parallelism is < MinParallelism or > MaxParallelism) return false;

            return value == Format(memoryKib, iterations, parallelism);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>The one accepted spelling of these Argon2id settings.</summary>
    public static string Format(int memoryKib, int iterations, int parallelism) =>
        string.Create(CultureInfo.InvariantCulture,
            $$"""{"alg":"{{Argon2id}}","v":{{Argon2Version}},"m":{{memoryKib}},"t":{{iterations}},"p":{{parallelism}}}""");

    private static bool TryGetInt(JsonElement root, string key, out int value)
    {
        value = 0;
        var element = root.GetProperty(key);
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out value);
    }
}
