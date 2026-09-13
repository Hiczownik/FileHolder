using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class DownloadLeaseConfiguration : IEntityTypeConfiguration<DownloadLease>
{
    public void Configure(EntityTypeBuilder<DownloadLease> builder)
    {
        builder.ToTable("DownloadLeases");

        builder.HasKey(l => l.Id);

        builder.Property(l => l.LeaseToken)
            .IsRequired()
            .HasMaxLength(64);

        builder.HasIndex(l => l.LeaseToken)
            .IsUnique();

        builder.HasIndex(l => new { l.FileGroupId, l.Status, l.ExpiresAt });

        builder.HasOne(l => l.FileGroup)
            .WithMany(g => g.Leases)
            .HasForeignKey(l => l.FileGroupId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}