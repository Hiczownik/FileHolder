using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

/// <summary>
/// The smaller limits of an upload without an access code (#169), checked by presign after the usual validation
/// (CreatePresignedUrlValidator), which already holds every upload to the full limits a code unlocks.
/// </summary>
public class WithoutCodeLimitsValidator : AbstractValidator<CreatePresignedUrlRequestDto>
{
    public const string AccessCodeHint = "An access code allows more.";

    public WithoutCodeLimitsValidator(UploadLimitsOptions withoutCode)
    {
        var size = $"Without an access code, a bundle can be at most {BundleRules.FormatSize(withoutCode.MaxBundleSizeBytes)} in total. {AccessCodeHint}";
        When(x => !x.IsEncrypted, () => RuleFor(x => x.Files).MustFitBundleSizeLimit(f => f.SizeBytes, withoutCode).WithMessage(size));
        When(x => x.IsEncrypted, () => RuleFor(x => x.Files).MustFitEncryptedBundleSizeLimit(f => f.SizeBytes, withoutCode).WithMessage(size));

        RuleFor(x => x.ExpireInHours)
            .LessThanOrEqualTo(withoutCode.MaxExpiryHours)
            .WithMessage($"Without an access code, a bundle can live at most {BundleRules.DescribeHours(withoutCode.MaxExpiryHours)}. {AccessCodeHint}");
    }
}
