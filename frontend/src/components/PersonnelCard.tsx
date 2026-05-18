// PersonnelCard — the HR "file on a teammate": NIN, blood group,
// emergency contact, next of kin, guarantor, payroll basics, and
// document uploads (CV, NIN slip, ID card, certificates).
//
// One component, two modes:
//   • <PersonnelCard />            → self mode, hits /me/personnel*
//   • <PersonnelCard memberId=…/>  → HR mode, hits /members/:id/personnel*
//
// The backend enforces the gate (workforce:write / governance:write for
// other people), so this component just points at the right base path.
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, Trash2, Save, ShieldCheck, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";

type Doc = { id: string; kind: string; name: string; mime: string; size_bytes: number; created_at: string };
type Bundle = { record: Record<string, string>; documents: Doc[] };

const FIELD_GROUPS: { title: string; fields: { key: string; label: string; type?: string; full?: boolean }[] }[] = [
  {
    title: "Identity & health",
    fields: [
      { key: "nin", label: "NIN (National Identification Number)" },
      { key: "date_of_birth", label: "Date of birth", type: "date" },
      { key: "gender", label: "Gender" },
      { key: "marital_status", label: "Marital status" },
      { key: "blood_group", label: "Blood group" },
      { key: "genotype", label: "Genotype" },
      { key: "personal_phone", label: "Personal phone" },
      { key: "personal_email", label: "Personal email", type: "email" },
      { key: "home_address", label: "Home address", full: true },
    ],
  },
  {
    title: "Emergency contact",
    fields: [
      { key: "emergency_name", label: "Full name" },
      { key: "emergency_phone", label: "Phone" },
      { key: "emergency_relationship", label: "Relationship" },
    ],
  },
  {
    title: "Next of kin",
    fields: [
      { key: "nok_name", label: "Full name" },
      { key: "nok_phone", label: "Phone" },
      { key: "nok_relationship", label: "Relationship" },
      { key: "nok_address", label: "Address", full: true },
    ],
  },
  {
    title: "Guarantor",
    fields: [
      { key: "guarantor_name", label: "Full name" },
      { key: "guarantor_phone", label: "Phone" },
      { key: "guarantor_email", label: "Email", type: "email" },
      { key: "guarantor_occupation", label: "Occupation" },
      { key: "guarantor_relationship", label: "Relationship" },
      { key: "guarantor_address", label: "Address", full: true },
    ],
  },
  {
    title: "Payroll",
    fields: [
      { key: "bank_name", label: "Bank" },
      { key: "bank_account_number", label: "Account number" },
      { key: "bank_account_name", label: "Account name" },
    ],
  },
];

const DOC_KINDS: { key: string; label: string }[] = [
  { key: "cv", label: "CV / Résumé" },
  { key: "nin_slip", label: "NIN slip" },
  { key: "id_card", label: "ID card" },
  { key: "certificate", label: "Certificate" },
  { key: "contract", label: "Contract" },
  { key: "other", label: "Other" },
];

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function PersonnelCard({ memberId }: { memberId?: string }) {
  const base = memberId ? `/api/v1/members/${memberId}/personnel` : `/api/v1/me/personnel`;
  const keyScope = memberId ?? "me";
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const { data, isLoading } = useQuery<Bundle>({
    queryKey: ["personnel", keyScope],
    queryFn: () => api(base),
  });

  const [form, setForm] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data?.record && !dirty) setForm(data.record ?? {});
  }, [data?.record]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api(base, { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["personnel", keyScope] });
      toast.success("Saved", "Personnel record updated.");
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  const del = useMutation({
    mutationFn: (docId: string) => api(`${base}/documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["personnel", keyScope] }),
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });

  const [uploadKind, setUploadKind] = useState("cv");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", uploadKind);
      const res = await fetch(`${base}/documents`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Upload failed (${res.status})`);
      }
      qc.invalidateQueries({ queryKey: ["personnel", keyScope] });
      toast.success("Uploaded", `${file.name} attached.`);
    } catch (e: any) {
      toast.error("Upload failed", e?.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function download(doc: Doc) {
    try {
      const res = await fetch(`${base}/documents/${doc.id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error("Download failed", e?.message);
    }
  }

  if (isLoading) return <div className="text-sm text-muted">Loading personnel record…</div>;

  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  return (
    <div className="space-y-5">
      <div className="bg-accent-soft/30 border border-accent/20 rounded-xl px-4 py-2.5 text-[12.5px] text-text inline-flex items-center gap-2">
        <ShieldCheck size={14} className="text-accent shrink-0" />
        {memberId
          ? "HR view — you're editing this teammate's personnel file."
          : "This is your private personnel file. Only you and HR can see it."}
      </div>

      {FIELD_GROUPS.map((g) => (
        <section key={g.title} className="bg-surface border border-border rounded-2xl p-5">
          <h3 className="text-[11px] uppercase tracking-wider font-bold text-muted mb-3">{g.title}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {g.fields.map((f) => (
              <label key={f.key} className={`block ${f.full ? "md:col-span-2" : ""}`}>
                <div className="text-[12px] font-semibold text-text mb-1">{f.label}</div>
                <input
                  type={f.type ?? "text"}
                  value={form[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="input w-full"
                />
              </label>
            ))}
          </div>
        </section>
      ))}

      <section className="bg-surface border border-border rounded-2xl p-5">
        <h3 className="text-[11px] uppercase tracking-wider font-bold text-muted mb-3">Documents</h3>
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <label className="block">
            <div className="text-[12px] font-semibold text-text mb-1">Type</div>
            <select value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} className="input">
              {DOC_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </label>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) upload(file); }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-60"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {uploading ? "Uploading…" : "Upload document"}
          </button>
          <span className="text-[11px] text-muted">PDF, image or doc up to 25MB.</span>
        </div>

        {(data?.documents?.length ?? 0) === 0 ? (
          <div className="text-[12.5px] text-muted italic">No documents uploaded yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {data!.documents.map((d) => (
              <li key={d.id} className="py-2.5 flex items-center gap-3">
                <FileText size={15} className="text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <button onClick={() => download(d)} className="text-[13px] font-semibold text-text hover:text-accent hover:underline truncate block text-left">
                    {d.name}
                  </button>
                  <div className="text-[10.5px] text-muted">
                    {DOC_KINDS.find((k) => k.key === d.kind)?.label ?? d.kind} · {fmtSize(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={() => { if (confirm(`Delete "${d.name}"?`)) del.mutate(d.id); }}
                  className="text-muted hover:text-danger p-1.5"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="sticky bottom-3 flex justify-end">
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="inline-flex items-center gap-1.5 text-[13px] font-bold bg-accent text-white px-5 py-2.5 rounded-full shadow-card hover:bg-accent/90 disabled:opacity-50"
        >
          {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {dirty ? "Save changes" : "Saved"}
        </button>
      </div>
    </div>
  );
}
