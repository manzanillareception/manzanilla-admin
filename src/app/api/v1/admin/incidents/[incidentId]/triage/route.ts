import { handleAdminTriage } from '../../../../../../../lib/api/admin-triage';
import { defaultDeps } from '../../../../../../../lib/server/deps';

export async function POST(request: Request, context: { params: Promise<{ incidentId: string }> }): Promise<Response> {
  const { store } = defaultDeps();
  const { incidentId } = await context.params;
  return handleAdminTriage(store, request, incidentId);
}
