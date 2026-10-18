using System.Text.RegularExpressions;

namespace FileHolder.Core.Security;

public static partial class FileSecurityUtils
{
    private static readonly HashSet<string> ForbiddenExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".bat", ".sh", ".cmd", ".dll", ".ps1", ".vbs", ".js", ".scr", ".pif", ".application", ".msi", ".com",
        ".hta", ".jar", ".lnk", ".msc", ".vbe", ".wsf", ".cpl", ".reg", ".iso"
    };

    public static bool IsExtensionForbidden(string fileName)
    {
        // Check the name as it will be stored: sanitizing drops characters from the extension,
        // so "evil.exe " or "evil.e x e" would otherwise pass here and still be saved as "evil.exe".
        var ext = Path.GetExtension(SanitizeFileName(fileName));
        return !string.IsNullOrWhiteSpace(ext) && ForbiddenExtensions.Contains(ext);
    }

    public static string SanitizeFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return "unnamed_file";

        string extension = Path.GetExtension(fileName);
        string nameWithoutExt = Path.GetFileNameWithoutExtension(fileName);

        string sanitizedBody = InvalidCharRegex().Replace(nameWithoutExt, "_");

        if (sanitizedBody.Length > 190)
        {
            sanitizedBody = sanitizedBody[..190];
        }

        string sanitizedExt = InvalidCharRegex().Replace(extension, "");

        string finalName = $"{sanitizedBody}{sanitizedExt}";

        return string.IsNullOrWhiteSpace(finalName) || finalName == sanitizedExt ? $"unnamed_file{sanitizedExt}" : finalName;
    }

    public static string GenerateStorageKey(string fileName)
    {
        var sanitized = SanitizeFileName(fileName);
        return $"uploads/{Guid.NewGuid():N}_{sanitized}";
    }

    [GeneratedRegex(@"[^\w\.\-]", RegexOptions.Compiled)]
    private static partial Regex InvalidCharRegex();
}