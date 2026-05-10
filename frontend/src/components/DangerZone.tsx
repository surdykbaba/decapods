import { AlertTriangle, Trash2 } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";

/**
 * Bottom-of-page red-bordered panel for irreversible actions. Caller wires up
 * its own confirm flow (via @/lib/confirm) so the wording can match the entity.
 */
export function DangerZone({
  entityLabel, name, deleting, onDelete,
}: {
  entityLabel: string;
  name: string;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <section className="border border-danger/30 bg-danger/5 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="inline-flex items-center gap-2 text-danger font-semibold text-sm">
            <AlertTriangle size={14} /> Danger zone
          </div>
          <h3 className="text-base font-bold text-text mt-2">Delete this {entityLabel}</h3>
          <p className="text-sm text-muted max-w-xl mt-1">
            Permanently removes <span className="font-semibold text-text">{name}</span> from this workspace.
            Linked documents, invitations and project assignments are detached. Audit log entries are kept.
            This action cannot be undone.
          </p>
        </div>
        <SmartButton
          variant="danger"
          icon={<Trash2 size={14} />}
          loadingLabel="Deleting…"
          disabled={deleting}
          onClick={onDelete}
        >
          Delete {entityLabel}
        </SmartButton>
      </div>
    </section>
  );
}
