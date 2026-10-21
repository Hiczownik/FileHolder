using System.Text.RegularExpressions;
using FileHolder.Core.Security;
using FileHolder.Tests.Unit.Properties;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Security;

/// <summary>Rules the download header must keep for any file name (see ContentDispositionUtilsTests for examples).</summary>
public partial class ContentDispositionUtilsProperties
{
    private const string StarPrefix = "; filename*=UTF-8''";

    // An RFC 6266 attachment: a quoted ASCII fallback with no '"' or '\' inside, then optionally filename* holding the
    // name percent-encoded, using only RFC 3986 unreserved characters and %XX. Matches
    // "attachment; filename=\"a_b.txt\"; filename*=UTF-8''a%20b.txt"; rejects "attachment; filename=\"a\"b\"".
    [GeneratedRegex("""^attachment; filename="[^"\\]*"(; filename\*=UTF-8''[A-Za-z0-9%._~-]*)?$""")]
    private static partial Regex Rfc6266Shape();

    /// <summary>The name with each half character (a lone surrogate, which UTF-8 can't encode) replaced by "_".</summary>
    private static string WithWholeCharacters(string name)
    {
        var builder = new System.Text.StringBuilder(name.Length);
        var remaining = name.AsSpan();
        while (!remaining.IsEmpty)
        {
            var decoded = System.Text.Rune.DecodeFromUtf16(remaining, out _, out var consumed);
            builder.Append(decoded == System.Buffers.OperationStatus.Done ? remaining[..consumed] : "_");
            remaining = remaining[consumed..];
        }

        return builder.ToString();
    }

    private static string? StarValue(string header)
    {
        var index = header.IndexOf(StarPrefix, StringComparison.Ordinal);
        return index < 0 ? null : header[(index + StarPrefix.Length)..];
    }

    [FixedSeedProperty]
    public Property Attachment_IsAlwaysPrintableAscii() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var header = ContentDispositionUtils.Attachment(name);
            return header.All(c => c is >= ' ' and <= '~').Label($"{Generators.Show(name)} -> {Generators.Show(header)}");
        });

    [FixedSeedProperty]
    public Property Attachment_HasTheRfc6266Shape() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var header = ContentDispositionUtils.Attachment(name);
            return Rfc6266Shape().IsMatch(header).Label($"{Generators.Show(name)} -> {Generators.Show(header)}");
        });

    [FixedSeedProperty]
    public Property Attachment_FilenameStarDecodesBackToTheName() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var header = ContentDispositionUtils.Attachment(name);
            var star = StarValue(header);
            // Without filename*, the quoted fallback is the name itself.
            var decoded = star is null ? header["attachment; filename=\"".Length..^1] : Uri.UnescapeDataString(star);
            return (decoded == WithWholeCharacters(name)).Label($"{Generators.Show(name)} -> {Generators.Show(header)}");
        });

    [FixedSeedProperty]
    public Property Attachment_OfAPlainAsciiName_HasNoFilenameStar() =>
        Prop.ForAll(Generators.SafeNameArb, name => ContentDispositionUtils.Attachment(name) == $"attachment; filename=\"{name}\"");
}
