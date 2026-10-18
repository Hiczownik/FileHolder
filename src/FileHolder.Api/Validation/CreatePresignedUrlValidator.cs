using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class CreatePresignedUrlValidator : AbstractValidator<CreatePresignedUrlRequestDto>
{
    public CreatePresignedUrlValidator()
    {
        RuleFor(x => x.Title).MustBeValidTitle();

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one file is required.")
            .Must(files => files is { Count: >= 1 and <= BundleRules.MaxFilesPerBundle })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        RuleFor(x => x.Files)
            .Must(files => files == null || files.Sum(f => f.SizeBytes) <= BundleRules.MaxBundleSizeBytes)
            .WithMessage("Total aggregate batch file size cannot exceed 5 TB.");

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
