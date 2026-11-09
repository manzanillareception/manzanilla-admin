import { handleEventBatch } from '../../../../../lib/api/events';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleEventBatch(store, request);
}
