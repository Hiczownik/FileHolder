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
        return string.IsNullOrWhiteSpace(plainTextPassword) ? null : BCrypt.Net.BCrypt.HashPassword(plainTextPassword, workFactor: 11);
    }

    public static bool VerifyPassword(string plainTextPassword, string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return true;
        if (string.IsNullOrEmpty(plainTextPassword)) return false;
        return BCrypt.Net.BCrypt.Verify(plainTextPassword, hash);
    }
}