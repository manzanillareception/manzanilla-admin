import { handleAdminDashboard } from '../../../../../lib/api/admin-dashboard';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function GET(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleAdminDashboard(store, request);
}
