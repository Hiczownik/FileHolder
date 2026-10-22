using System.Security.Cryptography;

namespace FileHolder.Core.Security;

public static class CryptoUtils
{
    private const string CharacterPool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

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

    public static bool VerifyPassword(string plainTextPassword, string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return true;
        if (string.IsNullOrEmpty(plainTextPassword)) return false;
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