import { handlePolicyAck } from '../../../../../lib/api/policy-ack';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handlePolicyAck(store, request);
}
