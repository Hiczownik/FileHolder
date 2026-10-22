import { HardDrive, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"
import { ThemeToggle } from "./ThemeToggle"

export const Navbar: React.FC = () => {
    return (
        <nav className="border-b border-line bg-surface/80 backdrop-blur-md sticky top-0 z-50">
            <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
                <Link to="/" className="flex items-center gap-2 text-accent font-bold text-xl hover:text-fg transition">
                    <HardDrive className="w-6 h-6" />
                    <span>FileHolder</span>
                </Link>
                <div className="flex items-center gap-2">
                    <div className="hidden sm:flex items-center gap-2 text-xs font-semibold text-muted bg-surface-raised px-3 py-1.5 rounded-full border border-line">
                        <ShieldCheck className="w-4 h-4 text-success" />
                        <span>End-to-End Encrypted & Zero Egress</span>
                    </div>
                    <ThemeToggle />
                </div>
            </div>
        </nav>
    );
};
