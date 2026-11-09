import { handleSessionAdmission } from '../../../../../lib/api/sessions';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleSessionAdmission(store, request);
}
