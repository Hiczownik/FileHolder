using FileHolder.Core.Dtos;
using FileHolder.Infrastructure.Data.Configurations;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class TakedownValidator : AbstractValidator<TakedownRequestDto>
{
    public TakedownValidator()
    {
        RuleFor(x => x.ShareToken)
            .NotEmpty().WithMessage("Give the share token of the bundle to take down.")
            .MaximumLength(64);

        // A takedown is the kind of thing someone may ask about later, so the record has to say why.
        RuleFor(x => x.Reason)
            .NotEmpty().WithMessage("Say why the bundle is taken down; it goes into the takedown record.")
            .MaximumLength(TakedownConfiguration.MaxReasonLength);

        RuleFor(x => x.ChangedBy).MaximumLength(TakedownConfiguration.MaxChangedByLength);
    }
}
