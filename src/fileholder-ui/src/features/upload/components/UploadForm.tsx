import { useEffect, useState } from "react";
import type { UploadFormValues, UploadState } from "../types";
import { useForm, useWatch } from "react-hook-form";
import { KeyRound, MapPinOff, ShieldCheck } from "lucide-react";
import { FileDropzone } from "./FileDropzone";
import { UploadProgress } from "./UploadProgress";
import { Button } from "../../../shared/components/Button";
import { StatusAlert } from "../../../shared/components/StatusAlert";
import { Switch } from "../../../shared/components/Switch";
import { mergeSelectedFiles } from "../services/selectedFiles";
import { generateReadablePasskey, MIN_PASSKEY_LENGTH } from "../services/passkey";
import { DEFAULT_UPLOAD_LIMITS, defaultExpiry, describeHours, expiryChoices, type UploadLimits } from "../services/uploadLimits";

interface Props {
    uploadState: UploadState;
    onUpload: (formValues: UploadFormValues, files: File[]) => void;
    /** The deployment's limits (useUploadLimits): the expiries offered and the drop area's hint. */
    limits?: UploadLimits;
}

const DEFAULT_MAX_DOWNLOADS = 10;

const FIELD_LABEL = "block text-sm font-medium mb-1.5";
const OPTIONAL = "font-normal text-muted";
const FIELD = "w-full h-11 px-3 rounded-[10px] border border-line-strong bg-surface text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40";
const HINT = "text-[13px] text-muted";

