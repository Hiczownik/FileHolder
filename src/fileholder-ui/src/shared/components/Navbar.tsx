import { FileUp } from "lucide-react"
import { Link } from "react-router-dom"
import { ThemeToggle } from "./ThemeToggle"

// Plain links, not router ones: from a download page they open the home page at that section, and on the home page
// the browser just scrolls.
const SECTION_LINKS = [
    { href: '/#how', label: 'How it works' },
    { href: '/#modes', label: 'Encryption' },
] as const;

export const Navbar: React.FC = () => {
    return (
        <header className="border-b border-line bg-surface">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
                <Link to="/" className="flex items-center gap-2.5 text-fg font-semibold text-lg tracking-tight rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <span className="w-8 h-8 rounded-[9px] bg-accent-solid text-on-accent flex items-center justify-center">
                        <FileUp aria-hidden="true" className="w-[18px] h-[18px]" />
                    </span>
                    <span>FileHolder</span>
                </Link>
                <nav aria-label="Main" className="flex items-center gap-1">
                    {SECTION_LINKS.map((link) => (
                        <a
                            key={link.href}
                            href={link.href}
                            className="hidden sm:inline-flex items-center min-h-11 px-3 rounded-lg text-sm font-medium text-fg-soft hover:text-fg hover:bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            {link.label}
                        </a>
                    ))}
                    <ThemeToggle />
                </nav>
            </div>
        </header>
    );
};
