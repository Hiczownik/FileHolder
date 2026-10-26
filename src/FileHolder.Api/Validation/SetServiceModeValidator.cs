using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data.Configurations;
using FluentValidation;

namespace FileHolder.Api.Validation;

public class SetServiceModeValidator : AbstractValidator<SetServiceModeRequestDto>
{
    public SetServiceModeValidator(IDateTimeProvider dateTimeProvider)
    {
        RuleFor(x => x.Mode).IsInEnum();

        // The log is only useful if it says why.
        RuleFor(x => x.Reason)
            .NotEmpty().WithMessage("Say why the mode is changing; it goes into the log.")
            .MaximumLength(ServiceModeChangeConfiguration.MaxReasonLength);

        RuleFor(x => x.Message).MaximumLength(ServiceModeChangeConfiguration.MaxMessageLength);
        RuleFor(x => x.ChangedBy).MaximumLength(ServiceModeChangeConfiguration.MaxChangedByLength);

        RuleFor(x => x.Until)
            .Must(until => until is null || until.Value.ToUniversalTime() > dateTimeProvider.UtcNow)
            .WithMessage("Until must be in the future.");
    }
}
