import { handleHeartbeat } from '../../../../../lib/api/heartbeat';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleHeartbeat(store, request);
}
