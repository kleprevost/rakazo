import { Route, Routes } from "react-router-dom";
import { AdminAccessPage } from "../AdminAccessPage";
import { AdminPluginsPage } from "../AdminPluginsPage";
import { NotFoundPage } from "../NotFound";
import { AdminAuditPage } from "./AdminAuditPage";
import { AdminBotsPage } from "./AdminBotsPage";
import { AdminCapabilitiesPage } from "./AdminCapabilitiesPage";
import { AdminComputersPage } from "./AdminComputersPage";
import { AdminOverviewPage } from "./AdminOverviewPage";
import { AdminPolicyPage } from "./AdminPolicyPage";
import { AdminUsersPage } from "./AdminUsersPage";

/** Everything under `/admin`. `access` and `plugins` keep the paths they had before the section. */
export function AdminRoutes() {
  return (
    <Routes>
      <Route index element={<AdminOverviewPage />} />
      <Route path="users" element={<AdminUsersPage />} />
      <Route path="bots" element={<AdminBotsPage />} />
      <Route path="capabilities" element={<AdminCapabilitiesPage />} />
      <Route path="computers" element={<AdminComputersPage />} />
      <Route path="policy" element={<AdminPolicyPage />} />
      <Route path="audit" element={<AdminAuditPage />} />
      <Route path="access" element={<AdminAccessPage />} />
      <Route path="plugins" element={<AdminPluginsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
