import { handleMintSetupToken } from '../../../../../../lib/api/admin-setup-tokens';
import { defaultDeps } from '../../../../../../lib/server/deps';

export async function POST(request: Request): Promise<Response> {
  const { store } = defaultDeps();
  return handleMintSetupToken(store, request);
}
