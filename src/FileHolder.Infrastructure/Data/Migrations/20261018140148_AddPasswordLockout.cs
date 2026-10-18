using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPasswordLockout : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "FailedPasswordAttempts",
                table: "FileGroups",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTime>(
                name: "PasswordLockedUntil",
                table: "FileGroups",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FailedPasswordAttempts",
                table: "FileGroups");

            migrationBuilder.DropColumn(
                name: "PasswordLockedUntil",
                table: "FileGroups");
        }
    }
}
