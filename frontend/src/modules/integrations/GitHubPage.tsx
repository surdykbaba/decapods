import { Card } from "@/components/ui";

export function GitHubPage() {
  return (
    <div className="space-y-6">
      <h1 className="h1">GitHub integration</h1>
      <Card title="How to connect">
        <ol className="text-sm space-y-2 list-decimal pl-5 text-muted">
          <li>Create a GitHub App and install it on your organization.</li>
          <li>Configure <code className="text-text">GITHUB_APP_ID</code>, <code className="text-text">GITHUB_APP_PRIVATE_KEY_PATH</code>, and <code className="text-text">GITHUB_WEBHOOK_SECRET</code> in the API.</li>
          <li>Link a repository to a project from the project page.</li>
          <li>Webhooks flow into the audit log and feed engineering KPIs and burnout signals.</li>
        </ol>
      </Card>
    </div>
  );
}