export const UploadForm: React.FC<Props> = ({ uploadState, onUpload, limits = DEFAULT_UPLOAD_LIMITS }) => {
    const [files, setFiles] = useState<File[]>([]);
    // Shown until the next pick, so a file left out is never dropped without a word.
    const [skippedNames, setSkippedNames] = useState<string[]>([]);
    const isUploading = uploadState.status === "uploading";

    const { register, handleSubmit, control, setValue, getValues } = useForm<UploadFormValues>({
        defaultValues: {
            title: '',
            expireInHours: defaultExpiry(limits),
            maxDownloads: DEFAULT_MAX_DOWNLOADS,
            password: '',
            isEncrypted: false,
            requirePasskey: false,
            // On by default: few senders know their photos carry where and when they were taken.
            stripImageMetadata: true,
        },
    });

    // The server's limits can arrive after the form is shown. A choice they no longer allow moves down to the longest
    // one they do, rather than staying selected only to be refused at upload.
    useEffect(() => {
        if (Number(getValues('expireInHours')) > limits.maxExpiryHours) {
            setValue('expireInHours', defaultExpiry(limits));
        }
    }, [limits, getValues, setValue]);

    const isEncrypted = useWatch({ control, name: 'isEncrypted' }) ?? false;
    const requirePasskey = useWatch({ control, name: 'requirePasskey' }) ?? false;
    const passwordValue = useWatch({ control, name: 'password' }) ?? '';
    const stripImageMetadata = useWatch({ control, name: 'stripImageMetadata' }) ?? true;

    // An encrypted bundle's link carries its key, so it needs a passkey only when the uploader asks for one.
    const isPasskeyRequired = isEncrypted && requirePasskey;
    const showPasswordField = !isEncrypted || requirePasskey;
    const isPasswordMissingForE2EE = isPasskeyRequired && (!passwordValue || passwordValue.trim().length === 0);
    const isSubmitDisabled = files.length === 0 || isPasswordMissingForE2EE;

    const handleFilesSelect = (newFiles: File[]) => {
        const merged = mergeSelectedFiles(files, newFiles);
        setFiles(merged.files);
        setSkippedNames(merged.skipped.map((file) => file.name));
    };

    const handleRemoveFile = (index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleGeneratePasskey = () => {
        setValue('password', generateReadablePasskey(), { shouldDirty: true });
    };

    const onSubmit = (data: UploadFormValues) => {
        onUpload(data, files);
    };

    return (
        <form
            onSubmit={handleSubmit(onSubmit)}
            aria-labelledby="new-bundle-title"
            className="bg-surface border border-line rounded-2xl p-5 sm:p-7 space-y-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.05)]"
        >
            <h2 id="new-bundle-title" className="text-[19px] font-semibold tracking-tight">New bundle</h2>

            <div className="space-y-2.5">
                <FileDropzone
                    selectedFiles={files}
                    onFilesSelect={handleFilesSelect}
                    onRemoveFile={handleRemoveFile}
                    stripMetadata={stripImageMetadata}
                    limits={limits}
                />

                {skippedNames.length > 0 && (
                    <StatusAlert
                        variant="info"
                        message={`Skipped ${skippedNames.length === 1 ? '1 file' : `${skippedNames.length} files`} already in the list: ${skippedNames.join(', ')}.`}
                    />
                )}

                <div className="flex items-start gap-3 rounded-xl border border-line bg-canvas p-3.5">
                    <MapPinOff aria-hidden="true" className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                        <label htmlFor="strip-metadata" className="block font-medium cursor-pointer">Remove photo metadata</label>
                        <p id="strip-metadata-hint" className={HINT}>
                            Location and camera details, removed in your browser before upload. HEIC photos and videos
                            aren&apos;t cleaned.
                        </p>
                    </div>
                    <Switch id="strip-metadata" aria-describedby="strip-metadata-hint" {...register('stripImageMetadata')} />
                </div>
            </div>

            <div>
                <label htmlFor="bundle-title" className={FIELD_LABEL}>
                    Title <span className={OPTIONAL}>(optional)</span>
                </label>
                <input
                    type="text"
                    id="bundle-title"
                    placeholder="e.g. Q3 design review"
                    aria-describedby={isEncrypted ? 'bundle-title-hint' : undefined}
                    {...register('title')}
                    className={FIELD}
                />
                {isEncrypted && (
                    <p id="bundle-title-hint" className={`${HINT} mt-1.5`}>
                        Encrypted with the files. Recipients see it after unlocking.
                    </p>
                )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:gap-4">
                <div>
                    <label htmlFor="expire-in-hours" className={FIELD_LABEL}>Expires after</label>
                    <select id="expire-in-hours" {...register('expireInHours')} className={`${FIELD} px-2.5`}>
                        {expiryChoices(limits).map((hours) => (
                            <option key={hours} value={hours}>{describeHours(hours)}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label htmlFor="max-downloads" className={FIELD_LABEL}>Download limit</label>
                    <select id="max-downloads" {...register('maxDownloads')} className={`${FIELD} px-2.5`}>
                        <option value={1}>1 download</option>
                        <option value={5}>5 downloads</option>
                        <option value={10}>10 downloads</option>
                        <option value={50}>50 downloads</option>
                        <option value={100}>100 downloads</option>
                    </select>
                </div>
            </div>

            <div role="group" aria-label="Encryption" className="rounded-xl border border-line bg-canvas">
                <div className="flex items-start gap-3.5 p-4">
                    <ShieldCheck aria-hidden="true" className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                        <label htmlFor="is-encrypted" className="block font-semibold cursor-pointer">End-to-end encryption</label>
                        <p id="is-encrypted-hint" className={HINT}>
                            Files are encrypted in your browser. The key goes in the share link, which the server never sees.
                        </p>
                    </div>
                    <Switch id="is-encrypted" aria-describedby="is-encrypted-hint" {...register('isEncrypted')} />
                </div>

                {isEncrypted && (
                    <div className="flex items-start gap-3.5 border-t border-line p-4 pl-[50px]">
                        <div className="flex-1 min-w-0">
                            <label htmlFor="require-passkey" className="block font-semibold cursor-pointer">Also require a passkey</label>
                            <p id="require-passkey-hint" className={HINT}>
                                {requirePasskey
                                    ? "The link alone won't open the files. Send the passkey separately."
                                    : 'The link is the secret: anyone who gets it can open the files. For sensitive files, also require a passkey.'}
                            </p>
                        </div>
                        <Switch id="require-passkey" aria-describedby="require-passkey-hint" {...register('requirePasskey')} />
                    </div>
                )}
            </div>

            {showPasswordField && (isEncrypted ? (
                <div>
                    <label htmlFor="bundle-password" className={FIELD_LABEL}>Passkey</label>
                    <div className="flex gap-2">
                        {/* Shown, not hidden: the sender has to copy it into a separate message. */}
                        <input
                            type="text"
                            id="bundle-password"
                            placeholder="Type one or generate it"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            aria-describedby="bundle-password-hint"
                            {...register('password', { required: isPasskeyRequired })}
                            className={`${FIELD} flex-1 min-w-0 font-mono tracking-wider`}
                        />
                        <Button type="button" variant="outline" size="md" onClick={handleGeneratePasskey} className="h-11 shrink-0">
                            <KeyRound aria-hidden="true" className="w-4 h-4" />
                            <span>Generate</span>
                        </Button>
                    </div>
                    <p id="bundle-password-hint" className={`${HINT} mt-1.5`}>
                        At least {MIN_PASSKEY_LENGTH} characters. Send it in a different message or app from the link.
                    </p>
                </div>
            ) : (
                <div>
                    <label htmlFor="bundle-password" className={FIELD_LABEL}>
                        Password <span className={OPTIONAL}>(optional)</span>
                    </label>
                    <input
                        type="password"
                        id="bundle-password"
                        placeholder="Leave empty for no password"
                        autoComplete="new-password"
                        {...register('password')}
                        className={FIELD}
                    />
                </div>
            ))}

            {isUploading && <UploadProgress progress={uploadState.progress} preparing={uploadState.preparing} />}

            <div className="space-y-2.5">
                <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    disabled={isSubmitDisabled}
                    isLoading={isUploading}
                    loadingText="Uploading..."
                    className="h-[50px] text-base"
                >
                    Create share link
                </Button>
                <p className={`${HINT} text-center`}>Your browser uploads the files directly to storage.</p>
            </div>
        </form>
    );
};
