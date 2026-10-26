using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class CreateAccessCodeValidator : AbstractValidator<CreateAccessCodeRequestDto>
{
    public const int MaxDays = 3650;

    public CreateAccessCodeValidator()
    {
        // Neutral labels (a01, a02, …): the mapping to companies stays with the owner, not on the server (#169).
        RuleFor(x => x.Label)
            .Must(AccessCodeRules.IsValidLabel)
            .WithMessage("A label is 1 to 20 lowercase letters and digits, starting with a letter: a01, a02, …");
        RuleFor(x => x.ExpiresInDays).InclusiveBetween(1, MaxDays).When(x => x.ExpiresInDays.HasValue);
        RuleFor(x => x).Must(x => !(x.NoExpiry && x.ExpiresInDays.HasValue))
            .WithMessage("Give either a number of days or no expiry, not both.");
    }
}

public class ExtendAccessCodeValidator : AbstractValidator<ExtendAccessCodeRequestDto>
{
    public ExtendAccessCodeValidator()
    {
        RuleFor(x => x.Days).InclusiveBetween(1, CreateAccessCodeValidator.MaxDays).When(x => x.Days.HasValue);
        RuleFor(x => x).Must(x => !(x.NoExpiry && x.Days.HasValue))
            .WithMessage("Give either a number of days or no expiry, not both.");
    }
}
