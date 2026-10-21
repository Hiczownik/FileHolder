using System.Numerics;
using FileHolder.Core.Configuration;
using FileHolder.Tests.Unit.Properties;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Configuration;

/// <summary>
/// Size rules for encrypted files, checked against exact arithmetic (BigInteger can't overflow). The server bounds
/// uploads with these, so a wrap-around to a negative or small number would let anything through, or nothing.
/// </summary>
public class EncryptedStreamFormatProperties
{
    private const long Chunk = EncryptedStreamFormat.ChunkPlaintextBytes;
    private const long Tag = EncryptedStreamFormat.TagBytes;
    private const int MaxFiles = 50; // BundleRules.MaxFilesPerBundle
    private static readonly BigInteger LongMax = long.MaxValue;

    /// <summary>n + max(1, ceil(n / chunk)) × 16, exactly.</summary>
    private static BigInteger ExactEncryptedSize(long plaintextBytes)
    {
        BigInteger chunks = BigInteger.Max(BigInteger.One, (new BigInteger(plaintextBytes) + Chunk - 1) / Chunk);
        return plaintextBytes + chunks * Tag;
    }

    private static long Saturated(BigInteger value) => value > LongMax ? long.MaxValue : (long)value;

    [FixedSeedProperty]
    public Property EncryptedSize_IsOneTagPerChunk_OrLongMaxValueWhenThatDoesntFit() =>
        Prop.ForAll(Generators.SizeArb, n =>
        {
            var size = EncryptedStreamFormat.EncryptedSize(n);
            return (size == Saturated(ExactEncryptedSize(n))).Label($"EncryptedSize({n}) = {size}, exactly {ExactEncryptedSize(n)}");
        });

    [FixedSeedProperty]
    public Property EncryptedSize_NeverShrinksAsTheFileGrows() =>
        Prop.ForAll(Generators.SizeArb, Generators.SizeArb, (a, b) =>
        {
            var (smaller, larger) = a <= b ? (a, b) : (b, a);
            return (EncryptedStream(smaller) <= EncryptedStream(larger)).Label($"{smaller} -> {EncryptedStream(smaller)}, {larger} -> {EncryptedStream(larger)}");
        });

    private static long EncryptedStream(long n) => EncryptedStreamFormat.EncryptedSize(n);

    [FixedSeedProperty]
    public Property EncryptedSize_AddsAtLeastOneTag() =>
        Prop.ForAll(Generators.SizeArb, n =>
            (EncryptedStreamFormat.EncryptedSize(n) >= Saturated(new BigInteger(n) + Tag)).Label($"EncryptedSize({n}) = {EncryptedStreamFormat.EncryptedSize(n)}"));

    private static readonly Arbitrary<int> FileCountArb = Gen.Choose(1, MaxFiles).ToArbitrary();

    [FixedSeedProperty]
    public Property MaxEncryptedTotal_NeverOverflows() =>
        Prop.ForAll(Generators.SizeArb, FileCountArb, (max, files) =>
        {
            var total = EncryptedStreamFormat.MaxEncryptedTotal(max, files);
            BigInteger exact = new BigInteger(max) + ((new BigInteger(max) + Chunk - 1) / Chunk + files) * Tag;
            return (total == Saturated(exact)).Label($"MaxEncryptedTotal({max}, {files}) = {total}, exactly {exact}");
        });

    /// <summary>A limit, a file count, and the limit split into that many file sizes (adding up to at most the limit).</summary>
    private static readonly Arbitrary<(long Max, long[] Sizes)> SplitArb =
        (from max in Gen.Frequency(
                (3, Gen.Choose(0, 100_000_000).Select(n => (long)n)),
                (2, Gen.Choose(0, int.MaxValue).Select(n => n * 16L)))
         from files in Gen.Choose(1, MaxFiles)
         from weights in Gen.Choose(0, 1000).ArrayOf(files)
         from fill in Gen.Choose(0, 100)
         let budget = max * fill / 100
         let weightSum = Math.Max(1, weights.Sum())
         select (max, weights.Select(w => budget / weightSum * w).ToArray())).ToArbitrary();

    [FixedSeedProperty]
    public Property AnySplitOfTheLimit_EncryptsToNoMoreThanMaxEncryptedTotal() =>
        Prop.ForAll(SplitArb, split =>
        {
            var encrypted = split.Sizes.Sum(EncryptedStreamFormat.EncryptedSize);
            var bound = EncryptedStreamFormat.MaxEncryptedTotal(split.Max, split.Sizes.Length);
            return (encrypted <= bound).Label($"max {split.Max}, sizes [{string.Join(", ", split.Sizes)}]: {encrypted} > {bound}");
        });
}
