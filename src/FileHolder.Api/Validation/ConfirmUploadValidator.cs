using FileHolder.Core.Dtos;
using FileHolder.Core.Configuration;
using FluentValidation;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Validation;

public class ConfirmUploadValidator : AbstractValidator<ConfirmUploadRequestDto>
{
    private const string StorageKeyPrefix = "uploads/";

    // The client sends a 22-char salt and an 80-char envelope; 256 KB of manifest covers 50 files with
    // long names many times over while staying under the 1 MB cache payload limit.
    public const int MaxKeySaltLength = 64;
    public const int MaxKeyEnvelopeLength = 128;
    public const int MaxEncryptedManifestLength = 256 * 1024;

    public ConfirmUploadValidator(IOptions<UploadLimitsOptions> uploadLimits)
    {
        RuleFor(x => x.UploadToken)
            .NotEmpty().WithMessage("Upload token is required.");

        RuleFor(x => x.Title).MustBeValidTitle();

        RuleFor(x => x.Files)
            .NotEmpty().WithMessage("At least one confirmed file item is required.")
            .Must(files => files is { Count: >= 1 and <= BundleRules.MaxFilesPerBundle })
            .WithMessage("You can upload between 1 and 50 files per share bundle");

        var limits = uploadLimits.Value;

        When(x => !x.IsEncrypted, () => RuleFor(x => x.Files).MustFitBundleSizeLimit(f => f.SizeBytes, limits));
        When(x => x.IsEncrypted, () => RuleFor(x => x.Files).MustFitEncryptedBundleSizeLimit(f => f.SizeBytes, limits));

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

        // Key material is only meaningful for encrypted bundles, and is bounded so a confirm can't store
        // arbitrarily large blobs (KeySalt also has to fit its varchar(64) column).
        When(x => x.IsEncrypted, () =>
        {
            RuleFor(x => x.KeySalt)
                .MaximumLength(MaxKeySaltLength).WithMessage($"Key salt cannot exceed {MaxKeySaltLength} characters.");
            RuleFor(x => x.KeyEnvelope)
                .MaximumLength(MaxKeyEnvelopeLength).WithMessage($"Key envelope cannot exceed {MaxKeyEnvelopeLength} characters.");
            RuleFor(x => x.EncryptedManifest)
                .MaximumLength(MaxEncryptedManifestLength).WithMessage($"Encrypted manifest cannot exceed {MaxEncryptedManifestLength} characters.");
        }).Otherwise(() =>
        {
            RuleFor(x => x.KeySalt).Empty().WithMessage("Key salt is only allowed for encrypted uploads.");
            RuleFor(x => x.KeyEnvelope).Empty().WithMessage("Key envelope is only allowed for encrypted uploads.");
            RuleFor(x => x.EncryptedManifest).Empty().WithMessage("Encrypted manifest is only allowed for encrypted uploads.");
        });

        RuleFor(x => x.ExpireInHours).MustBeValidExpiry();
        RuleFor(x => x.MaxDownloads).MustBeValidMaxDownloads();
        RuleFor(x => x.Password).MustBeValidPassword();
    }
}
