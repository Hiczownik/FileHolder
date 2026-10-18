using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class ConfirmUploadValidator : AbstractValidator<ConfirmUploadRequestDto>
{
    private const string StorageKeyPrefix = "uploads/";

    public ConfirmUploadValidator()
    {
        RuleFor(x => x.UploadToken)
            .NotEmpty().WithMessage("Upload token is required.");

        RuleFor(x => x.Title).MustBeValidTitle();

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one confirmed file item is required.")
            .Must(files => files is { Count: >= 1 and <= BundleRules.MaxFilesPerBundle })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        RuleFor(x => x.Files)
            .Must(files => files == null || files.Sum(f => f.SizeBytes) <= BundleRules.MaxBundleSizeBytes)
            .WithMessage("Total aggregate batch file size cannot exceed 5 TB.");

        RuleForEach(x => x.Files).ChildRules(file =>
        {
            file.RuleFor(f => f.StorageKey)
                .NotEmpty().WithMessage("Storage key is required.")
                .MaximumLength(512).WithMessage("Storage key cannot exceed 512 characters.")
                .Must(key => key.StartsWith(StorageKeyPrefix, StringComparison.Ordinal) && !key.Contains("..", StringComparison.Ordinal))
                .WithMessage("Storage key is not a valid upload key.");

            file.RuleFor(f => f.FileName).MustBeAllowedFileName();
            file.RuleFor(f => f.ContentType).MustBeValidContentType();
            file.RuleFor(f => f.SizeBytes).MustBeValidFileSize();
        });

        RuleFor(x => x.ExpireInHours).MustBeValidExpiry();
        RuleFor(x => x.MaxDownloads).MustBeValidMaxDownloads();
        RuleFor(x => x.Password).MustBeValidPassword();
    }
}
