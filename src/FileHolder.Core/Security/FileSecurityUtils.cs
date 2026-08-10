using System.Text.RegularExpressions;
    
namespace FileHolder.Core.Security;

public static partial class FileSecurityUtils
{
    private static readonly HashSet<string> ForbiddenExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".bat", ".sh", ".cmd", ".dll", ".ps1", ".vbs", ".js", ".scr", ".pif", ".application", ".msi", ".com"
    };

    public static bool IsExtensionForbidden(string fileName)
    {
        var ext = Path.GetExtension(fileName);
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