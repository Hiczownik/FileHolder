using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddStoragePurgeTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeletedAt",
                table: "FileGroups",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "StoragePurgedAt",
                table: "FileGroups",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_FileGroups_PendingStoragePurge",
                table: "FileGroups",
                column: "CreatedAt",
                filter: "\"StoragePurgedAt\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_FileGroups_PendingStoragePurge",
                table: "FileGroups");

            migrationBuilder.DropColumn(
                name: "DeletedAt",
                table: "FileGroups");

            migrationBuilder.DropColumn(
                name: "StoragePurgedAt",
                table: "FileGroups");
        }
    }
}
