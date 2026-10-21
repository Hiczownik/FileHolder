using System.Globalization;
using System.Text;

namespace FileHolder.Core.Security;

public static class FileSecurityUtils
{
    private static readonly HashSet<string> ForbiddenExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".bat", ".sh", ".cmd", ".dll", ".ps1", ".vbs", ".js", ".scr", ".pif", ".application", ".msi", ".com",
        ".hta", ".jar", ".lnk", ".msc", ".vbe", ".wsf", ".cpl", ".reg", ".iso"
    };

    // 190 + 64 = 254, which fits the varchar(255) FileName column.
    private const int MaxBodyLength = 190;
    private const int MaxExtensionLength = 64;
    private const int MaxStoredLength = 255;
    private const string FallbackName = "unnamed_file";

    public static bool IsExtensionForbidden(string fileName)
    {
        // Check the name as it will be stored: sanitizing drops characters from the extension,
        // so "evil.exe " or "evil.e x e" would otherwise pass here and still be saved as "evil.exe".
        var (_, ext) = SplitExtension(SanitizeFileName(fileName));
        return ext.Length > 0 && ForbiddenExtensions.Contains(ext);
    }

    /// <summary>
    /// Reduces a name to a single safe path segment. The same steps as sanitizeFileName in the UI, which applies them
    /// to encrypted bundles: keep only what follows the last "/" or "\" (on any OS, so "C:\x\evil.bat" is "evil.bat"
    /// on the Linux server too); drop trailing dots and spaces, which Windows drops on saving; replace each code point
    /// that isn't a letter, mark, digit, connector, "." or "-" with "_" in the body, and drop it from the extension;
    /// cap both without splitting a character; and drop trailing dots and spaces again, since removing characters can
    /// leave the name ending in one ("a.\u001C" would otherwise become "a.", saved by Windows as "a").
    /// </summary>
    public static string SanitizeFileName(string fileName)
    {
        // Removing characters can move the name's last dot, and with it what counts as the extension ("..\u001C_.x$"
        // gives "._", whose own extension is the whole name), so one pass isn't always final. Repeating until nothing
        // changes makes sanitizing idempotent; it settles within a pass or two, as passes only remove characters
        // (except the fallback name, which is stable).
        var current = SanitizeOnce(fileName);
        for (int pass = 1; pass < MaxSanitizePasses; pass++)
        {
            var next = SanitizeOnce(current);
            if (next == current)
            {
                break;
            }

            current = next;
        }

        return current;
    }

    private const int MaxSanitizePasses = 5;

    private static string SanitizeOnce(string fileName)
    {
        var lastSeparator = fileName.LastIndexOfAny(PathSeparators);
        var baseName = fileName[(lastSeparator + 1)..].TrimEnd(TrailingDropped);

        var (body, extension) = SplitExtension(baseName);
        var sanitizedBody = Truncate(KeepAllowed(body, replacement: "_"), MaxBodyLength);
        // Capped too, so even "unnamed_file" plus the extension fits the varchar(255) FileName column.
        var sanitizedExt = Truncate(KeepAllowed(extension, replacement: ""), MaxExtensionLength);
        var finalName = $"{sanitizedBody}{sanitizedExt}".TrimEnd(TrailingDropped);

        // Names made only of dots, like "." or "..", mean a folder to extractors, so they fall back too.
        if (finalName.Length == 0 || finalName == sanitizedExt || IsDotsOnly(finalName))
        {
            return IsDotsOnly(sanitizedExt) || sanitizedExt.Length == 0 ? FallbackName : $"{FallbackName}{sanitizedExt}";
        }

        return finalName;
    }

    private static readonly char[] PathSeparators = ['/', '\\'];
    private static readonly char[] TrailingDropped = ['.', ' '];

    /// <summary>Splits like .NET's Path.GetExtension: from the last dot, with no extension when the name ends in one.</summary>
    private static (string Body, string Extension) SplitExtension(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot < 0 || dot == name.Length - 1 ? (name, string.Empty) : (name[..dot], name[dot..]);
    }

    /// <summary>
    /// Keeps letters, marks, decimal digits, connectors ("_"), "." and "-", code point by code point, as the UI's
    /// /[^\p{L}\p{M}\p{Nd}\p{Pc}.-]/gu does; anything else, a half character included, becomes <paramref name="replacement"/>.
    /// </summary>
    private static string KeepAllowed(string text, string replacement)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
        {
            if (IsAllowed(rune))
            {
                builder.Append(rune.ToString());
            }
            else
            {
                builder.Append(replacement);
            }
        }

        return builder.ToString();
    }

    private static bool IsAllowed(Rune rune) =>
        rune.Value is '.' or '-' || Rune.GetUnicodeCategory(rune) switch
        {
            UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
                or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter => true,
            UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark => true,
            UnicodeCategory.DecimalDigitNumber or UnicodeCategory.ConnectorPunctuation => true,
            _ => false,
        };

    /// <summary>The first <paramref name="maxLength"/> UTF-16 units, one fewer if that would cut a surrogate pair in half.</summary>
    private static string Truncate(string text, int maxLength)
    {
        if (text.Length <= maxLength)
        {
            return text;
        }

        return char.IsHighSurrogate(text[maxLength - 1]) ? text[..(maxLength - 1)] : text[..maxLength];
    }

    /// <summary>
    /// Makes names unique ignoring case (Windows and macOS file systems do), so no file overwrites another when
    /// a bundle is extracted to one folder: "a.txt", "A.txt" becomes "a.txt", "A (2).txt". Mirrors
    /// makeFileNamesUnique in the UI, which does the same for encrypted bundles.
    /// </summary>
    public static IReadOnlyList<string> MakeFileNamesUnique(IReadOnlyList<string> fileNames)
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unique = new List<string>(fileNames.Count);

        foreach (var name in fileNames)
        {
            var candidate = name;
            var (body, extension) = SplitExtension(name);

            // The first duplicate becomes "name (2).ext": the original counts as copy 1.
            var copy = 1;
            while (taken.Contains(candidate))
            {
                copy++;
                // A name already as long as allowed loses the end of its body to make room for " (n)".
                var suffix = $" ({copy}){extension}";
                candidate = $"{Truncate(body, MaxStoredLength - suffix.Length)}{suffix}";
            }

            taken.Add(candidate);
            unique.Add(candidate);
        }

        return unique;
    }

    public static string GenerateStorageKey(string fileName)
    {
        var sanitized = SanitizeFileName(fileName);
        return $"uploads/{Guid.NewGuid():N}_{sanitized}";
    }

    private static bool IsDotsOnly(string name) => name.Length > 0 && name.All(c => c == '.');
}