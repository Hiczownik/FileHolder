using FileHolder.Core.Security;
using FileHolder.Tests.Unit.Properties;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Security;

/// <summary>
/// Rules FileSecurityUtils must keep for any name. The examples in FileSecurityUtilsTests pin past bugs; these try
/// thousands of generated names (see <see cref="Generators"/>). fileNameSafety.ts in the UI keeps the same rules.
/// </summary>
public class FileSecurityUtilsProperties
{
    private const int MaxStoredLength = 255; // the varchar(255) FileName column

    private static bool IsDotsOnly(string name) => name.Length > 0 && name.All(c => c == '.');

    /// <summary>Whether every surrogate is part of a pair: Postgres can't store half a character.</summary>
    private static bool IsValidUtf16(string text)
    {
        var remaining = text.AsSpan();
        while (!remaining.IsEmpty)
        {
            if (System.Text.Rune.DecodeFromUtf16(remaining, out _, out var consumed) != System.Buffers.OperationStatus.Done)
            {
                return false;
            }

            remaining = remaining[consumed..];
        }

        return true;
    }

    [FixedSeedProperty]
    public Property SanitizeFileName_GivesAStorableName() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var sanitized = FileSecurityUtils.SanitizeFileName(name);
            return (sanitized.Length > 0).Label($"not empty: {Generators.Show(name)} -> {Generators.Show(sanitized)}")
                .And(!IsDotsOnly(sanitized)).Label("not dots only")
                .And(sanitized.Length <= MaxStoredLength).Label("fits varchar(255)")
                .And(IsValidUtf16(sanitized)).Label("no half characters");
        });

    [FixedSeedProperty]
    public Property SanitizeFileName_GivesASinglePathSegmentWithoutControlCharacters() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var sanitized = FileSecurityUtils.SanitizeFileName(name);
            return (!sanitized.Contains('/') && !sanitized.Contains('\\')).Label($"no path separators: {Generators.Show(name)} -> {Generators.Show(sanitized)}")
                .And(!sanitized.Any(char.IsControl)).Label("no control characters, CR or LF");
        });

    [FixedSeedProperty]
    public Property SanitizeFileName_NeverEndsInADotOrSpace() =>
        // Windows drops them on saving, so "evil.bat." would land on disk as "evil.bat".
        Prop.ForAll(Generators.NameArb, name =>
        {
            var sanitized = FileSecurityUtils.SanitizeFileName(name);
            return (!sanitized.EndsWith('.') && !sanitized.EndsWith(' ')).Label($"{Generators.Show(name)} -> {Generators.Show(sanitized)}");
        });

    [FixedSeedProperty]
    public Property SanitizeFileName_IsIdempotent() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            var once = FileSecurityUtils.SanitizeFileName(name);
            var twice = FileSecurityUtils.SanitizeFileName(once);
            return (twice == once).Label($"{Generators.Show(name)} -> {Generators.Show(once)} -> {Generators.Show(twice)}");
        });

    [FixedSeedProperty]
    public Property SanitizeFileName_LeavesSafeNamesUnchanged() =>
        Prop.ForAll(Generators.SafeNameArb, name => FileSecurityUtils.SanitizeFileName(name) == name);

    [FixedSeedProperty]
    public Property IsExtensionForbidden_CatchesBlockedExtensionsWhateverIsAddedThatSavingRemoves() =>
        Prop.ForAll(Generators.BlockedNameArb, name => FileSecurityUtils.IsExtensionForbidden(name)
            .Label($"{Generators.Show(name)} stored as {Generators.Show(FileSecurityUtils.SanitizeFileName(name))}"));

    [FixedSeedProperty]
    public Property IsExtensionForbidden_IsTrueWheneverTheNameAsSavedHasABlockedExtension() =>
        Prop.ForAll(Generators.NameArb, name =>
        {
            // What Windows writes to disk: the stored name without trailing dots and spaces.
            var onDisk = FileSecurityUtils.SanitizeFileName(name).TrimEnd('.', ' ');
            var dot = onDisk.LastIndexOf('.');
            var extension = dot < 0 ? string.Empty : onDisk[dot..];
            var blocked = Generators.BlockedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase);
            return (!blocked || FileSecurityUtils.IsExtensionForbidden(name)).Label($"{Generators.Show(name)} saved as {Generators.Show(onDisk)}");
        });

    [FixedSeedProperty]
    public Property MakeFileNamesUnique_GivesNamesUniqueIgnoringCase_InTheSameOrder() =>
        Prop.ForAll(Generators.CollidingNamesArb, names =>
        {
            var unique = FileSecurityUtils.MakeFileNamesUnique(names);
            return (unique.Count == names.Length).Label("same count")
                .And(unique.Distinct(StringComparer.OrdinalIgnoreCase).Count() == unique.Count).Label("unique ignoring case")
                .And(unique.Zip(names).All(pair => IsNameOrNumberedCopy(pair.First, pair.Second))).Label("each is its own name or a numbered copy of it");
        });

    /// <summary>"a.txt" itself, or "a (n).txt" (its body may be shortened to make room for the number).</summary>
    private static bool IsNameOrNumberedCopy(string candidate, string original)
    {
        if (candidate == original)
        {
            return true;
        }

        var dot = original.LastIndexOf('.');
        var extension = dot <= 0 ? string.Empty : original[dot..];
        var body = original[..^extension.Length];
        if (!candidate.EndsWith(extension, StringComparison.Ordinal))
        {
            return false;
        }

        var withoutExtension = candidate[..^extension.Length];
        var open = withoutExtension.LastIndexOf(" (", StringComparison.Ordinal);
        return open >= 0
               && withoutExtension.EndsWith(')')
               && int.TryParse(withoutExtension[(open + 2)..^1], out var copy) && copy >= 2
               && body.StartsWith(withoutExtension[..open], StringComparison.Ordinal);
    }

    [FixedSeedProperty]
    public Property MakeFileNamesUnique_LeavesUniqueListsUnchanged() =>
        Prop.ForAll(Generators.CollidingNamesArb, names =>
        {
            var alreadyUnique = names.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            return FileSecurityUtils.MakeFileNamesUnique(alreadyUnique).SequenceEqual(alreadyUnique);
        });

    [FixedSeedProperty]
    public Property MakeFileNamesUnique_KeepsEveryNameStorable() =>
        Prop.ForAll(Generators.CollidingNamesArb, names =>
            FileSecurityUtils.MakeFileNamesUnique(names).All(name =>
                name.Length <= MaxStoredLength && !IsDotsOnly(name) && !name.EndsWith('.') && !name.EndsWith(' ')));
}
