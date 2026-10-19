using System.Globalization;
using System.Text.RegularExpressions;
using FileHolder.Core.Configuration;
using FileHolder.Core.Security;
using FluentValidation;

namespace FileHolder.Api.Validation;

/// <summary>
/// Rules shared by presign and confirm. Confirm is what persists the bundle, so it must enforce
/// everything presign does; keeping the rules here stops the two from drifting apart.
/// </summary>
public static partial class BundleRules
{
    public const int MaxFilesPerBundle = 50;

    /// <summary>
    /// "5 GB" for 5 GiB, matching how the UI formats sizes.
    /// </summary>
    public static string FormatSize(long bytes) =>
        bytes % (1024L * 1024 * 1024) == 0
            ? string.Create(CultureInfo.InvariantCulture, $"{bytes / (1024L * 1024 * 1024)} GB")
            : string.Create(CultureInfo.InvariantCulture, $"{bytes / (1024.0 * 1024 * 1024):0.##} GB");

    /// <summary>
    /// Total size of the bundle's files, against the configured limit. Upload URLs are signed for these sizes,
    /// so this is also the most an uploader can put into storage per presign.
    /// </summary>
    public static IRuleBuilderOptions<T, List<TFile>> MustFitBundleSizeLimit<T, TFile>(
        this IRuleBuilder<T, List<TFile>> rule, Func<TFile, long> sizeBytes, UploadLimitsOptions limits) =>
        // Each file is checked first so that huge declared sizes are rejected instead of overflowing the sum.
        rule.Must(files => files == null
                           || (files.All(f => sizeBytes(f) <= limits.MaxBundleSizeBytes)
                               && files.Sum(sizeBytes) <= limits.MaxBundleSizeBytes))
            .WithMessage($"The bundle cannot be larger than {FormatSize(limits.MaxBundleSizeBytes)} in total.");

    /// <summary>
    /// Encrypted files are sized after encryption, so the limit allows for the encryption overhead.
    /// </summary>
    public static IRuleBuilderOptions<T, long> MustFitEncryptedFileLimit<T>(this IRuleBuilder<T, long> rule, UploadLimitsOptions limits) =>
        rule.LessThanOrEqualTo(limits.MaxEncryptedFileSizeBytes + UploadLimitsOptions.EncryptionOverheadBytes)
            .WithMessage($"Encrypted files cannot be larger than {FormatSize(limits.MaxEncryptedFileSizeBytes)} each.");

    public static IRuleBuilderOptions<T, string> MustBeAllowedFileName<T>(this IRuleBuilder<T, string> rule) =>
        rule.NotEmpty().WithMessage("File name is required.")
            .MaximumLength(255).WithMessage("File name cannot exceed 255 characters.")
            .Must(fileName => !FileSecurityUtils.IsExtensionForbidden(fileName))
            .WithMessage("Forbidden file extension detected. Executable files and scripts are not allowed.");

    public static IRuleBuilderOptions<T, string> MustBeValidContentType<T>(this IRuleBuilder<T, string> rule) =>
        rule.NotEmpty().WithMessage("Content type is required.")
            .MaximumLength(128).WithMessage("Content type cannot exceed 128 characters.")
            .Must(contentType => ContentTypeRegex().IsMatch(contentType))
            .WithMessage("Content type must be a media type like \"application/pdf\".");

    public static IRuleBuilderOptions<T, long> MustBeValidFileSize<T>(this IRuleBuilder<T, long> rule) =>
        rule.GreaterThan(0).WithMessage("File size must be greater than 0 bytes.");

    public static IRuleBuilderOptions<T, string?> MustBeValidTitle<T>(this IRuleBuilder<T, string?> rule) =>
        rule.MaximumLength(255).WithMessage("Title cannot exceed 255 characters.");

    // Required: the purge only removes a bundle's storage once it expires or runs out of downloads,
    // so a bundle with neither limit would keep its files forever.
    public static IRuleBuilderOptions<T, int?> MustBeValidExpiry<T>(this IRuleBuilder<T, int?> rule) =>
        rule.NotNull().WithMessage("Expiration time is required.")
            .InclusiveBetween(1, 168)
            .WithMessage("Expiration time must be between 1 hour and 168 hours (7 days).");

    public static IRuleBuilderOptions<T, int?> MustBeValidMaxDownloads<T>(this IRuleBuilder<T, int?> rule) =>
        rule.InclusiveBetween(1, 1000)
            .WithMessage("Max downloads must be between 1 and 1000.");

    // A media type of RFC 6838 restricted names, with optional unquoted parameters. It is echoed back as the
    // download's Content-Type, so nothing else gets through: "text/plain; charset=utf-8" and
    // "application/vnd.ms-excel" match; "application.pdf", "text/html\r\nX-Evil: 1" and "a/b c" don't.
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:[ \t]*;[ \t]*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$")]
    private static partial Regex ContentTypeRegex();

    public static IRuleBuilderOptions<T, string?> MustBeValidPassword<T>(this IRuleBuilder<T, string?> rule) =>
        rule.Must(password => string.IsNullOrEmpty(password) || password.Length is >= 4 and <= 100)
            .WithMessage("Password must be between 4 and 100 characters.");
}
