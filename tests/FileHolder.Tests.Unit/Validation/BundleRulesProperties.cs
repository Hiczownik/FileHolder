using System.Net.Http.Headers;
using System.Numerics;
using FileHolder.Api.Validation;
using FileHolder.Core.Configuration;
using FileHolder.Tests.Unit.Properties;
using FluentValidation;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Validation;

/// <summary>Rules the shared presign/confirm validation keeps for any input (BundleRules).</summary>
public class BundleRulesProperties
{
    public sealed record Sizes(List<long> Files);

    private sealed class PlainSizeValidator : AbstractValidator<Sizes>
    {
        public PlainSizeValidator(UploadLimitsOptions limits) => RuleFor(x => x.Files).MustFitBundleSizeLimit(size => size, limits);
    }

    private sealed class EncryptedSizeValidator : AbstractValidator<Sizes>
    {
        public EncryptedSizeValidator(UploadLimitsOptions limits) => RuleFor(x => x.Files).MustFitEncryptedBundleSizeLimit(size => size, limits);
    }

    public sealed record Text(string? Value);

    // FluentValidation won't validate a null root model, so the value is wrapped.
    private sealed class TextValidator : AbstractValidator<Text>
    {
        public TextValidator(Action<IRuleBuilder<Text, string?>> rules) => rules(RuleFor(x => x.Value));
    }

    public sealed record ContentType(string Value);

    private sealed class ContentTypeValidator : AbstractValidator<ContentType>
    {
        public ContentTypeValidator() => RuleFor(x => x.Value).MustBeValidContentType();
    }

    private static readonly Arbitrary<(long Max, List<long> Files)> LimitAndFilesArb =
        (from max in Gen.Frequency(
                (3, Gen.Constant(5L * 1024 * 1024 * 1024)),
                (1, Gen.Constant(long.MaxValue)),
                (1, Gen.Choose(1, int.MaxValue).Select(n => (long)n)))
         from files in Gen.Frequency(
                 (3, Gen.Choose(0, int.MaxValue).Select(n => n * 4L)),
                 (1, Gen.Choose(0, 1_000_000).Select(offset => long.MaxValue - offset)),
                 (1, Gen.Choose(0, int.MaxValue).Select(n => max / 2 + n)))
             .ListOf()
             .Select(list => list.Take(BundleRules.MaxFilesPerBundle).ToList())
         select (max, files)).ToArbitrary();

    private static bool FitsExactly(IEnumerable<long> files, long max) =>
        files.All(size => size <= max) && files.Aggregate(BigInteger.Zero, (total, size) => total + size) <= max;

    [FixedSeedProperty]
    public Property PlainBundleSize_IsAcceptedExactlyWhenEveryFileAndTheTotalFit() =>
        Prop.ForAll(LimitAndFilesArb, input =>
        {
            var limits = new UploadLimitsOptions { MaxBundleSizeBytes = input.Max };
            var valid = new PlainSizeValidator(limits).Validate(new Sizes(input.Files)).IsValid;
            return (valid == FitsExactly(input.Files, input.Max)).Label($"max {input.Max}, files [{string.Join(", ", input.Files)}]: valid {valid}");
        });

    [FixedSeedProperty]
    public Property EncryptedBundleSize_IsAcceptedExactlyWhenEveryFileAndTheTotalFitTheEncryptedLimit() =>
        Prop.ForAll(LimitAndFilesArb, input =>
        {
            var limits = new UploadLimitsOptions { MaxBundleSizeBytes = input.Max };
            var valid = new EncryptedSizeValidator(limits).Validate(new Sizes(input.Files)).IsValid;
            var encryptedMax = EncryptedStreamFormat.MaxEncryptedTotal(input.Max, input.Files.Count);
            return (valid == FitsExactly(input.Files, encryptedMax)).Label($"max {input.Max}, files [{string.Join(", ", input.Files)}]: valid {valid}");
        });

    private static readonly Gen<string> MediaTypePiece = Gen.Frequency(
        (10, Gen.Elements("text", "plain", "application", "pdf", "vnd.ms-excel", "image", "svg+xml", "charset", "utf-8", "x", "1")),
        (5, Gen.Elements("/", ";", "=", " ", "\t", ", ")),
        (2, Gen.Elements("\r", "\n", "\r\n", "\"", "(", ")", "<", "@", "\\", "é", "\u0000", "*", "{")));

    /// <summary>Mostly well-formed media types, some with stray characters, some random arrangements of the pieces.</summary>
    private static readonly Arbitrary<string> ContentTypeArb = Gen.Frequency(
            (3, from type in Gen.Elements("text", "application", "image")
                from subtype in Gen.Elements("plain", "pdf", "svg+xml", "vnd.ms-excel")
                from parameters in Gen.Elements("", "; charset=utf-8", ";charset=utf-8", "; a=b; c=d", " ;\tq=1")
                select $"{type}/{subtype}{parameters}"),
            (4, MediaTypePiece.ListOf().Select(string.Concat)))
        .ToArbitrary();

    [FixedSeedProperty]
    public Property ContentType_AcceptedValues_AreValidContentTypeHeaders() =>
        Prop.ForAll(ContentTypeArb, contentType =>
        {
            var valid = new ContentTypeValidator().Validate(new ContentType(contentType)).IsValid;
            var safe = !contentType.Contains('\r') && !contentType.Contains('\n') && MediaTypeHeaderValue.TryParse(contentType, out _);
            return (!valid || safe).Label($"accepted {Generators.Show(contentType)}");
        });

    private static readonly Arbitrary<string?> PasswordArb = Gen.Frequency(
            (1, Gen.Constant<string?>(null)),
            (5, from length in Gen.Choose(0, 120)
                from chars in Gen.Elements('a', 'Z', '7', ' ', '\t', ' ', '\n', 'ż').ArrayOf(length)
                select (string?)new string(chars)))
        .ToArbitrary();

    [FixedSeedProperty]
    public Property Password_IsAcceptedExactlyWhenEmptyOr4To100CharactersAndNotOnlyWhitespace() =>
        Prop.ForAll(PasswordArb, password =>
        {
            var valid = new TextValidator(rule => rule.MustBeValidPassword()).Validate(new Text(password)).IsValid;
            var expected = string.IsNullOrEmpty(password) || (!string.IsNullOrWhiteSpace(password) && password.Length is >= 4 and <= 100);
            return (valid == expected).Label($"{Generators.Show(password ?? "<null>")} (length {password?.Length}): valid {valid}");
        });
}
