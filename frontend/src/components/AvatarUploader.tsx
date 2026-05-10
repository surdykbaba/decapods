import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, X, UploadCloud } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Avatar } from "@/components/Avatar";
import { useAuth, type Me } from "@/lib/auth";

const MAX_SIDE = 256;        // px — downscale before encoding
const MAX_DATA_URI = 350_000; // ~256 KB image after base64

/**
 * Drag/click avatar uploader. Resizes client-side to MAX_SIDE × MAX_SIDE,
 * re-encodes to JPEG at quality 0.85, and PUTs the resulting data URI to
 * /api/v1/me/profile. Tiny enough to inline in the users row without an
 * object store.
 */
export function AvatarUploader({
  name, email, src, onSaved,
}: {
  name?: string | null;
  email?: string | null;
  src?: string | null;
  onSaved?: (next: string | null) => void;
}) {
  const qc = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  const currentUser = useAuth((s) => s.user);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const save = useMutation({
    mutationFn: (avatar_url: string | null) =>
      api<Partial<Me>>("/api/v1/me/profile", {
        method: "PUT",
        body: JSON.stringify({ avatar_url: avatar_url ?? "" }),
      }),
    onSuccess: (resp, vars) => {
      // Push the fresh user back into the Zustand store so the sidebar
      // avatar, identity dropdown, and every other consumer of useAuth
      // update immediately. Falls back to a manual merge when the API
      // (somehow) returned only a partial shape.
      if (resp && currentUser) {
        setUser({ ...currentUser, ...resp } as Me);
      }
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["campfire", "presence"] });
      toast.success(vars ? "Photo updated" : "Photo removed");
      onSaved?.(vars);
      setPreview(null);
    },
    onError: (e: any) => toast.error("Could not save photo", e?.message),
  });

  async function pick(file: File | undefined | null) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      toast.error("Unsupported format", "Use PNG, JPG, GIF or WebP.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File too large", "Maximum 8 MB before resize.");
      return;
    }
    setWorking(true);
    try {
      const dataUri = await resizeToDataURI(file, MAX_SIDE);
      if (dataUri.length > MAX_DATA_URI) {
        toast.error("Still too large after resize", "Try a smaller crop or a different image.");
        return;
      }
      setPreview(dataUri);
      save.mutate(dataUri);
    } catch (e: any) {
      toast.error("Could not process image", e?.message);
    } finally {
      setWorking(false);
    }
  }

  const showing = preview ?? src ?? null;

  return (
    <div className="flex items-center gap-4">
      <div className="relative group">
        <Avatar name={name} email={email} src={showing} size={88} className="ring-2 ring-border" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="absolute inset-0 rounded-full bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity grid place-items-center"
          aria-label="Upload photo"
        >
          <Camera size={20} />
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={working || save.isPending}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline disabled:opacity-50"
          >
            <UploadCloud size={14} />
            {showing ? "Change photo" : "Upload photo"}
          </button>
          {showing && (
            <button
              type="button"
              onClick={() => save.mutate(null)}
              disabled={working || save.isPending}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-danger"
            >
              <X size={12} /> Remove
            </button>
          )}
        </div>
        <div className="text-[11px] text-muted mt-1">
          PNG, JPG, GIF or WebP up to 8 MB · auto-resized to {MAX_SIDE}px for fast loading.
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  );
}

// Read a File → draw on an off-screen canvas at MAX_SIDE × MAX_SIDE → return
// a JPEG data URI. Preserves aspect ratio with a centre-crop so the avatar
// is always square.
function resizeToDataURI(file: File, maxSide: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = maxSide;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas unavailable")); return; }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSide, maxSide);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
