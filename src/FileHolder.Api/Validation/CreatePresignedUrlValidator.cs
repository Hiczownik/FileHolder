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

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one file is required.")
            .Must(files => files is { Count: >= 1 and <= BundleRules.MaxFilesPerBundle })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        var limits = uploadLimits.Value;

        RuleFor(x => x.Files).MustFitBundleSizeLimit(f => f.SizeBytes, limits);

        When(x => x.IsEncrypted, () =>
            RuleForEach(x => x.Files).ChildRules(file => file.RuleFor(f => f.SizeBytes).MustFitEncryptedFileLimit(limits)));

        RuleForEach(x => x.Files).ChildRules(file =>
        {
            file.RuleFor(f => f.FileName).MustBeAllowedFileName();
            file.RuleFor(f => f.ContentType).MustBeValidContentType();
            file.RuleFor(f => f.SizeBytes).MustBeValidFileSize();
        });

        RuleFor(x => x.ExpireInHours).MustBeValidExpiry();
        RuleFor(x => x.MaxDownloads).MustBeValidMaxDownloads();
        RuleFor(x => x.Password).MustBeValidPassword();
    }
}
