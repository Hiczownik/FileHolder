using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class ServiceModeChangeConfiguration : IEntityTypeConfiguration<ServiceModeChange>
{
    public const int MaxMessageLength = 500;
    public const int MaxReasonLength = 500;
    public const int MaxChangedByLength = 100;

    public void Configure(EntityTypeBuilder<ServiceModeChange> builder)
    {
        builder.ToTable("ServiceModeChanges");

        builder.HasKey(c => c.Id);

        builder.Property(c => c.Id)
            .UseIdentityAlwaysColumn();

        builder.Property(c => c.Mode)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(c => c.Message)
            .HasMaxLength(MaxMessageLength);

        builder.Property(c => c.Until)
            .HasColumnType("timestamp with time zone");

        builder.Property(c => c.Reason)
            .IsRequired()
            .HasMaxLength(MaxReasonLength);

        builder.Property(c => c.ChangedBy)
            .HasMaxLength(MaxChangedByLength);

        builder.Property(c => c.ChangedAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();
    }
}
