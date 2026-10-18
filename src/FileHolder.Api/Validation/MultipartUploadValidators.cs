using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

internal static class MultipartLimits
{
    // S3 caps a multipart upload at 10,000 parts.
    public const int MaxPartNumber = 10_000;
    public const int MaxPresignBatchSize = 100;
}

public class PresignPartBatchValidator : AbstractValidator<PresignPartBatchRequestDto>
{
    public PresignPartBatchValidator()
    {
        RuleFor(x => x.UploadToken).NotEmpty().WithMessage("Upload token is required.");
        RuleFor(x => x.UploadId).NotEmpty().WithMessage("Upload ID is required.");

        RuleFor(x => x.StartPartNumber)
            .InclusiveBetween(1, MultipartLimits.MaxPartNumber)
            .WithMessage($"Start part number must be between 1 and {MultipartLimits.MaxPartNumber}.");

        RuleFor(x => x.Count)
            .InclusiveBetween(1, MultipartLimits.MaxPresignBatchSize)
            .WithMessage($"Count must be between 1 and {MultipartLimits.MaxPresignBatchSize}.");
    }
}

public class CompleteMultipartUploadValidator : AbstractValidator<CompleteMultipartUploadRequestDto>
{
    public CompleteMultipartUploadValidator()
    {
        RuleFor(x => x.UploadToken).NotEmpty().WithMessage("Upload token is required.");
        RuleFor(x => x.UploadId).NotEmpty().WithMessage("Upload ID is required.");

        RuleFor(x => x.Parts)
            .NotEmpty().WithMessage("At least one completed part is required.")
            .Must(parts => parts is { Count: <= MultipartLimits.MaxPartNumber })
            .WithMessage($"A multipart upload cannot have more than {MultipartLimits.MaxPartNumber} parts.");

        RuleForEach(x => x.Parts).ChildRules(part =>
        {
            part.RuleFor(p => p.PartNumber)
                .InclusiveBetween(1, MultipartLimits.MaxPartNumber)
                .WithMessage($"Part number must be between 1 and {MultipartLimits.MaxPartNumber}.");

            part.RuleFor(p => p.ETag).NotEmpty().WithMessage("Part ETag is required.");
        });
    }
}

public class AbortMultipartUploadValidator : AbstractValidator<AbortMultipartUploadRequestDto>
{
    public AbortMultipartUploadValidator()
    {
        RuleFor(x => x.UploadToken).NotEmpty().WithMessage("Upload token is required.");
        RuleFor(x => x.UploadId).NotEmpty().WithMessage("Upload ID is required.");
    }
}
