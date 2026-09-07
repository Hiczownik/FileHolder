using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class ConfirmUploadValidator : AbstractValidator<ConfirmUploadRequestDto>
{
    public ConfirmUploadValidator()
    {
        RuleFor(x => x.UploadToken)
            .NotEmpty().WithMessage("Upload token is required.");

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one confirmed file item is required.");

        RuleForEach(x => x.Files).ChildRules(file =>
        {
            file.RuleFor(f => f.StorageKey)
                .NotEmpty().WithMessage("Storage key is required.");

            file.RuleFor(f => f.FileName)
                .NotEmpty().WithMessage("File name is required.");

            file.RuleFor(f => f.SizeBytes)
                .GreaterThan(0).WithMessage("File size must be greater than 0 bytes.");
        });
    }
}