import { Check } from "lucide-react";
import { CopyButton } from "../../../shared/components/CopyButton";
import { Button } from "../../../shared/components/Button";

interface Props {
    shareLink: string;
    onReset: () => void;
}

export const UploadSuccessCard: React.FC<Props> = ({ shareLink, onReset }) => {
    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-6">
            <div className="p-4 bg-emerald-500/10 rounded-full w-16 h-16 mx-auto flex items-center justify-center text-emerald-400 border border-emerald-500/20">
                <Check className="w-8 h-8" />
            </div>

            <div>
                <h2 className="text-2xl font-bold text-white">Your File Group is Ready!</h2>
                <p className="text-sm text-slate-400 mt-1">
                    Anyone with this link can view metadata and download files.
                </p>
            </div>

            <div className="flex items-center gap-2 bg-slate-950 p-2 rounded-xl border border-slate-800">
                <input
                    type="text"
                    readOnly
                    value={shareLink}
                    className="bg-transparent text-indigo-300 text-sm px-3 flex-1 outline-none font-mono"
                />
                <CopyButton text={shareLink} />
            </div>

            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onReset}
                className="mx-auto"
            >
                Upload another file or file group
            </Button>
        </div>
    );
};