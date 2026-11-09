import { handleAdminPolicy } from '../../../../../../../lib/api/admin-policy';
import { defaultDeps } from '../../../../../../../lib/server/deps';

export async function POST(request: Request, context: { params: Promise<{ deviceId: string }> }): Promise<Response> {
  const { store } = defaultDeps();
  const { deviceId } = await context.params;
  return handleAdminPolicy(store, request, deviceId);
}
