using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class TakedownConfiguration : IEntityTypeConfiguration<Takedown>
{
    public const int MaxReasonLength = 1000;
    public const int MaxChangedByLength = 100;

    public void Configure(EntityTypeBuilder<Takedown> builder)
    {
        builder.ToTable("Takedowns");

        builder.HasKey(t => t.Id);

        builder.Property(t => t.Id)
            .UseIdentityAlwaysColumn();

        builder.Property(t => t.ShareToken)
            .IsRequired()
            .HasMaxLength(64);

        // No foreign key: the record outlives the bundle's tombstone.
        builder.Property(t => t.FileGroupId)
            .IsRequired();

        builder.Property(t => t.Reason)
            .IsRequired()
            .HasMaxLength(MaxReasonLength);

        builder.Property(t => t.ChangedBy)
            .HasMaxLength(MaxChangedByLength);

        builder.Property(t => t.TakenDownAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.HasIndex(t => t.ShareToken);
    }
}
