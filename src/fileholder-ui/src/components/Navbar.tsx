import { HardDrive, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"

export const Navbar: React.FC = () => {
    return (
        <nav className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
            <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
                <Link to="/" className="flex items-center gap-2 text-indigo-400 font-bold text-xl hover:text-indigo-300 transition">
                    <HardDrive className="w-6 h-6" />
                    <span>FileHolder</span>    
                </Link>
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 bg-slate-800/80 px-3 py-1.5 rounded-full border border-slate -700/50">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>End-to-End Encrypted & Zero Egress</span>
                </div>
            </div>
        </nav>
    );
};