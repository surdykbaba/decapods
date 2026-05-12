import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Github, ExternalLink, Copy, Check, AlertTriangle, ShieldCheck,
  Trash2, Link2, GitPullRequest, GitCommit, Plus, FolderKanban,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/lib/confirm";
import { SmartButton } from "@/components/SmartButton";

type Status = { webhook_secret_configured: boolean };
type LinkedRepo = {
  id: string;
  owner: string;
  name: string;
  installation_id: number;
  project_id: string;
  project_code: string;
  project_name: string;
  pull_requests: number;
  commits: number;
};
type ProjectLite = { id: string; code: string; name: string };

export function GitHubPage() {
  const qc = useQueryClient();

  const { data: status } = useQuery<Status>({
    queryKey: ["gh-status"],
    queryFn: () => api("/api/v1/integrations/github/status"),
    staleTime: 60_000,
  });
  const { data: repos, isLoading } = useQuery<{ items: LinkedRepo[] }>({
    queryKey: ["gh-repos"],
    queryFn: () => api("/api/v1/integrations/github/repos"),
  });
  const { data: projects } = useQuery<{ items: ProjectLite[] }>({
    queryKey: ["projects-lite-for-gh"],
    queryFn: () => api("/api/v1/projects"),
  });

  const linkedItems = repos?.items ?? [];
  const projectList = projects?.items ?? [];
  const webhookURL = `${window.location.origin}/api/v1/integrations/github/webhook`;
  const ready = !!status?.webhook_secret_configured;

  const unlink = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/integrations/github/repos/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gh-repos"] });
      toast.success("Repository unlinked");
    },
    onError: (e: any) => toast.error("Could not unlink", e?.message),
  });

  async function askThenUnlink(r: LinkedRepo) {
    const ok = await confirmAction({
      title: `Unlink ${r.owner}/${r.name}?`,
      body: "Stops attributing PRs, commits and deployments to this project. Ingest history for this repo is dropped. You can re-link later, but the historical events won't come back.",
      confirmLabel: "Unlink repository",
      danger: true,
    });
    if (ok) unlink.mutate(r.id);
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-4 flex-wrap">
        <div className="w-12 h-12 rounded-2xl bg-text text-white grid place-items-center shrink-0">
          <Github size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="h1 flex items-center gap-2">GitHub integration</h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Wire your repos so PRs, commits, and deployments flow into the project audit
            log and engineering KPIs.
          </p>
        </div>
        <span
          className={`pill text-[12px] ${
            ready
              ? "bg-success/15 text-success"
              : "bg-warn/15 text-warn"
          }`}
        >
          {ready ? <ShieldCheck size={11} /> : <AlertTriangle size={11} />}
          {ready ? "Ready" : "Needs setup"}
        </span>
      </header>

      {/* Step 1 — set up the GitHub App */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <h2 className="text-base font-bold text-text mb-3 flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent-soft text-accent text-[11px] font-bold">1</span>
          Create &amp; configure the GitHub App
        </h2>
        <ol className="text-sm text-text space-y-2.5 list-decimal pl-5 marker:text-muted">
          <li>
            On GitHub: <span className="font-semibold">Settings → Developer settings → GitHub Apps → New GitHub App</span>.
            Grant <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded">repo metadata, pull requests, contents (read)</span> and
            subscribe to <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded">push, pull_request, deployment</span> events.
          </li>
          <li>
            Use the webhook URL below. Set a strong webhook secret; we verify every payload's
            <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded mx-1">X-Hub-Signature-256</span> header against it.
          </li>
          <li>
            On the server, set env vars: <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded">GITHUB_APP_ID</span>,
            <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded ml-1">GITHUB_APP_PRIVATE_KEY_PATH</span>,
            <span className="font-mono text-[12px] bg-bg px-1.5 py-0.5 rounded ml-1">GITHUB_WEBHOOK_SECRET</span>. Restart the API.
          </li>
          <li>Install the GitHub App on your org and pick the repos you want to wire.</li>
        </ol>
      </section>

      {/* Step 2 — webhook URL */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <h2 className="text-base font-bold text-text mb-3 flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent-soft text-accent text-[11px] font-bold">2</span>
          Webhook URL
        </h2>
        <p className="text-xs text-muted mb-3">Paste this into the GitHub App's webhook field.</p>
        <CopyRow value={webhookURL} />
        {!ready && (
          <div className="mt-3 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2.5 text-sm text-warn inline-flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">Webhook secret isn't set</span> on the API yet —
              GitHub deliveries will be rejected with 401 until you configure{" "}
              <span className="font-mono text-[12.5px] bg-warn/10 px-1.5 py-0.5 rounded">GITHUB_WEBHOOK_SECRET</span>.
            </span>
          </div>
        )}
      </section>

      {/* Step 3 — link repos */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-bold text-text flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent-soft text-accent text-[11px] font-bold">3</span>
            Linked repositories
            <span className="text-[12px] font-normal text-muted">· {linkedItems.length}</span>
          </h2>
        </header>

        <LinkRepoForm projects={projectList} />

        {isLoading ? (
          <div className="px-5 py-6 text-sm text-muted">Loading repositories…</div>
        ) : linkedItems.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-bg border border-border text-muted grid place-items-center mb-3">
              <Link2 size={18} />
            </div>
            <div className="text-sm font-semibold text-text">No repositories linked yet</div>
            <div className="text-xs text-muted mt-1 max-w-md mx-auto">
              Use the form above to attach a repo to a project. Once you do, every PR, commit,
              and deployment flows into the project's activity log.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {linkedItems.map((r) => (
              <li key={r.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <a
                    href={`https://github.com/${r.owner}/${r.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-bold text-text hover:text-accent inline-flex items-center gap-1.5"
                  >
                    <Github size={13} /> {r.owner}/{r.name}
                    <ExternalLink size={11} className="opacity-50" />
                  </a>
                  <div className="text-[12px] text-muted mt-0.5 flex items-center gap-3 flex-wrap">
                    <Link to={`/projects/${r.project_id}`} className="inline-flex items-center gap-1 hover:text-accent">
                      <FolderKanban size={11} /> {r.project_code} · {r.project_name}
                    </Link>
                    <span className="inline-flex items-center gap-1">
                      <GitPullRequest size={11} /> {r.pull_requests} PRs
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <GitCommit size={11} /> {r.commits} commits
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => askThenUnlink(r)}
                  disabled={unlink.isPending}
                  className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={12} /> Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-[12.5px] font-mono bg-bg border border-border rounded-lg px-3 py-2 truncate">
        {value}
      </code>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(value); }
          catch { /* clipboard can fail in some browsers; the value is selectable */ }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg border border-border bg-surface hover:border-accent text-text"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function LinkRepoForm({ projects }: { projects: ProjectLite[] }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [repoFull, setRepoFull] = useState("");
  const [installID, setInstallID] = useState("");

  const link = useMutation({
    mutationFn: () => {
      const [owner, repo] = repoFull.split("/").map((s) => s.trim());
      if (!owner || !repo) throw new Error("Use the format owner/repo");
      return api("/api/v1/integrations/github/link", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          owner,
          repo,
          installation_id: installID ? Number(installID) : 0,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gh-repos"] });
      setProjectId("");
      setRepoFull("");
      setInstallID("");
      toast.success("Repository linked");
    },
    onError: (e: any) => toast.error("Could not link", e?.message),
  });

  const canSubmit = !!projectId && /^[\w.-]+\/[\w.-]+$/.test(repoFull.trim()) && !link.isPending;

  return (
    <div className="px-5 py-4 border-b border-border bg-bg/30">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_140px_auto] gap-2 items-end">
        <label className="block">
          <div className="label">Project</div>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="input"
          >
            <option value="">Pick a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="label">Repository</div>
          <input
            value={repoFull}
            onChange={(e) => setRepoFull(e.target.value)}
            placeholder="owner/repo"
            className="input no-cap"
          />
        </label>
        <label className="block">
          <div className="label">Install ID <span className="text-muted font-normal">(opt.)</span></div>
          <input
            value={installID}
            onChange={(e) => setInstallID(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="input no-cap"
            inputMode="numeric"
          />
        </label>
        <SmartButton
          variant="primary"
          disabled={!canSubmit}
          onClick={() => link.mutateAsync()}
          loadingLabel="Linking…"
          successLabel="Linked"
          icon={<Plus size={14} />}
        >
          Link repo
        </SmartButton>
      </div>
      <div className="text-[11px] text-muted mt-2">
        Find the installation ID on the GitHub App's <em>Installations</em> page, in the URL after
        the org name. Leaving it blank still links the repo — you just won't be able to call the
        Apps API on its behalf.
      </div>
    </div>
  );
}
