using FileHolder.Core.Security;
using FluentValidation;

namespace FileHolder.Api.Validation;

/// <summary>
/// Rules shared by presign and confirm. Confirm is what persists the bundle, so it must enforce
/// everything presign does; keeping the rules here stops the two from drifting apart.
/// </summary>
public static class BundleRules
{
    public const int MaxFilesPerBundle = 50;
    public const long MaxBundleSizeBytes = 5_497_558_138_880L; // 5 TB

    public static IRuleBuilderOptions<T, string> MustBeAllowedFileName<T>(this IRuleBuilder<T, string> rule) =>
        rule.NotEmpty().WithMessage("File name is required.")
            .MaximumLength(255).WithMessage("File name cannot exceed 255 characters.")
            .Must(fileName => !FileSecurityUtils.IsExtensionForbidden(fileName))
            .WithMessage("Forbidden file extension detected. Executable files and scripts are not allowed.");

    public static IRuleBuilderOptions<T, string> MustBeValidContentType<T>(this IRuleBuilder<T, string> rule) =>
        rule.NotEmpty().WithMessage("Content type is required.")
            .MaximumLength(128).WithMessage("Content type cannot exceed 128 characters.");

    public static IRuleBuilderOptions<T, long> MustBeValidFileSize<T>(this IRuleBuilder<T, long> rule) =>
        rule.GreaterThan(0).WithMessage("File size must be greater than 0 bytes.");

    public static IRuleBuilderOptions<T, string?> MustBeValidTitle<T>(this IRuleBuilder<T, string?> rule) =>
        rule.MaximumLength(255).WithMessage("Title cannot exceed 255 characters.");

    public static IRuleBuilderOptions<T, int?> MustBeValidExpiry<T>(this IRuleBuilder<T, int?> rule) =>
        rule.InclusiveBetween(1, 168)
            .WithMessage("Expiration time must be between 1 hour and 168 hours (7 days).");

    public static IRuleBuilderOptions<T, int?> MustBeValidMaxDownloads<T>(this IRuleBuilder<T, int?> rule) =>
        rule.InclusiveBetween(1, 1000)
            .WithMessage("Max downloads must be between 1 and 1000.");

    public static IRuleBuilderOptions<T, string?> MustBeValidPassword<T>(this IRuleBuilder<T, string?> rule) =>
        rule.Must(password => string.IsNullOrEmpty(password) || password.Length is >= 4 and <= 100)
            .WithMessage("Password must be between 4 and 100 characters.");
}
