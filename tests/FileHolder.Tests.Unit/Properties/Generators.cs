using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Properties;

/// <summary>Inputs for the property tests: the kinds of names and values that have broken things before.</summary>
public static class Generators
{
    /// <summary>The server's blocked extensions (FileSecurityUtils.ForbiddenExtensions).</summary>
    public static readonly string[] BlockedExtensions =
    [
        ".exe", ".bat", ".sh", ".cmd", ".dll", ".ps1", ".vbs", ".js", ".scr", ".pif", ".application", ".msi", ".com",
        ".hta", ".jar", ".lnk", ".msc", ".vbe", ".wsf", ".cpl", ".reg", ".iso",
    ];

    /// <summary>
    /// The name with everything outside printable ASCII escaped as \uXXXX, for failure messages: FsCheck can't print
    /// control characters or half characters, and these are what a failing input usually holds.
    /// </summary>
    public static string Show(string text) =>
        "\"" + string.Concat(text.Select(c => c is >= ' ' and <= '~' and not '\\' and not '"' ? c.ToString() : $"\\u{(int)c:X4}")) + "\"";

    private static Gen<string> Range(int first, int last) =>
        Gen.Choose(first, last).Select(codePoint => char.ConvertFromUtf32(codePoint));

    private static Gen<string> Utf16Range(int first, int last) =>
        Gen.Choose(first, last).Select(unit => ((char)unit).ToString());

    /// <summary>One character (or short run) of a name, weighted towards what has caused trouble.</summary>
    public static readonly Gen<string> Piece = Gen.Frequency(
        (30, Range(0x20, 0x7E)),                                      // printable ASCII
        (10, Gen.Elements(".", " ", "..", ". ", " .", "...")),          // runs of dots and spaces
        (6, Gen.Elements("/", "\\", "C:\\", "../", "..\\", "//")),      // paths
        (6, Range(0xC0, 0x24F)),                                      // accented Latin
        (4, Range(0x400, 0x4FF)),                                     // Cyrillic
        (4, Range(0x900, 0x97F)),                                     // Devanagari, with spacing vowel signs (Mc)
        (4, Range(0x590, 0x6FF)),                                     // Hebrew and Arabic (right to left)
        (4, Range(0x4E00, 0x9FFF)),                                   // CJK
        (4, Range(0x300, 0x36F)),                                     // combining marks
        (2, Range(0x20D0, 0x20F0)),                                   // enclosing marks (Me)
        (3, Gen.Elements("\u200B", "\u200C", "\u200D", "\uFEFF", "\u202E")), // zero-width, BOM, right-to-left override
        (3, Utf16Range(0x00, 0x1F)),                                  // control characters, CR, LF, tab
        (1, Gen.Constant("\u007F")),
        (4, Range(0x1F300, 0x1FAFF)),                                 // emoji (surrogate pairs)
        (2, Range(0x20000, 0x2A6DF)),                                 // letters outside the BMP (surrogate pairs)
        (1, Utf16Range(0xD800, 0xDFFF)));                             // lone surrogates

    private static string Concat(IEnumerable<string> pieces) => string.Concat(pieces);

    private static readonly Gen<string> ShortText = Piece.ListOf().Select(Concat);

    /// <summary>Any name: short, very long (up to 2,000 pieces), or a body and an extension.</summary>
    public static readonly Gen<string> Name = Gen.Frequency(
        (6, ShortText),
        (1, Gen.Choose(0, 2000).SelectMany(length => Piece.ArrayOf(length)).Select(Concat)),
        (4, Gen.Zip(ShortText, ShortText).Select(parts => $"{parts.Item1}.{parts.Item2}")));

    public static Arbitrary<string> NameArb => Name.ToArbitrary();

    private static readonly Gen<char> SafeChar =
        Gen.Elements("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".ToCharArray());

    /// <summary>Names that are already safe: [A-Za-z0-9_-]{1,50} plus ".pdf".</summary>
    public static Arbitrary<string> SafeNameArb =>
        Gen.Choose(1, 50).SelectMany(length => SafeChar.ArrayOf(length)).Select(chars => new string(chars) + ".pdf").ToArbitrary();

    /// <summary>Characters sanitizing removes from an extension: none of them is a letter, mark, digit, "_", "-" or ".".</summary>
    private static readonly Gen<string> RemovableJunk = Gen.Elements(" ", "\t", "#", "!", "(", ")", "\u200B", "\u00A0", "\r", "\n", "%", "$");

    private static Gen<string> RandomCase(string text) =>
        Gen.Choose(0, (1 << text.Length) - 1).Select(mask => new string(
            text.Select((c, index) => ((mask >> index) & 1) == 1 ? char.ToUpperInvariant(c) : c).ToArray()));

    /// <summary>
    /// A blocked extension in random case with junk inside it that sanitizing removes ("e x#e"), then trailing dots
    /// and spaces that Windows drops on saving ("evil.exe. ."), after any body.
    /// </summary>
    public static Arbitrary<string> BlockedNameArb =>
        (from body in Name
         from extension in Gen.Elements(BlockedExtensions).SelectMany(RandomCase)
         from junked in Gen.CollectToArray(extension.Skip(1), c =>
             Gen.Frequency((3, Gen.Constant(c.ToString())), (1, RemovableJunk.Select(junk => junk + c))))
         from trailing in Gen.Elements(".", " ").ListOf().Select(Concat)
         select $"{body}.{string.Concat(junked)}{trailing}").ToArbitrary();

    /// <summary>
    /// Lists of names that collide a lot, ignoring case, including names that already look like numbered copies and
    /// names as long as sanitizing allows.
    /// </summary>
    public static Arbitrary<string[]> CollidingNamesArb =>
        Gen.Elements(
                "a.txt", "A.txt", "a (2).txt", "A (3).TXT", "b", "B", "notes.pdf", "NOTES.PDF", "x.tar.gz", "X.TAR.GZ",
                "unnamed_file", new string('a', 190) + "." + new string('b', 63), new string('A', 190) + "." + new string('B', 63))
            .ArrayOf()
            .ToArbitrary();

    /// <summary>Byte counts: small, around chunk boundaries, large, and near long.MaxValue.</summary>
    public static Arbitrary<long> SizeArb => Gen.Frequency(
            (3, Gen.Choose(0, 100_000).Select(n => (long)n)),
            (3, Gen.Choose(-3, 3).SelectMany(offset => Gen.Choose(0, 1024).Select(chunks => chunks * 4L * 1024 * 1024 + offset)).Where(n => n >= 0)),
            (3, Gen.Choose(0, int.MaxValue).Select(n => (long)n * 64)),
            (1, Gen.Choose(0, 1_000_000).Select(offset => long.MaxValue - offset)))
        .ToArbitrary();
}
