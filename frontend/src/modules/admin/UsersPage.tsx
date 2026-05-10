import { Card, Empty } from "@/components/ui";

export function AdminUsersPage() {
  return (
    <div className="space-y-6">
      <h1 className="h1">Users & roles</h1>
      <Card><Empty title="User management" body="Provision users, assign roles, and toggle MFA from this page (API ready)." /></Card>
    </div>
  );
}
