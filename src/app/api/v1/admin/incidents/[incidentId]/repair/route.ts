import { handleAdminRepair } from '../../../../../../../lib/api/admin-repair';
import { defaultDeps } from '../../../../../../../lib/server/deps';

export async function POST(request: Request, context: { params: Promise<{ incidentId: string }> }): Promise<Response> {
  const { store } = defaultDeps();
  const { incidentId } = await context.params;
  return handleAdminRepair(store, request, incidentId);
}
