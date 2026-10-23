using System.Security.Cryptography;

namespace FileHolder.Core.Security;

public static class CryptoUtils
{
    private const string CharacterPool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    // bcrypt hashes start with "$2"; this can't be mistaken for one.
    private const string AuthKeyHashPrefix = "sha256:";

    public static string GenerateShortToken(int length = 8)
    {
        return string.Create(length, CharacterPool, (span, pool) =>
        {
            for (int i = 0; i < span.Length; i++)
            {
                span[i] = pool[RandomNumberGenerator.GetInt32(pool.Length)];
            }
        });
    }

    public static string? HashPassword(string? plainTextPassword)
    {
        return string.IsNullOrWhiteSpace(plainTextPassword) ? null : BCrypt.Net.BCrypt.HashPassword(PreHash(plainTextPassword), workFactor: 11);
    }

    /// <summary>
    /// The stored form of an encrypted bundle's kAuth: its SHA-256, tagged so <see cref="VerifyPassword"/> can tell
    /// it from a bcrypt hash. kAuth is 32 random bytes derived in the browser (validated as such), so a slow hash adds
    /// nothing against guessing it, while bcrypt's 100-200 ms per check is CPU anyone could make the server spend (#78).
    /// </summary>
    public static string HashAuthKey(string authKey) =>
        AuthKeyHashPrefix + Convert.ToBase64String(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(authKey)));

    public static bool VerifyPassword(string plainTextPassword, string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return true;
        if (string.IsNullOrEmpty(plainTextPassword)) return false;
        if (hash.StartsWith(AuthKeyHashPrefix, StringComparison.Ordinal))
        {
            // Constant time, so how much of a guess matches can't be read from how long the check takes.
            return CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(HashAuthKey(plainTextPassword)),
                System.Text.Encoding.UTF8.GetBytes(hash));
        }
        return BCrypt.Net.BCrypt.Verify(PreHash(plainTextPassword), hash);
    }

    /// <summary>
    /// bcrypt reads only the first 72 bytes, and a password may be 100 characters (up to 400 UTF-8 bytes), so two
    /// long passwords sharing their first 72 bytes would unlock the same bundle (#53). The SHA-256 digest in base64 is
    /// 44 ASCII characters: always under the limit, and never a NUL byte that bcrypt would stop at.
    /// </summary>
    private static string PreHash(string plainTextPassword) =>
        Convert.ToBase64String(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(plainTextPassword)));
}