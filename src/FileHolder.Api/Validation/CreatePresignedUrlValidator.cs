using FileHolder.Core.Dtos;
using FileHolder.Core.Configuration;
using FluentValidation;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Validation;

public class CreatePresignedUrlValidator : AbstractValidator<CreatePresignedUrlRequestDto>
{
    public CreatePresignedUrlValidator(IOptions<UploadLimitsOptions> uploadLimits)
    {
        RuleFor(x => x.Title).MustBeValidTitle();
        // Presign doesn't store the title, but an encrypted upload shouldn't send it at all.
        When(x => x.IsEncrypted, () => RuleFor(x => x.Title).MustBeEmptyForEncryptedBundles());

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one file is required.")
            .Must(files => files is { Count: >= 1 and <= BundleRules.MaxFilesPerBundle })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        var limits = uploadLimits.Value;

        When(x => !x.IsEncrypted, () => RuleFor(x => x.Files).MustFitBundleSizeLimit(f => f.SizeBytes, limits));
        When(x => x.IsEncrypted, () => RuleFor(x => x.Files).MustFitEncryptedBundleSizeLimit(f => f.SizeBytes, limits));

        RuleForEach(x => x.Files).ChildRules(file =>
        {
            file.RuleFor(f => f.FileName).MustBeAllowedFileName();
            file.RuleFor(f => f.ContentType).MustBeValidContentType();
            file.RuleFor(f => f.SizeBytes).MustBeValidFileSize();
        });

        RuleFor(x => x.ExpireInHours).MustBeValidExpiry(limits);
        RuleFor(x => x.MaxDownloads).MustBeValidMaxDownloads();
        When(x => x.IsEncrypted, () => RuleFor(x => x.Password).MustBeAuthKey())
            .Otherwise(() => RuleFor(x => x.Password).MustBeValidPassword());
    }
}
