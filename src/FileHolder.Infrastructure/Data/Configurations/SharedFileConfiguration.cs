using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class SharedFileConfiguration : IEntityTypeConfiguration<SharedFile>
{
    public void Configure(EntityTypeBuilder<SharedFile> builder)
    {
        builder.ToTable("SharedFiles");
        
        builder.HasKey(f => f.Id);

        builder.Property(f => f.OriginalFileName)
            .IsRequired()
            .HasMaxLength(255);
        
        builder.Property(f => f.StorageKey)
            .IsRequired()
            .HasMaxLength(512);

        builder.Property(f => f.ContentType)
            .IsRequired()
            .HasMaxLength(128);

        builder.HasIndex(f => f.StorageKey)
            .IsUnique();
    }
}