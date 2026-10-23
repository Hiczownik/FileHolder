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
        rule.Must(files => FitsWithin(files, sizeBytes, limits.MaxBundleSizeBytes))
            .WithMessage($"The bundle cannot be larger than {FormatSize(limits.MaxBundleSizeBytes)} in total.");

    /// <summary>
    /// The same limit for an encrypted bundle. Its files are sized after encryption, so the limit allows for the
    /// 16-byte tag on every chunk: a bundle of exactly the limit in plaintext still fits.
    /// </summary>
    public static IRuleBuilderOptions<T, List<TFile>> MustFitEncryptedBundleSizeLimit<T, TFile>(
        this IRuleBuilder<T, List<TFile>> rule, Func<TFile, long> sizeBytes, UploadLimitsOptions limits) =>
        rule.Must(files => files == null
                           || FitsWithin(files, sizeBytes, EncryptedStreamFormat.MaxEncryptedTotal(limits.MaxBundleSizeBytes, files.Count)))
            .WithMessage($"The bundle cannot be larger than {FormatSize(limits.MaxBundleSizeBytes)} in total.");

    // Summed as Int128, which 50 (or any realistic number of) longs can't overflow: under a configured limit near
    // long.MaxValue, files that each fit could otherwise add up past it, and checked long addition throws.
    private static bool FitsWithin<TFile>(List<TFile>? files, Func<TFile, long> sizeBytes, long maxTotal) =>
        files == null || (files.All(f => sizeBytes(f) <= maxTotal)
                          && files.Aggregate(Int128.Zero, (total, file) => total + sizeBytes(file)) <= maxTotal);

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

    // The server must never receive an encrypted bundle's title in plain text: it goes in EncryptedTitle.
    public static IRuleBuilderOptions<T, string?> MustBeEmptyForEncryptedBundles<T>(this IRuleBuilder<T, string?> rule) =>
        rule.Empty().WithMessage("Titles of encrypted bundles must be encrypted.");

    // Required: the purge only removes a bundle's storage once it expires or runs out of downloads,
    // so a bundle with neither limit would keep its files forever.
    public static IRuleBuilderOptions<T, int?> MustBeValidExpiry<T>(this IRuleBuilder<T, int?> rule) =>
        rule.NotNull().WithMessage("Expiration time is required.")
            .InclusiveBetween(BundleLimits.MinExpiryHours, BundleLimits.MaxExpiryHours)
            .WithMessage(string.Create(CultureInfo.InvariantCulture,
                $"Expiration time must be between {BundleLimits.MinExpiryHours} hour and {BundleLimits.MaxExpiryHours} hours ({BundleLimits.MaxExpiry.TotalDays:0.#} days)."));

    public static IRuleBuilderOptions<T, int?> MustBeValidMaxDownloads<T>(this IRuleBuilder<T, int?> rule) =>
        rule.InclusiveBetween(1, 1000)
            .WithMessage("Max downloads must be between 1 and 1000.");

    // A media type of RFC 6838 restricted names, with optional unquoted parameters. It is echoed back as the
    // download's Content-Type, so nothing else gets through: "text/plain; charset=utf-8" and
    // "application/vnd.ms-excel" match; "application.pdf", "text/html\r\nX-Evil: 1" and "a/b c" don't.
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:[ \t]*;[ \t]*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$")]
    private static partial Regex ContentTypeRegex();

    // Required for encrypted bundles: without any one of them no recipient can ever open the bundle.
    public static IRuleBuilderOptions<T, string?> MustBeKeyMaterial<T>(this IRuleBuilder<T, string?> rule, string name, int maxLength) =>
        rule.NotEmpty().WithMessage($"{name} is required for encrypted uploads.")
            .MaximumLength(maxLength).WithMessage($"{name} cannot exceed {maxLength} characters.")
            .Must(value => value is null || Base64UrlRegex().IsMatch(value))
            .WithMessage($"{name} must be base64url-encoded.");

    // The recipient's browser runs these settings, so only bounded Argon2id ones are stored (KeyDerivationParams).
    public static IRuleBuilderOptions<T, string?> MustBeSupportedKdfParams<T>(this IRuleBuilder<T, string?> rule) =>
        rule.NotEmpty().WithMessage("Key derivation settings are required with a passkey.")
            .Must(KeyDerivationParams.IsValid)
            .WithMessage(string.Create(CultureInfo.InvariantCulture,
                $"Key derivation settings must be Argon2id version {KeyDerivationParams.Argon2Version} with {KeyDerivationParams.MinMemoryKib}–{KeyDerivationParams.MaxMemoryKib} KiB of memory, {KeyDerivationParams.MinIterations}–{KeyDerivationParams.MaxIterations} passes and {KeyDerivationParams.MinParallelism}–{KeyDerivationParams.MaxParallelism} lanes."));

    // Unpadded base64url, as the browser encodes key material: "q3-_Zx0" matches; "q3+/Zx0=" and "a b" don't.
    [GeneratedRegex(@"^[A-Za-z0-9_-]+$")]
    private static partial Regex Base64UrlRegex();

    // An encrypted bundle sends its kAuth as the password: 32 bytes from HKDF, as unpadded base64url. Only that shape
    // is accepted, since it is stored with a fast hash (CryptoUtils.HashAuthKey) that only suits random values.
    public static IRuleBuilderOptions<T, string?> MustBeAuthKey<T>(this IRuleBuilder<T, string?> rule) =>
        rule.NotEmpty().WithMessage("Encrypted uploads must send their derived key.")
            .Must(value => value is null || AuthKeyRegex().IsMatch(value))
            .WithMessage("The derived key of an encrypted upload must be 43 base64url characters.");

    // Exactly 43 base64url characters, as 32 bytes encode unpadded: "q3-_" followed by 39 more matches; a 42-character
    // value, one with "=" padding, or "k_auth_derived_token_123" doesn't.
    // https://regex101.com/?regex=%5E%5BA-Za-z0-9_-%5D%7B43%7D%24&testString=q3-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%0Ak_auth_derived_token_123
    [GeneratedRegex(@"^[A-Za-z0-9_-]{43}$")]
    private static partial Regex AuthKeyRegex();

    public static IRuleBuilderOptions<T, string?> MustBeValidPassword<T>(this IRuleBuilder<T, string?> rule) =>
        // Whitespace-only is refused, not treated as "no password": CryptoUtils.HashPassword stores no hash for it,
        // so the bundle would quietly end up unprotected although the uploader asked for a password.
        rule.Must(password => string.IsNullOrEmpty(password)
                              || (!string.IsNullOrWhiteSpace(password) && password.Length is >= 4 and <= 100))
            .WithMessage("Password must be between 4 and 100 characters, and not only spaces.");
}
