using FileHolder.Core.Dtos;
using FileHolder.Core.Configuration;
using FileHolder.Core.Entities;
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

    // A 255-character title is at most 1020 UTF-8 bytes; as JSON plus a 12-byte IV and 16-byte tag that is about
    // 1050 bytes, or 1400 base64url characters.
    public const int MaxEncryptedTitleLength = 2048;

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

        // Key material is required for encrypted bundles and only allowed there. It is bounded so a confirm can't
        // store arbitrarily large blobs (KeySalt also has to fit its varchar(64) column).
        When(x => x.IsEncrypted, () =>
        {
            RuleFor(x => x.KeySalt).MustBeKeyMaterial("Key salt", MaxKeySaltLength);
            RuleFor(x => x.KeyEnvelope).MustBeKeyMaterial("Key envelope", MaxKeyEnvelopeLength);
            RuleFor(x => x.EncryptedManifest).MustBeKeyMaterial("Encrypted manifest", MaxEncryptedManifestLength);
            RuleFor(x => x.Title).MustBeEmptyForEncryptedBundles();
            // Optional, as titles are.
            RuleFor(x => x.EncryptedTitle).MustBeKeyMaterial("Encrypted title", MaxEncryptedTitleLength)
                .When(x => !string.IsNullOrEmpty(x.EncryptedTitle));
            RuleFor(x => x.KeyMode)
                .NotNull().WithMessage("Key mode is required for encrypted uploads.")
                .IsInEnum().WithMessage("Key mode is not valid.");
            // Only a passkey is stretched; a link key is random already (#78).
            RuleFor(x => x.KdfParams).MustBeSupportedKdfParams().When(x => x.KeyMode == KeyMode.LinkKeyAndPasskey);
            RuleFor(x => x.KdfParams).Empty().WithMessage("Key derivation settings are only allowed with a passkey.")
                .When(x => x.KeyMode != KeyMode.LinkKeyAndPasskey);
        }).Otherwise(() =>
        {
            RuleFor(x => x.KeyMode).Null().WithMessage("Key mode is only allowed for encrypted uploads.");
            RuleFor(x => x.KdfParams).Empty().WithMessage("Key derivation settings are only allowed for encrypted uploads.");
            RuleFor(x => x.EncryptedTitle).Empty().WithMessage("Encrypted title is only allowed for encrypted uploads.");
            RuleFor(x => x.KeySalt).Empty().WithMessage("Key salt is only allowed for encrypted uploads.");
            RuleFor(x => x.KeyEnvelope).Empty().WithMessage("Key envelope is only allowed for encrypted uploads.");
            RuleFor(x => x.EncryptedManifest).Empty().WithMessage("Encrypted manifest is only allowed for encrypted uploads.");
        });

        RuleFor(x => x.ExpireInHours).MustBeValidExpiry();
        RuleFor(x => x.MaxDownloads).MustBeValidMaxDownloads();
        RuleFor(x => x.Password).MustBeValidPassword();
    }
}
