import { handleEnroll } from '../../../../../lib/api/enroll';
import { defaultDeps } from '../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleEnroll(store, request);
}
