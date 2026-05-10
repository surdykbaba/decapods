import { Folder } from "lucide-react";
import { FileLibraryCard } from "@/modules/me/MyWorkPage";

/** Top-level Files & media page. Today this is a thin frame around the
 *  per-user file library card (every doc attached to opportunities the user
 *  created or projects they're a member of). The same component renders here
 *  and used to live inside My Accubin. The two split apart because:
 *
 *    - Files is its own first-class destination people want to bookmark.
 *    - My Accubin should focus on the personal *workflow* — tasks, updates,
 *      time, profile — not files browsing.
 *    - Tenant-wide indexing (for admins) lands as a parallel filter on this
 *      page next pass, without touching My Accubin again.
 */
export function FilesPage() {
  return (
    <div className="space-y-5 max-w-7xl">
      <header>
        <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Workspace</div>
        <h1 className="h1 mt-1 flex items-center gap-2">
          <Folder size={26} className="text-accent" /> Files &amp; media
        </h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Every document attached to an opportunity or project you have access to —
          NDAs, MSAs, scope docs, technical proposals, compliance forms, plus URL links.
          Filter by project or kind, search by name, and open straight to the source.
        </p>
      </header>

      <FileLibraryCard />
    </div>
  );
}
