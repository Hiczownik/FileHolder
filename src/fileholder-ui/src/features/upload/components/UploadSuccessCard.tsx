import { Check } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { CopyButton } from "../../../shared/components/CopyButton";
import { Button } from "../../../shared/components/Button";
import type { KeyMode } from "../../download/types";
import type { MetadataSummary } from "../types";
import { describeMetadataSummary } from "../services/photoCleaning";

interface Props {
    /** For an encrypted bundle, includes the link key in its fragment. */
    shareLink: string;
    /** Set for encrypted bundles only. */
    keyMode?: KeyMode;
    /** Set when photo metadata removal was on. */
    metadataSummary?: MetadataSummary;
    onReset: () => void;
}

// What the sender must know before sharing, by how the bundle is unlocked.
const KEY_MODE_NOTES: Readonly<Record<KeyMode, string>> = {
    LinkKey: 'Anyone with this link or QR code can open the files.',
    LinkKeyAndPasskey: "The link alone won't open the files. Share the passkey separately (not in the same message).",
};

export const UploadSuccessCard: React.FC<Props> = ({ shareLink, keyMode, metadataSummary, onReset }) => {
    const metadataNote = metadataSummary ? describeMetadataSummary(metadataSummary) : null;
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
                {metadataNote && <p className="text-xs text-slate-400 mt-2">{metadataNote}</p>}
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

            <div className="space-y-2">
                {/* Drawn locally: the link must never be sent to a QR service. Dark on white with a margin
                    so phone cameras can read it on the dark theme. */}
                <QRCodeSVG
                    value={shareLink}
                    size={192}
                    level="M"
                    marginSize={4}
                    bgColor="#ffffff"
                    fgColor="#020617"
                    title="QR code for the share link"
                    className="mx-auto rounded-xl"
                />
                <p className="text-xs text-slate-400">Scan to open the link on another device.</p>
                {keyMode && (
                    <p className="text-xs text-amber-400">{KEY_MODE_NOTES[keyMode]}</p>
                )}
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