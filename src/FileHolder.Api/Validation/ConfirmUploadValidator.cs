using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class ConfirmUploadValidator : AbstractValidator<ConfirmUploadRequestDto>
{
    public ConfirmUploadValidator()
    {
        RuleFor(x => x.UploadToken)
            .NotEmpty().WithMessage("Upload token is required.");

        RuleFor(x => x.StorageKey)
            .NotEmpty().WithMessage("Storage key is required.");

        RuleFor(x => x.FileName)
            .NotEmpty().WithMessage("File name is required.");
        
        RuleFor(x => x.SizeBytes)
            .GreaterThan(0).WithMessage("File size must be greater than 0 bytes.");
    }
}