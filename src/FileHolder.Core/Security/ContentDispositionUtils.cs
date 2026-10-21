using System.Buffers;
using System.Globalization;
using System.Text;

namespace FileHolder.Core.Security;

public static class ContentDispositionUtils
{
    /// <summary>
    /// Builds an attachment Content-Disposition value that is pure ASCII, so it is valid in any HTTP header,
    /// while keeping non-ASCII names intact for browsers: <c>filename</c> carries an ASCII fallback and
    /// <c>filename*</c> (RFC 6266 / RFC 5987) carries the UTF-8 name, which browsers prefer when present.
    /// </summary>
    public static string Attachment(string fileName)
    {
        // Half a character (a lone surrogate) can't be normalized or encoded as UTF-8, and would throw below.
        // Sanitized names never hold one; this keeps a bad name from turning a download into a 500.
        fileName = WithWholeCharacters(fileName);
        var fallback = ToAsciiFallback(fileName);
        var value = $"attachment; filename=\"{fallback}\"";

        // Only add filename* when it says something the fallback doesn't.
        return fallback == fileName
            ? value
            : $"{value}; filename*=UTF-8''{Uri.EscapeDataString(fileName)}";
    }

    /// <summary>
    /// Strips diacritics, then replaces anything that is not printable ASCII, or that would break the quoted
    /// string, with "_". "zażółć.txt" becomes "zazo_c.txt": "ł" is a separate letter, not "l" plus a mark.
    /// Stripping needs ICU; under invariant globalization (the Alpine runtime image) Normalize leaves accented
    /// letters whole, so they become "_" too ("za____.txt"). Browsers use filename* and never see the fallback.
    /// </summary>
    /// <summary>The name with each lone surrogate replaced by "_", as SanitizeFileName does; surrogate pairs stay.</summary>
    private static string WithWholeCharacters(string fileName)
    {
        if (!fileName.Any(char.IsSurrogate))
        {
            return fileName;
        }

        var builder = new StringBuilder(fileName.Length);
        var remaining = fileName.AsSpan();
        while (!remaining.IsEmpty)
        {
            var decoded = Rune.DecodeFromUtf16(remaining, out _, out var consumed);
            if (decoded == OperationStatus.Done)
            {
                builder.Append(remaining[..consumed]);
            }
            else
            {
                builder.Append('_');
            }

            remaining = remaining[consumed..];
        }

        return builder.ToString();
    }

    private static string ToAsciiFallback(string fileName)
    {
        var decomposed = fileName.Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);

        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            builder.Append(c is >= ' ' and <= '~' and not '"' and not '\\' ? c : '_');
        }

        return builder.ToString();
    }
}
