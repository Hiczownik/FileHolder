using FileHolder.Core.Dtos;
using FileHolder.Core.Security;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class CreatePresignedUrlValidator : AbstractValidator<CreatePresignedUrlRequestDto>
{
    public CreatePresignedUrlValidator()
    {
        RuleFor(x => x.FileName)
            .NotEmpty().WithMessage("File name is required")
            .MaximumLength(255).WithMessage("File name cannot exceed 255 characters.")
            .Must(x => !FileSecurityUtils.IsExtensionForbidden(x))
            .WithMessage("Forbidden file extension. Executable files and scripts are not allowed.");
        
        RuleFor(x => x.ContentType)
            .NotEmpty().WithMessage("Content type is required")
            .MaximumLength(128).WithMessage("Content type cannot exceed 128 characters.");
        
        RuleFor(x => x.SizeBytes)
            .GreaterThan(0).WithMessage("File size must be greater than 0 bytes.")
            .LessThanOrEqualTo(5_368_709_120).WithMessage("File size cannot exceed 5 GB.");

        RuleFor(x => x.ExpireInHours)
            .InclusiveBetween(1, 168).When(x => x.ExpireInHours.HasValue)
            .WithMessage("Expiration time must be between 1 hour and 168 hours (7 days).");

        RuleFor(x => x.MaxDownloads)
            .InclusiveBetween(1, 1000).When(x => x.MaxDownloads.HasValue)
            .WithMessage("Max downloads must be between 1 and 1000.");

        RuleFor(x => x.Password)
            .Length(4, 100).When(x => !string.IsNullOrEmpty(x.Password))
            .WithMessage("Password must be between 4 and 100 characters.");
    }
}