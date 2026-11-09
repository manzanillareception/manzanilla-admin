import { requireEnabledAdmin } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/auth/errors";
import { createServiceClient, getSupabaseEnv } from "@/lib/supabase/server";
import { buildDeps, recoveryRouteDeps } from "@/email/service";
import { postHotelRecovery } from "@/email/routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ hotelId: string }> }): Promise<Response> {
  const env = getSupabaseEnv();
  if (!env) return errorResponse(503, "SETUP_REQUIRED", "Not configured.");
  const db = createServiceClient(env);
  const deps = buildDeps(db);
  if (!deps) return errorResponse(503, "SETUP_REQUIRED", "Email is not configured.");
  let cookies: ((r: Response) => Response) | undefined;
  const gate = async (r: Request) => {
    const a = await requireEnabledAdmin(r);
    if (a.ok) cookies = a.applyCookies;
    return a;
  };
  const { hotelId } = await ctx.params;
  try {
    const res = await postHotelRecovery(req, hotelId, recoveryRouteDeps(db, deps, gate));
    return cookies ? cookies(res) : res;
  } catch {
    return errorResponse(500, "INTERNAL", "Could not start recovery.", { retryable: true });
  }
}
