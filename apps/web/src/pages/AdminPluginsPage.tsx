import { AdminShell } from "./admin/AdminShell";
import { PluginSubmissionsPanel } from "./PluginSubmissionsPanel";

export function AdminPluginsPage() {
  return (
    <AdminShell>
      <PluginSubmissionsPanel />
    </AdminShell>
  );
}
