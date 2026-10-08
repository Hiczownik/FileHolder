using FileHolder.Core.Dtos;
using FileHolder.Core.Security;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class CreatePresignedUrlValidator : AbstractValidator<CreatePresignedUrlRequestDto>
{
    public CreatePresignedUrlValidator()
    {
        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one file is required.")
            .Must(files => files is { Count: >= 1 and <= 50 })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        RuleFor(x => x.Files)
            .Must(files => files == null || files.Sum(f => f.SizeBytes) <= 5_497_558_138_880L) // 5 TB
            .WithMessage("Total aggregate batch file size cannot exceed 5 TB.");

        // 1 GB + 64 KB margin for IV, AES-GCM authentication tag, and container headers
        const long maxEncryptedPayloadBytes = 1_073_741_824L + 65_536L;

        RuleFor(x => x.Files)
            .Must(files => files == null || files.Sum(f => f.SizeBytes) <= maxEncryptedPayloadBytes)
            .When(x => x.IsEncrypted)
            .WithMessage("Encrypted payloads cannot exceed 1 GB due to client-side memory safety constraints.");

        RuleForEach(x => x.Files).ChildRules(file =>
        {
            file.RuleFor(f => f.FileName)
                .NotEmpty().WithMessage("File name is required.")
                .MaximumLength(255).WithMessage("File name cannot exceed 255 characters.")
                .Must(x => !FileSecurityUtils.IsExtensionForbidden(x))
                .WithMessage("Forbidden file extension detected. Executable files and scripts are not allowed.");

            file.RuleFor(f => f.ContentType)
                .NotEmpty().WithMessage("Content type is required.")
                .MaximumLength(128).WithMessage("Content type cannot exceed 128 characters.");

            file.RuleFor(f => f.SizeBytes)
                .GreaterThan(0).WithMessage("File size must be greater than 0 bytes.");
        });

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